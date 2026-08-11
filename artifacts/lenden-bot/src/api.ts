import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiConfig, Loan } from './types.ts';
import { PKG_DIR } from './config.ts';

const SESSION_FILE = path.join(PKG_DIR, '.lenden-session.json');

interface Session {
  token: string;
  mobileNumber: string;
  savedAt: string;
}

export function loadSession(mobileNumber: string): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as Session;
    return s.mobileNumber === mobileNumber && s.token ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, mobileNumber: string): void {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ token, mobileNumber, savedAt: new Date().toISOString() } satisfies Session, null, 2),
    { mode: 0o600 },
  );
}

export function clearSession(): void {
  fs.rmSync(SESSION_FILE, { force: true });
}

/** Pull the first present key out of a loosely-shaped API payload. */
function pick(obj: unknown, keys: string[]): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    if (rec[key] !== undefined && rec[key] !== null) return rec[key];
  }
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Normalize one marketplace listing into our Loan shape. LenDenClub's private API
 * is not documented, so this tries the field names commonly seen in their payloads;
 * if your captured responses use different names, add them to the candidate lists here.
 */
export function normalizeLoan(raw: unknown): Loan | null {
  const id = pick(raw, ['loan_id', 'loanId', 'id', 'listing_id', 'listingId']);
  const rate = asNumber(pick(raw, ['interest_rate', 'interestRate', 'roi', 'rate_of_interest', 'lender_roi']));
  const tenure = asNumber(pick(raw, ['tenure_months', 'tenureMonths', 'tenure', 'duration_months', 'loan_tenure']));
  const fundable = asNumber(
    pick(raw, ['remaining_amount', 'fundable_amount', 'available_amount', 'pending_amount', 'loan_amount', 'amount']),
  );
  if (id === undefined || rate === undefined || tenure === undefined || fundable === undefined) return null;
  const borrower = pick(raw, ['borrower_id', 'borrowerId', 'customer_id', 'user_id']);
  const grade = pick(raw, ['risk_grade', 'riskGrade', 'grade', 'risk_category', 'riskCategory', 'bucket']);
  const purpose = pick(raw, ['purpose', 'loan_purpose', 'category']);
  return {
    id: String(id),
    borrowerId: borrower !== undefined ? String(borrower) : String(id),
    interestRatePct: rate,
    tenureMonths: tenure,
    fundableINR: fundable,
    grade: grade !== undefined ? String(grade).toUpperCase() : 'unknown',
    purpose: purpose !== undefined ? String(purpose) : undefined,
    raw,
  };
}

/** Find the array of listings wherever the API nests it. */
function findLoanArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== 'object' || body === null) return [];
  const rec = body as Record<string, unknown>;
  for (const key of ['data', 'loans', 'results', 'listings', 'items', 'response']) {
    const v = rec[key];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object' && v !== null) {
      const nested = findLoanArray(v);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

export class LendenClient {
  private readonly cfg: ApiConfig;
  private token: string | undefined;

  constructor(cfg: ApiConfig) {
    this.cfg = cfg;
    if (!cfg.baseUrl) {
      throw new Error(
        'api.baseUrl is not set in config.json. LenDenClub has no public API — ' +
          'see the "Capturing the real API endpoints" section of the README.',
      );
    }
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<unknown> {
    const url = new URL(endpoint, this.cfg.baseUrl).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.cfg.extraHeaders,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${endpoint} failed: HTTP ${res.status} — ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async sendOtp(mobileNumber: string): Promise<void> {
    await this.request('POST', this.cfg.endpoints.sendOtp, { mobile_number: mobileNumber });
  }

  /** Exchange the OTP for a session token. Tries the token field names APIs commonly use. */
  async verifyOtp(mobileNumber: string, otp: string): Promise<string> {
    const body = await this.request('POST', this.cfg.endpoints.verifyOtp, { mobile_number: mobileNumber, otp });
    const token = pick(body, ['token', 'access_token', 'accessToken', 'auth_token', 'jwt', 'session_token'])
      ?? pick(pick(body, ['data', 'response']), ['token', 'access_token', 'accessToken', 'auth_token', 'jwt']);
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(
        `OTP verified but no token found in the response. Raw response (inspect and adjust verifyOtp()): ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
    return token;
  }

  async fetchLoans(): Promise<{ loans: Loan[]; unparsed: number }> {
    const body = await this.request('GET', this.cfg.endpoints.loans);
    const rawLoans = findLoanArray(body);
    const loans: Loan[] = [];
    let unparsed = 0;
    for (const raw of rawLoans) {
      const loan = normalizeLoan(raw);
      if (loan) loans.push(loan);
      else unparsed++;
    }
    return { loans, unparsed };
  }

  async fetchBalance(): Promise<number | null> {
    try {
      const body = await this.request('GET', this.cfg.endpoints.balance);
      const bal = pick(body, ['balance', 'wallet_balance', 'available_balance', 'amount'])
        ?? pick(pick(body, ['data', 'response']), ['balance', 'wallet_balance', 'available_balance', 'amount']);
      const n = typeof bal === 'number' ? bal : typeof bal === 'string' ? Number(bal) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null; // balance is informational; don't block the run on it
    }
  }

  async invest(loanId: string, amountINR: number): Promise<unknown> {
    return this.request('POST', this.cfg.endpoints.invest, { loan_id: loanId, amount: amountINR });
  }
}

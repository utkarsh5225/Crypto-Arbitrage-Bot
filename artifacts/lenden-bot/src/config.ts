import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotConfig } from './types.ts';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** RBI Master Direction cap: a lender's exposure to a single borrower across P2P platforms. */
export const RBI_PER_BORROWER_CAP_INR = 50_000;
/** RBI cap on a lender's aggregate exposure across all P2P platforms. */
export const RBI_TOTAL_CAP_INR = 50_00_000;

export const DEFAULT_CONFIG: BotConfig = {
  mobileNumber: '',
  budgetINR: 5000,
  live: false,
  strategy: {
    maxPerLoanINR: 500,
    maxPerBorrowerINR: 2000,
    minInterestRatePct: 12,
    maxTenureMonths: 24,
    lotSizeINR: 250,
    gradeCapsPct: { A: 100, B: 60, C: 25, D: 10, E: 0, unknown: 10 },
    assumedDefaultRatesPct: { A: 2, B: 4, C: 8, D: 14, E: 22, unknown: 12 },
  },
  api: {
    baseUrl: '',
    endpoints: {
      sendOtp: '/v2/auth/otp/send',
      verifyOtp: '/v2/auth/otp/verify',
      loans: '/v2/lending/loans',
      balance: '/v2/wallet/balance',
      invest: '/v2/lending/invest',
    },
    extraHeaders: {},
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge user config over defaults so a partial config.json is fine. */
function merge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function loadConfig(explicitPath?: string): { config: BotConfig; configPath: string } {
  const configPath = explicitPath ?? path.join(PKG_DIR, 'config.json');
  let user: unknown = {};
  if (fs.existsSync(configPath)) {
    user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = merge(DEFAULT_CONFIG, user);

  // Never let config exceed the RBI per-borrower cap.
  config.strategy.maxPerBorrowerINR = Math.min(config.strategy.maxPerBorrowerINR, RBI_PER_BORROWER_CAP_INR);
  config.strategy.maxPerLoanINR = Math.min(config.strategy.maxPerLoanINR, config.strategy.maxPerBorrowerINR);
  if (config.budgetINR > RBI_TOTAL_CAP_INR) {
    throw new Error(
      `budgetINR ${config.budgetINR} exceeds the RBI aggregate P2P lending cap of Rs. ${RBI_TOTAL_CAP_INR.toLocaleString('en-IN')}`,
    );
  }
  return { config, configPath };
}

import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, RBI_PER_BORROWER_CAP_INR } from './config.ts';
import { clearSession, LendenClient, loadSession, saveSession } from './api.ts';
import { buildPlan } from './strategy.ts';
import { demoLoans } from './demo.ts';
import { ask, closePrompt } from './prompt.ts';
import type { BotConfig, Loan, Plan } from './types.ts';

const inr = (n: number): string => `Rs. ${n.toLocaleString('en-IN')}`;

function printPlan(plan: Plan, budgetINR: number, showSkipped: boolean): void {
  if (plan.items.length === 0) {
    console.log('\nNo loans passed the filters — nothing to allocate.');
  } else {
    console.log('\nAllocation plan (ranked by expected net return):\n');
    console.log('  Loan        Grade  Rate     Tenure  Amount      Exp. net/yr');
    console.log('  ----------  -----  -------  ------  ----------  -----------');
    for (const { loan, amountINR, expectedNetPct } of plan.items) {
      console.log(
        `  ${loan.id.padEnd(10)}  ${loan.grade.padEnd(5)}  ${(loan.interestRatePct.toFixed(1) + '%').padEnd(7)}  ` +
          `${(loan.tenureMonths + 'm').padEnd(6)}  ${inr(amountINR).padEnd(10)}  ${expectedNetPct.toFixed(1)}%` +
          (loan.purpose ? `   (${loan.purpose})` : ''),
      );
    }
    console.log(
      `\n  Total: ${inr(plan.totalINR)} of ${inr(budgetINR)} budget across ${plan.items.length} loans` +
        ` | weighted gross ${plan.weightedGrossPct.toFixed(1)}%` +
        ` | expected net ~${plan.weightedNetPct.toFixed(1)}%/yr after assumed defaults`,
    );
  }
  if (plan.skipped.length > 0) {
    if (showSkipped) {
      console.log(`\nSkipped ${plan.skipped.length} loans:`);
      for (const { loan, reason } of plan.skipped) {
        console.log(`  ${loan.id} (${loan.grade}, ${loan.interestRatePct}%): ${reason}`);
      }
    } else {
      console.log(`  (${plan.skipped.length} loans skipped by filters — rerun with --show-skipped to see why)`);
    }
  }
}

async function login(client: LendenClient, config: BotConfig): Promise<void> {
  let mobile = config.mobileNumber;
  if (!mobile) mobile = await ask('Registered mobile number: ');

  const session = loadSession(mobile);
  if (session) {
    client.setToken(session.token);
    console.log(`Reusing saved session from ${session.savedAt}. (Delete .lenden-session.json to force a fresh login.)`);
    return;
  }

  console.log(`Requesting OTP for ${mobile} ...`);
  await client.sendOtp(mobile);
  const otp = await ask('Enter the OTP you received: ');
  const token = await client.verifyOtp(mobile, otp);
  client.setToken(token);
  saveSession(token, mobile);
  console.log('Logged in. Session saved locally (file is chmod 600 and gitignored).');
}

async function fetchLoansWithRelogin(client: LendenClient, config: BotConfig): Promise<{ loans: Loan[]; unparsed: number }> {
  try {
    return await client.fetchLoans();
  } catch (err) {
    // A saved session may have expired — clear it and log in once more.
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 401|HTTP 403/.test(msg)) {
      console.log('Session looks expired — logging in again.');
      clearSession();
      await login(client, config);
      return client.fetchLoans();
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const demo = argv.includes('--demo');
  const liveFlag = argv.includes('--live');
  const showSkipped = argv.includes('--show-skipped');
  const configArgIdx = argv.indexOf('--config');
  const { config, configPath } = loadConfig(configArgIdx >= 0 ? argv[configArgIdx + 1] : undefined);

  const live = !demo && (liveFlag || config.live);
  console.log(`LenDenClub auto-lender | config: ${configPath} | mode: ${demo ? 'DEMO' : live ? 'LIVE' : 'DRY RUN'}`);
  console.log(
    `Budget ${inr(config.budgetINR)} | per loan <= ${inr(config.strategy.maxPerLoanINR)} | ` +
      `per borrower <= ${inr(Math.min(config.strategy.maxPerBorrowerINR, RBI_PER_BORROWER_CAP_INR))} | ` +
      `min rate ${config.strategy.minInterestRatePct}% | max tenure ${config.strategy.maxTenureMonths}m`,
  );

  let loans: Loan[];
  let client: LendenClient | null = null;

  if (demo) {
    loans = demoLoans();
    console.log(`\nDemo mode: using ${loans.length} synthetic loans (no login, no network).`);
  } else {
    client = new LendenClient(config.api);
    await login(client, config);

    const balance = await client.fetchBalance();
    if (balance !== null) {
      console.log(`Wallet balance: ${inr(balance)}`);
      if (balance < config.budgetINR) {
        console.log(`Note: balance is below the configured budget — planning with ${inr(balance)} instead.`);
        config.budgetINR = balance;
      }
    }

    const result = await fetchLoansWithRelogin(client, config);
    loans = result.loans;
    console.log(`\nFetched ${loans.length} fundable loans.`);
    if (result.unparsed > 0) {
      console.log(
        `Warning: ${result.unparsed} listings could not be parsed — the field mapping in normalizeLoan() ` +
          `probably needs adjusting for the real payload (see README).`,
      );
    }
  }

  const plan = buildPlan(loans, config.budgetINR, config.strategy);
  printPlan(plan, config.budgetINR, showSkipped);

  if (plan.items.length === 0) return;

  if (!live || !client) {
    console.log('\nDry run — no money was moved. Run with --live (or set "live": true in config.json) to invest for real.');
    return;
  }

  console.log(`\nLIVE MODE: about to lend ${inr(plan.totalINR)} of real money across ${plan.items.length} loans.`);
  const confirm = await ask('Type INVEST to proceed (anything else aborts): ');
  if (confirm !== 'INVEST') {
    console.log('Aborted — no money was moved.');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const { loan, amountINR } of plan.items) {
    try {
      await client.invest(loan.id, amountINR);
      ok++;
      console.log(`  ✓ ${loan.id}: lent ${inr(amountINR)}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${loan.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(1500); // be gentle with their API; also gives you time to Ctrl+C
  }
  console.log(`\nDone: ${ok} orders placed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Verify the failed ones in the LenDenClub app before retrying — some may have partially gone through.');
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closePrompt());

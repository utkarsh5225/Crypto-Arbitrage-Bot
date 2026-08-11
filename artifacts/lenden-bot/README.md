# LenDenClub auto-lender

Interactive CLI that logs into your LenDenClub account (mobile number + OTP), fetches
the manual-lending loan marketplace, and allocates your budget across loans to maximise
expected **net** return (gross rate minus an assumed default rate per risk grade) under
diversification caps.

**Dry-run is the default.** It never places an order unless you run with `--live`
(or set `"live": true`) **and** type `INVEST` at the confirmation prompt.

## Quick start

```bash
# Try the strategy engine on synthetic loans — no login, no network:
pnpm --filter @workspace/lenden-bot run demo

# Real run (dry run — plans but doesn't invest):
cp artifacts/lenden-bot/config.example.json artifacts/lenden-bot/config.json
# edit config.json (mobile number, budget, api.baseUrl — see below)
pnpm --filter @workspace/lenden-bot run start

# Actually invest:
pnpm --filter @workspace/lenden-bot run start -- --live
```

Flags: `--demo` (synthetic loans), `--live` (real orders after confirmation),
`--show-skipped` (explain every filtered-out loan), `--config <path>`.

On login the bot requests an OTP to your registered mobile, prompts you for it in the
terminal, and saves the resulting session token to `.lenden-session.json` (chmod 600,
gitignored) so subsequent runs skip the OTP until the token expires.

## Capturing the real API endpoints (required, ~5 minutes)

LenDenClub has **no public API**, so this bot talks to the same private endpoints their
own web app uses — and you have to capture those once, because they aren't documented
and can change:

1. Open the LenDenClub investor web app in Chrome and open DevTools → **Network** tab
   (filter: Fetch/XHR).
2. Log in normally. Note the requests fired when you submit your mobile number and when
   you submit the OTP — copy their **host** into `api.baseUrl` and their **paths** into
   `api.endpoints.sendOtp` / `verifyOtp`.
3. Browse the manual-lending loan list and note the request that returns the loans →
   `api.endpoints.loans`. Same for wallet balance → `balance`.
4. Lend a minimal amount (Rs. 250) into one loan and capture that request →
   `api.endpoints.invest`.
5. If requests carry extra required headers (device id, app version, an api key the web
   app sends), put them in `api.extraHeaders`.

Field names in responses vary; if the bot warns that listings "could not be parsed",
open `src/api.ts` → `normalizeLoan()` and add the field names you see in the captured
response to the candidate lists. Request body shapes for OTP/invest live in
`src/api.ts` too (`sendOtp`, `verifyOtp`, `invest`) — adjust them if your captures
differ.

## Strategy

Per loan: expected net return = gross rate − assumed annual default rate for its grade
(configurable in `assumedDefaultRatesPct` — tune these to LenDenClub's published NPA
numbers for your cohort). Loans failing `minInterestRatePct` / `maxTenureMonths` are
skipped. Allocation is greedy by expected net return, constrained by:

- `maxPerLoanINR` — spreads the budget across many loans (diversification does most of
  the risk-reduction work in P2P; small slices of many loans beat big bets on few).
- `maxPerBorrowerINR` — hard-clamped to the RBI cap of Rs. 50,000 per borrower.
- `gradeCapsPct` — e.g. at most 10% of the budget in grade D, none in E.
- `lotSizeINR` — orders in multiples of the platform lot (Rs. 250 by default).
- Budget is also clamped to your live wallet balance and to the RBI aggregate cap
  (Rs. 50 lakh across all P2P platforms).

## Warnings — read once, seriously

- **P2P lending can lose principal.** High rates exist because defaults are real; the
  "expected net" figure is only as good as the default assumptions you configure.
- **This automates your own account via LenDenClub's private API**, which their terms
  of service likely don't bless. They may throttle, break, or suspend accounts doing
  automated activity. Keep budgets small and the 1.5s inter-order delay in place.
- **Never commit `config.json` or `.lenden-session.json`** (both are gitignored) — the
  session token is equivalent to being logged into your account.
- The OTP stays with you: the bot only asks you to type it at runtime, never stores it.

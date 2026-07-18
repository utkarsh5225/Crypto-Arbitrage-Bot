# Deploying the Crypto Arbitrage Bot on a Hostinger VPS (personal use)

This guide runs the bot as a **single Node process** that serves both the API
and the dashboard on one port, bound to **localhost only**, and reached from any
device over an **SSH tunnel**. There is no database and nothing is exposed to
the public internet.

> ⚠️ **This bot places real market orders.** The dashboard has no login. That is
> exactly why it binds to `127.0.0.1` and you reach it through SSH — never open
> its port to the internet without putting authentication + HTTPS in front of it.

---

## Quickstart (automated)

If you'd rather not run the steps by hand, the whole server-side setup is one
idempotent script. SSH into a fresh Ubuntu VPS as root and run:

```bash
curl -fsSL https://raw.githubusercontent.com/utkarsh5225/Crypto-Arbitrage-Bot/claude/binance-live-trading-api-59vybf/deploy/setup.sh | bash
```

It installs Node/pnpm, creates the `arbbot` user, clones + builds, generates the
encryption key, and starts the systemd service. When it finishes it prints your
VPS IP and the exact SSH-tunnel command. You then only need to: whitelist the IP
in Binance, enter your API keys, and open the tunnel (§8–§10 below).

The manual steps below explain each part and are the reference if anything fails.

---

## 0. Architecture at a glance

- **One process**: the Express server (`@workspace/api-server`) serves the built
  React dashboard as static files and handles `/api/*` on the same origin.
- **No database**: state persists to local files under
  `artifacts/api-server/` — `data/store.json` (trade history) and
  `.binance-credentials.json` + `.credentials-key` (encrypted API keys).
- **Bound to `127.0.0.1`**: access is via `ssh -L`, so there's zero public
  attack surface.

---

## 1. Pick the right VPS

- **OS**: Ubuntu 22.04 or 24.04 LTS (this guide assumes it).
- **Size**: the smallest Hostinger KVM plan is plenty (1 vCPU / 4 GB).
- **Region — important**: Binance geoblocks some countries. If `api.binance.com`
  returns HTTP `451`/`403` from your VPS, the region is blocked. Choose a VPS
  location where Binance Spot is accessible, and confirm with the check in §7.

---

## 2. First login & a non-root user

SSH in as root (Hostinger gives you the IP + password), then create a dedicated
service user so the bot never runs as root:

```bash
adduser --system --group --home /opt/crypto-arb-bot arbbot
```

Install the basics:

```bash
apt update && apt -y upgrade
apt -y install git curl ca-certificates
```

---

## 3. Install Node.js 24 and pnpm

```bash
# Node 24 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node --version   # should print v24.x

# pnpm via corepack (bundled with Node)
corepack enable
corepack prepare pnpm@10 --activate
pnpm --version
```

---

## 4. Clone and build

```bash
# Clone into the service user's home
git clone https://github.com/utkarsh5225/Crypto-Arbitrage-Bot.git /opt/crypto-arb-bot
cd /opt/crypto-arb-bot

# Use the branch with live trading (or `main` once it's merged)
git checkout claude/binance-live-trading-api-59vybf

# Install all workspace dependencies
pnpm install

# Build the dashboard (both env vars are required by its Vite config)
PORT=5000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/arb-dashboard build

# Build the server bundle
pnpm --filter @workspace/api-server run build

# Hand ownership to the service user
chown -R arbbot:arbbot /opt/crypto-arb-bot
```

---

## 5. Configure environment & secrets

```bash
# Start from the template
cp /opt/crypto-arb-bot/deploy/crypto-arb-bot.env.example /etc/crypto-arb-bot.env

# Generate the at-rest encryption key and paste it into the file
openssl rand -hex 32

# Edit the file: set CREDENTIALS_ENCRYPTION_KEY (and optionally BINANCE_API_*)
nano /etc/crypto-arb-bot.env

# Lock it down
chown arbbot:arbbot /etc/crypto-arb-bot.env
chmod 600 /etc/crypto-arb-bot.env
```

Keep `HOST=127.0.0.1`. Providing `BINANCE_API_KEY`/`BINANCE_API_SECRET` here is
the most secure option (never written to disk); otherwise you'll enter them in
the dashboard later.

---

## 6. Install and start the systemd service

```bash
cp /opt/crypto-arb-bot/deploy/crypto-arb-bot.service /etc/systemd/system/
# If `which node` is not /usr/bin/node, edit ExecStart accordingly.
systemctl daemon-reload
systemctl enable --now crypto-arb-bot

# Verify
systemctl status crypto-arb-bot
journalctl -u crypto-arb-bot -f     # live logs; Ctrl-C to stop tailing
```

You should see `Server listening` on `127.0.0.1:5000` and `Serving dashboard
from static build`.

---

## 7. Verify Binance connectivity from the VPS

```bash
# Your VPS's public IP (whitelist THIS in Binance):
curl -s https://api.ipify.org; echo

# Binance reachable? Expect HTTP 200. 451/403 means the region is geoblocked.
curl -s -o /dev/null -w "%{http_code}\n" https://api.binance.com/api/v3/time
```

The bot logs `Exchange info loaded` and `WS shard connected` once it's talking to
Binance.

---

## 8. Access the dashboard over an SSH tunnel

The dashboard is only on the VPS's localhost. Forward it to your device:

**Computers (Mac / Windows / Linux):**

```bash
ssh -L 5000:localhost:5000 arbbot@YOUR_VPS_IP
# (or your normal login user; arbbot is a --system user without a shell,
#  so use the account you SSH in with and forward the port)
```

Then open <http://localhost:5000> in any browser. Keep the SSH session open
while you use it.

> Tip: `arbbot` is a system account. Just SSH in with the user you already use
> (e.g. `root` or your own sudo user) and add `-L 5000:localhost:5000` — the
> tunnel forwards to the VPS's loopback where the bot listens.

**Phones / tablets:**

Use an SSH client that supports port forwarding — **Termius** (iOS/Android) or
**Blink** (iOS):

1. Add your VPS host + credentials.
2. Add a **local port forward**: local `5000` → destination `localhost:5000`.
3. Connect, then open <http://localhost:5000> in the phone browser.

---

## 9. Binance API key setup

1. Binance → **API Management** → create an API key.
2. Enable **Enable Spot & Margin Trading**.
3. Under **Restrict access to trusted IPs**, add your **VPS public IP** (from
   §7). This is required for trading-enabled keys.
4. Enter the key/secret in the dashboard (**Binance API Credentials** →
   *Save & Validate*), or set them in `/etc/crypto-arb-bot.env` and restart.

---

## 10. Go-live checklist (do this in order)

The dashboard defaults to **Paper** mode. Work up carefully:

1. **Paper** — let it run; confirm opportunities and paper trades appear.
2. **Testnet** — flip the *Network* toggle to **Testnet**, create keys at
   <https://testnet.binance.vision>, save them, then enable Live. This exercises
   real order placement with fake funds. (Testnet P&L is not meaningful — its
   order books are thin; you're validating plumbing.)
3. **Production, small** — switch Network back to **Production**, save your real
   keys, and set conservative limits in **Configuration**:
   - `Max Notional Per Trade` small (e.g. 20–50 USDT)
   - `Daily Loss Limit` low (e.g. 5–10 USDT)
   - `Min Profit Threshold` above 3× your fee rate
4. Enable **Live** and watch the first trades. The **Kill Switch** reverts to
   Paper instantly. The bot also auto-reverts on the daily loss limit or after
   3 consecutive failed trades.

---

## 11. Updating the bot

```bash
cd /opt/crypto-arb-bot
git pull
pnpm install
PORT=5000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/arb-dashboard build
pnpm --filter @workspace/api-server run build
chown -R arbbot:arbbot /opt/crypto-arb-bot
systemctl restart crypto-arb-bot
```

Your trade history and credentials survive updates (they're in
`artifacts/api-server/data/` and the credential files, not in git).

---

## 12. Backups

Back up these (they're git-ignored, live only on the VPS):

- `artifacts/api-server/data/store.json` — trade & P&L history
- `artifacts/api-server/.binance-credentials.json` + `.credentials-key` —
  encrypted keys **and** the key that decrypts them (back up together or
  neither)

```bash
tar czf ~/arb-backup-$(date +%F).tgz \
  -C /opt/crypto-arb-bot/artifacts/api-server data .binance-credentials.json .credentials-key
```

---

## 13. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Failed to load exchange info` / HTTP `451`/`403` | VPS region is Binance-geoblocked (§1) — use a different region. |
| Binance error `-1021` timestamp | Clock drift. The client auto-syncs to Binance time; also run `timedatectl set-ntp true`. |
| Binance error `-2015` / invalid key | API key not IP-whitelisted (§9) or Spot Trading not enabled. |
| Credentials rejected in Testnet | Testnet needs **separate** keys from testnet.binance.vision. |
| Dashboard loads but no data | Check `journalctl -u crypto-arb-bot` for WS/exchange-info errors. |
| `Dashboard build not found` in logs | Re-run the dashboard build (§4) or set `PUBLIC_DIR`. |
| Can't reach localhost:5000 in browser | The SSH tunnel isn't active, or you forwarded the wrong port. |

---

## 14. Security notes

- Keep `HOST=127.0.0.1`. The only way in is your SSH tunnel.
- `chmod 600 /etc/crypto-arb-bot.env`; it holds the encryption key (and possibly
  API secrets).
- Prefer Binance keys **without withdrawal permission** — spot trading only.
- Use the IP allowlist on the Binance key so a leaked key is far less useful.
- Consider SSH key-only login and a firewall (`ufw allow OpenSSH && ufw enable`)
  that exposes **only** port 22.

#!/usr/bin/env bash
#
# One-shot server-side bootstrap for the Crypto Arbitrage Bot.
# Run as root on a fresh Ubuntu 22.04/24.04 Hostinger VPS:
#
#   ssh root@YOUR_VPS_IP
#   curl -fsSL https://raw.githubusercontent.com/utkarsh5225/Crypto-Arbitrage-Bot/claude/binance-live-trading-api-59vybf/deploy/setup.sh | bash
#
# Idempotent: safe to re-run to update. It never overwrites your env file
# (secrets) once created. See DEPLOYMENT.md for the full walkthrough.

set -euo pipefail

# --- Config (override via env, e.g. `PORT=8080 bash setup.sh`) --------------
REPO_URL="${REPO_URL:-https://github.com/utkarsh5225/Crypto-Arbitrage-Bot.git}"
BRANCH="${BRANCH:-claude/binance-live-trading-api-59vybf}"
APP_DIR="${APP_DIR:-/opt/crypto-arb-bot}"
APP_USER="${APP_USER:-arbbot}"
PORT="${PORT:-5000}"
ENV_FILE="${ENV_FILE:-/etc/crypto-arb-bot.env}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# --- 1. Base packages -------------------------------------------------------
log "Installing base packages"
apt-get update -y
apt-get install -y git curl ca-certificates openssl

# --- 2. Node.js 24 ----------------------------------------------------------
NODE_MAJOR="$(command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0)"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  log "Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
else
  log "Node $(node --version) already present — skipping"
fi

# --- 3. pnpm via corepack ---------------------------------------------------
log "Enabling pnpm"
corepack enable
corepack prepare pnpm@10 --activate

# --- 4. Service user --------------------------------------------------------
if ! id "${APP_USER}" >/dev/null 2>&1; then
  log "Creating service user ${APP_USER}"
  adduser --system --group --home "${APP_DIR}" "${APP_USER}"
else
  log "User ${APP_USER} already exists — skipping"
fi

# --- 5. Clone or update the repo -------------------------------------------
if [[ -d "${APP_DIR}/.git" ]]; then
  log "Updating existing checkout in ${APP_DIR}"
  git -C "${APP_DIR}" fetch origin "${BRANCH}"
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" pull origin "${BRANCH}"
else
  log "Cloning ${REPO_URL} into ${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
  git -C "${APP_DIR}" checkout "${BRANCH}"
fi

cd "${APP_DIR}"

# --- 6. Install & build -----------------------------------------------------
log "Installing dependencies (this can take a few minutes)"
pnpm install

log "Building dashboard"
PORT="${PORT}" BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/arb-dashboard build

log "Building server"
pnpm --filter @workspace/api-server run build

# --- 7. Environment file (created once, never overwritten) ------------------
if [[ ! -f "${ENV_FILE}" ]]; then
  log "Creating ${ENV_FILE} with a generated encryption key"
  ENC_KEY="$(openssl rand -hex 32)"
  cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=127.0.0.1
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_DIR=${APP_DIR}/artifacts/arb-dashboard/dist/public
CREDENTIALS_ENCRYPTION_KEY=${ENC_KEY}
# Optional — supply Binance keys here (never written to disk) instead of the UI:
# BINANCE_API_KEY=
# BINANCE_API_SECRET=
EOF
  chown "${APP_USER}:${APP_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
else
  log "${ENV_FILE} already exists — leaving your secrets untouched"
fi

# --- 8. Ownership & systemd -------------------------------------------------
log "Setting ownership"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

log "Installing systemd service"
install -m 644 "${APP_DIR}/deploy/crypto-arb-bot.service" /etc/systemd/system/crypto-arb-bot.service
systemctl daemon-reload
systemctl enable crypto-arb-bot
systemctl restart crypto-arb-bot

sleep 2
systemctl --no-pager --full status crypto-arb-bot || true

# --- Done -------------------------------------------------------------------
VPS_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo YOUR_VPS_IP)"
cat <<EOF

============================================================================
 Setup complete. The bot is running on 127.0.0.1:${PORT} (localhost only).

 Next steps:
   1. Whitelist this VPS IP in your Binance API key:  ${VPS_IP}
   2. From your PC, open an SSH tunnel:
        ssh -L ${PORT}:localhost:${PORT} root@${VPS_IP}
      then browse to  http://localhost:${PORT}
   3. Enter your Binance keys in the dashboard (or add them to ${ENV_FILE}
      and: systemctl restart crypto-arb-bot).
   4. Stay in Paper mode first, then Testnet, then small Live limits.

 Logs:     journalctl -u crypto-arb-bot -f
 Restart:  systemctl restart crypto-arb-bot
 Full guide: ${APP_DIR}/DEPLOYMENT.md
============================================================================
EOF

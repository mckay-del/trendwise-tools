#!/usr/bin/env bash
# Trendwise Ledger — one-time server setup for a fresh Ubuntu 24.04 server (e.g. a DigitalOcean Droplet).
#
# Run as root (the DigitalOcean web Console logs you in as root):
#   curl -fsSL https://raw.githubusercontent.com/mckay-del/trendwise-tools/main/apps/ledger/deploy/setup-server.sh | bash
#
# What it does:
#   1. Updates the system and installs Node.js
#   2. Downloads the app to /opt/trendwise-ledger (books live in /var/lib/trendwise-ledger)
#   3. Runs the ledger as a locked-down background service that restarts automatically
#   4. Nightly encrypted backups (kept 30 days) with a passphrase it generates for you
#   5. Automatic security updates
#   6. Firewall: nothing reachable from the internet except SSH (for the DigitalOcean console)
#   7. Tailscale, so only your own devices can open the ledger, at an https://….ts.net address
# Safe to run again: it updates what's there instead of starting over.
set -euo pipefail

REPO_HTTPS="https://github.com/mckay-del/trendwise-tools.git"
REPO_SSH="git@github.com:mckay-del/trendwise-tools.git"
BRANCH="${LEDGER_BRANCH:-main}"
APP_DIR=/opt/trendwise-ledger
DATA_DIR=/var/lib/trendwise-ledger
ETC_DIR=/etc/trendwise-ledger
SVC_USER=ledger
PORT=3000

step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note()  { printf '\033[0;37m    %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()   { printf '\n\033[1;31mSetup stopped: %s\033[0m\n' "$*" >&2; exit 1; }
pause() { read -r -p "$1" _ </dev/tty; }
trap 'die "a command failed on line $LINENO. Copy the messages above and send them to whoever is helping you."' ERR

[ "$(id -u)" -eq 0 ] || die "please run this as root (the DigitalOcean console logs you in as root)."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "This script is written for Ubuntu 24.04; you are on ${PRETTY_NAME:-unknown}. Continuing anyway."
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

# ---------------------------------------------------------------------------
step "1/7  Updating the system (a few minutes)"
apt-get update -y -qq
apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -qq curl git ufw unattended-upgrades ca-certificates gnupg openssl >/dev/null

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  note "Installing Node.js 24 LTS"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js 22.13 or newer could not be installed."
NODE_BIN="$(command -v node)"
note "Node.js $(node -v)"

# ---------------------------------------------------------------------------
step "2/7  Downloading Trendwise Ledger"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 700 -o root -g root "$ETC_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH"
elif GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_HTTPS" >/dev/null 2>&1; then
  git clone --quiet --branch "$BRANCH" "$REPO_HTTPS" "$APP_DIR"
else
  # Private repository: give this server its own read-only "deploy key".
  install -d -m 700 /root/.ssh
  [ -f /root/.ssh/trendwise_deploy ] || ssh-keygen -q -t ed25519 -N "" -C "trendwise-ledger-server" -f /root/.ssh/trendwise_deploy
  ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
  grep -q "trendwise_deploy" /root/.ssh/config 2>/dev/null || printf 'Host github.com\n  IdentityFile /root/.ssh/trendwise_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
  until git ls-remote "$REPO_SSH" >/dev/null 2>&1; do
    echo
    warn "The repository is private, so this server needs read-only permission to download it."
    echo "  1. On your computer, open: https://github.com/mckay-del/trendwise-tools/settings/keys/new"
    echo "  2. Title: Trendwise Ledger server"
    echo "  3. Key: copy the whole line below (starts with ssh-ed25519)"
    echo "  4. Leave \"Allow write access\" UNCHECKED, then click Add key"
    echo
    cat /root/.ssh/trendwise_deploy.pub
    echo
    pause "Press Enter after adding the key... "
  done
  git clone --quiet --branch "$BRANCH" "$REPO_SSH" "$APP_DIR"
fi
chown -R root:root "$APP_DIR"
LEDGER_DIR="$APP_DIR/apps/ledger"
VERSION="$(node -p "require('$LEDGER_DIR/package.json').version")"
note "Version $VERSION"

# ---------------------------------------------------------------------------
step "3/7  Setting up the ledger service"
cat > "$ETC_DIR/ledger.env" <<EOF
LEDGER_DATA_DIR=$DATA_DIR
PORT=$PORT
HOST=127.0.0.1
NODE_ENV=production
EOF
chmod 600 "$ETC_DIR/ledger.env"

cat > /etc/systemd/system/trendwise-ledger.service <<EOF
[Unit]
Description=Trendwise Ledger
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ETC_DIR/ledger.env
WorkingDirectory=$LEDGER_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
# Lock the service down: it can only write to the books folder.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$DATA_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet trendwise-ledger
systemctl restart trendwise-ledger
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1 || { journalctl -u trendwise-ledger -n 30 --no-pager; die "the ledger service didn't start (see messages above)."; }
note "Ledger is running (only reachable from inside this server for now)."

# ---------------------------------------------------------------------------
step "4/7  Nightly encrypted backups"
if [ ! -f "$ETC_DIR/backup.env" ]; then
  PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 | sed 's/.\{6\}/&-/g; s/-$//')"
  printf 'LEDGER_DATA_DIR=%s\nLEDGER_BACKUP_PASSPHRASE=%s\n' "$DATA_DIR" "$PASS" > "$ETC_DIR/backup.env"
  chmod 600 "$ETC_DIR/backup.env"
  echo
  warn "  Server backup passphrase:   $PASS"
  echo "  Save this in your password manager now (label: \"Trendwise Ledger server backups\")."
  echo "  You need it to open the nightly backups this server makes. It cannot be recovered."
  pause "  Press Enter once you've saved it... "
else
  note "Keeping the existing backup passphrase."
fi
cat > /etc/systemd/system/trendwise-ledger-backup.service <<EOF
[Unit]
Description=Trendwise Ledger encrypted backup

[Service]
Type=oneshot
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ETC_DIR/backup.env
WorkingDirectory=$LEDGER_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server/backup-cli.js backup --out $DATA_DIR/backups
ExecStartPost=/usr/bin/find $DATA_DIR/backups -name '*.twlbak' -mtime +30 -delete
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA_DIR
UMask=0077
EOF
cat > /etc/systemd/system/trendwise-ledger-backup.timer <<EOF
[Unit]
Description=Nightly Trendwise Ledger backup

[Timer]
# 10:00 UTC = 2-3 AM Pacific
OnCalendar=*-*-* 10:00:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --quiet --now trendwise-ledger-backup.timer
systemctl start trendwise-ledger-backup.service
ls "$DATA_DIR/backups"/*.twlbak >/dev/null 2>&1 || die "the test backup didn't work."
note "Test backup OK. Backups are kept for 30 days in $DATA_DIR/backups."

# ---------------------------------------------------------------------------
step "5/7  Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52trendwise-ledger <<'EOF'
// Reboot when an update requires it, at 11:00 UTC (3-4 AM Pacific). The ledger starts again automatically.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "11:00";
EOF
systemctl enable --quiet --now unattended-upgrades
note "On."

# ---------------------------------------------------------------------------
step "6/7  Firewall"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit 22/tcp comment 'SSH (DigitalOcean console)' >/dev/null
ufw allow in on tailscale0 comment 'Tailscale (your devices only)' >/dev/null
ufw --force enable >/dev/null
note "Internet access blocked except SSH; the ledger is only reachable through Tailscale."

# ---------------------------------------------------------------------------
step "7/7  Private access with Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
if ! tailscale status >/dev/null 2>&1; then
  echo
  warn "  Sign this server in to YOUR Tailscale account:"
  echo "  A link will appear below (https://login.tailscale.com/a/...)."
  echo "  Open it on your computer, sign in with the same account as your other computers, and approve."
  echo
  tailscale up --hostname=trendwise-ledger
fi
note "Turning on private https access (if a link appears, open it on your computer and approve)."
until tailscale serve --bg "$PORT"; do
  echo
  warn "  Tailscale needs HTTPS turned on for your account (one time)."
  echo "  On your computer open https://login.tailscale.com/admin/dns"
  echo "  - make sure MagicDNS is enabled"
  echo "  - under HTTPS Certificates click Enable HTTPS"
  echo "  (If Tailscale printed its own link above, opening that and approving works too.)"
  pause "  Press Enter to try again... "
done
TS_NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
URL="https://$TS_NAME"

# Handy commands for later
cat > /usr/local/bin/ledger-update <<EOF
#!/usr/bin/env bash
# Update Trendwise Ledger to the latest version (takes a backup first).
set -euo pipefail
systemctl start trendwise-ledger-backup.service
git -C $APP_DIR pull --ff-only
systemctl restart trendwise-ledger
sleep 2
echo "Trendwise Ledger updated to version \$(node -p "require('$LEDGER_DIR/package.json').version")."
systemctl is-active --quiet trendwise-ledger && echo "Service is running." || { echo "Service did not start:"; journalctl -u trendwise-ledger -n 30 --no-pager; exit 1; }
EOF
cat > /usr/local/bin/ledger-status <<EOF
#!/usr/bin/env bash
echo "Address:   $URL"
echo "Version:   \$(node -p "require('$LEDGER_DIR/package.json').version")"
echo "Service:   \$(systemctl is-active trendwise-ledger)"
echo "Backups:   \$(ls $DATA_DIR/backups/*.twlbak 2>/dev/null | wc -l) kept, newest: \$(ls -t $DATA_DIR/backups/*.twlbak 2>/dev/null | head -1)"
echo "Next backup: \$(systemctl list-timers trendwise-ledger-backup.timer --no-pager | sed -n 2p | awk '{print \$1, \$2, \$3, \$4}')"
EOF
chmod 755 /usr/local/bin/ledger-update /usr/local/bin/ledger-status

# ---------------------------------------------------------------------------
echo
printf '\033[1;32m%s\033[0m\n' "======================================================================"
printf '\033[1;32m  Trendwise Ledger is set up.\033[0m\n'
printf '\033[1;32m%s\033[0m\n' "======================================================================"
echo
echo "  Open this on any of your computers (Tailscale must be on there):"
echo
printf '      \033[1m%s\033[0m\n' "$URL"
echo
echo "  First time: choose \"Moving your books from another computer? Restore a backup instead\""
echo "  and upload the encrypted backup from your current app (Settings -> Backup)."
echo
echo "  Later, in this console:   ledger-status   (health check)"
echo "                            ledger-update   (install the newest version)"
echo

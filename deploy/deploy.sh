#!/usr/bin/env bash
# Empire deploy script — run on the server for one environment.
#
# sudo bash deploy.sh staging          (deploys origin/codex/empire-mvp HEAD)
# EMPIRE_REF=codex/deploy-playempire sudo -E bash deploy.sh production
#
# Responsibilities: fetch pinned ref, build, atomically swap, restart the right
# systemd unit, healthcheck, report; never print or require secrets.
set -euo pipefail

INSTANCE="${1:?usage: deploy.sh <staging|production>}"
case "$INSTANCE" in
  staging)    PORT=8892; ENV_URL=https://staging.playempire.uk ;;
  production) PORT=8891; ENV_URL=https://playempire.uk ;;
  *) echo "unknown environment: $INSTANCE (staging|production)" >&2; exit 2 ;;
esac
BASE=/srv/empire
APP=$BASE/app
REF="${EMPIRE_REF:-$(git -C "$BASE/repo" rev-parse origin/codex/empire-mvp)}"

echo "[deploy] instance=$INSTANCE ref=$REF"

# 1. Fetch the pinned commit and build it in a release directory (all git/npm
#    steps run as the unprivileged app user; nothing writes as root)
sudo -u empire git -C "$BASE/repo" fetch origin "$REF"
sudo -u empire git -C "$BASE/repo" checkout --detach "$REF"
SHORT=$(git -C "$BASE/repo" rev-parse --short "$REF")
RELEASE=$BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)-$SHORT
sudo -u empire mkdir -p "$RELEASE"
sudo -u empire git -C "$BASE/repo" archive "$REF" | sudo -u empire tar -x -C "$RELEASE"
cd "$RELEASE"
sudo -u empire npm ci --no-fund --no-audit
echo "-- checks --"
sudo -u empire npx vitest run
sudo -u empire npx tsc --noEmit -p tsconfig.json
sudo -u empire npx tsc --noEmit -p web/tsconfig.json
sudo -u empire npx eslint server/src server/test web/src scripts
sudo -u empire npm run build

# 2. Atomically swap the live checkout (previous release stays for rollback)
ln -sfn "$RELEASE" "$APP.new" && sudo mv -T "$APP.new" "$APP"

# 3. Restart the matching unit (migrations run once at boot via server boot)
systemctl restart "empire@$INSTANCE"

# 4. Healthcheck against the local port (never printed with values)
for i in $(seq 1 30); do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    echo "[deploy] healthy after ${i}s: $ENV_URL"
    echo "[deploy] running commit: $(git -C "$RELEASE" rev-parse HEAD)"
    exit 0
  fi
done
echo "[deploy] FAILED healthcheck — unit follows; see journalctl -u empire-$INSTANCE" >&2
exit 1

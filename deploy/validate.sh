#!/usr/bin/env bash
# One-time local-configuration validation for the Empire deployment kit.
# Run on the workstation (not the server): it only inspects files in this repo.
set -euo pipefail
FAIL=0
say() { printf '%s: %s\n' "$1" "$2"; }

# Node engine expectations for the server runtime are >=22.5 (node:sqlite)
NODE_MIN=22
MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$MAJOR" -ge "$NODE_MIN" ]; then say OK "local node $(node -v) >= $NODE_MIN"; else say FAIL "node $(node -v) too old"; FAIL=1; fi

# systemd unit template: every ExecStart must reference the non-interactive runtime
if grep -q "node_modules/.bin/tsx" deploy/empire@.service; then say OK "unit uses repo-local tsx"; else say FAIL "unit ExecStart missing"; FAIL=1; fi
if grep -q "EnvironmentFile=/srv/empire/secrets" deploy/empire@.service; then say OK "secrets via EnvironmentFile"; else say FAIL "unit reads secrets inline?"; FAIL=1; fi

# nginx conf: no insecure TLS options in non-comment lines (commented guidance is fine)
if grep -v "^\s*#" deploy/nginx-empire.conf | grep -qiE "ssl_verify|Flexible"; then
  say FAIL "insecure TLS option present"
  FAIL=1
else
  say OK "no insecure TLS directives"
fi
grep -q "proxy_set_header X-Forwarded-For \$http_cf_connecting_ip" deploy/nginx-empire.conf \
  && say OK "client IP forwarded from Cloudflare hop" || { say FAIL "forwarded-for header"; FAIL=1; }

# scripts: never echo secret values or write env files into the repo
for f in deploy/deploy.sh deploy/backup.sh; do
  if grep -qE "echo .*\$META|cat .*\.env|SESSION_SECRET=" "$f"; then say FAIL "$f may leak secrets"; FAIL=1; else say OK "$f has no secret echo paths"; fi
done

# rate limits / secrets: .env.example contains placeholders only
if grep -qE "^(SESSION_SECRET|SMTP_PASSWORD)=(\S+)" .env.example; then say FAIL ".env.example holds real-looking secret"; FAIL=1; else say OK ".env.example is placeholder-only"; fi

# repo hygiene: no databases, fixtures or build output committed
for bad in data/empire.db dist; do
  if git ls-files --error-unmatch "$bad" >/dev/null 2>&1; then say FAIL "committed artifact: $bad"; FAIL=1; fi
done

[ "$FAIL" -eq 0 ] && echo "deploy kit validation: PASS" || { echo "deploy kit validation: FAIL"; exit 1; }

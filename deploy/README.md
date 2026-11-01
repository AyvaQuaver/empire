# Empire deployment playbook (playempire.uk)

Target platforms: production `https://playempire.uk` and staging
`https://staging.playempire.uk` on the user's existing server, Cloudflare-managed
DNS for the `playempire.uk` zone. Express + SQLite, single instance per
environment, systemd-managed Node behind a local nginx that terminates TLS.

This document is written so every command is copy–paste ready. Secrets are never
printed by any step; they are generated on the server and stored in files with
`0600` permissions owned by the application user.

## 1. Server prerequisites (check on first access)

```bash
ssh <alias-or-user>@<server>
node -v              # must be >= 22.5 (node:sqlite); built against Node 25
free -h; df -h /     # memory and storage review
dpkg -l node nginx   # existing roles; confirm nginx is present or installable
sudo nginx -t        # existing vhosts keep working — this config adds two servers
ss -tlnp | grep -E ':(80|443|8891|8892)\b'   # confirm free ports before use
```

If other applications exist, only the listed paths/ports change: nothing about
SSH, firewalls, or unrelated services is touched.

## 2. First-time server setup

```bash
# Dedicated unprivileged user + directory tree
sudo useradd --system --home /srv/empire --shell /usr/sbin/nologin empire
sudo mkdir -p /srv/empire/{repo,releases,app,secrets,staging,production}
sudo chown -R empire:empire /srv/empire
sudo chmod 750 /srv/empire

# Read-only clone for deployment (no GitHub write credentials on the server)
sudo -u empire git clone https://github.com/AyvaQuaver/empire.git /srv/empire/repo
sudo -u empire git -C /srv/empire/repo checkout codex/empire-mvp   # or the deployed ref

# Environment files (root-owned, app-readable): one per instance
sudo touch /srv/empire/secrets/empire-production.env /srv/empire/secrets/empire-staging.env
sudo chmod 600 /srv/empire/secrets/empire-*.env
```

`empire-%i.env` content (placeholders — fill on the server; never commit):

```ini
EMPIRE_ENV=production            # staging file: staging
PORT=8891                        # staging file: 8892
APP_BASE_URL=https://playempire.uk   # staging: https://staging.playempire.uk
CORS_ORIGINS=https://playempire.uk   # staging: https://staging.playempire.uk
EMPIRE_DB_FILE=/srv/empire/production/empire.db
SESSION_SECRET=<openssl rand -base64 32 — generate ON the server; never here>
AUTH_ACCOUNTS_ENABLED=false      # until real SMTP exists (item 6 of the plan)
# SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_FROM  (when enabling accounts)
# CLEANUP_TOKEN=<if an external CRON should trigger POST /api/internal/cleanup>
```

For a NEW empty environment: generate a unique stable secret on the server:

```bash
openssl rand -base64 32    # paste into empire-%i.env only
```

**Never replace the secret of an existing DB with real account data**: it is the
scrypt pepper — changing it breaks password verification (see README).

## 3. Install the service

```bash
sudo cp deploy/empire@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable empire@staging empire@production   # autostart on boot
sudo systemctl start empire@staging                      # staging first
```

`Restart=always` gives crash recovery; the environment file supplies all
configuration (no secrets in unit files or command lines).

## 4. Reverse proxy + TLS

```bash
sudo cp deploy/nginx-empire.conf /etc/nginx/sites-available/empire.conf
sudo ln -sf /etc/nginx/sites-available/empire.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Certificates — choose ONE per server policy:

- **Cloudflare Origin CA (recommended, zone proxied):** create an origin cert in
  the Cloudflare dashboard (SSL/TLS → Origin Server), install under
  `/etc/ssl/empire/` with `0600`, point the two `ssl_certificate` lines to it,
  set the zone SSL mode to **Full (strict)**. No renewal renewals required for 15y.
- **Let's Encrypt:** `sudo certbot --nginx -d playempire.uk -d staging.playempire.uk`
  (renews automatically via the certbot timer; the ACME location is already in
  the config).

Never configure Flexible SSL; edge-to-origin must always verify a real cert.

## 5. Cloudflare DNS (exact records; only these — keeps MX/TXT etc. untouched)

Existing zone state (checked): `playempire.uk` nameservers are
`sharon.ns.cloudflare.com` / `yew.ns.cloudflare.com`; no A/AAAA records exist yet
for the apex, `www`, or `staging` subdomain.

Create (via dashboard or narrowly-scoped API token with Zone → DNS → Edit for
this zone only):

| Type | Name | Content | Proxy | TTL
| --- | --- | --- | --- | --- |
| A | `@` | `<SERVER_IPV4>` | Proxied | Auto |
| A | `staging` | `<SERVER_IPV4>` | Proxied | Auto |
| A | `www` | `<SERVER_IPV4>` | Proxied | Auto |

- **No AAAA records** unless the server's IPv6 connectivity is verified first.
- With proxy on, origin TLS must be the Cloudflare **Origin CA** cert (Full
  strict) OR a public cert (e.g. Let's Encrypt) — either validates; Flexible is
  forbidden.
- Zone SSL mode: **Full (strict)**. Raise the pre-existing DNS TTL of the zone's
  NS records is not needed; no other record may be altered.
- Optional caching: no extra rules needed. Static `/assets/*` files are
  content-hashed (immutable) and safe to cache; everything else answers
  `no-store` from the app. Do NOT add a "Cache Everything" rule.

## 6. Deploy / restart / rollback / logs

```bash
# Deploy a ref to one environment (builds, verifies, swaps, restarts, healthchecks)
sudo -E bash /srv/empire/repo/deploy/deploy.sh staging
sudo -E env EMPIRE_REF=codex/empire-mvp bash /srv/empire/repo/deploy/deploy.sh production

# Status / logs
systemctl status empire@production
journalctl -u empire@production -f --since today     # redacted app logs

# Rollback: point /srv/empire/app at the previous release and restart.
# NOTE: this cannot undo database migrations — restore the DB backup taken
# before the deploy when migrations changed the schema.
ls -1t /srv/empire/releases | head
sudo ln -sfn /srv/empire/releases/<previous-release> /srv/empire/app.new && \
  sudo mv -T /srv/empire/app.new /srv/empire/app && \
  sudo systemctl restart empire@production
```

Migrations run once per boot (server/src/db.ts, ordered files). The deploy
script runs them by restarting; review pending migrations (server/migrations/)
before deploying.

## 7. Backups

```bash
sudo -u empire bash /srv/empire/repo/deploy/backup.sh production          # snapshot now
sudo -u empire bash /srv/empire/repo/deploy/backup.sh production \
  restore /srv/empire/production/backups/empire-production-<stamp>.db.gz  # verify restore
```

- Uses `sqlite3 .backup` (online-consistent incl. WAL), stores `.db.gz` outside
  the release directory, keeps the last 8 snapshots.
- **These copies stay on the same server**: they do not protect against total
  server loss. Point an external destination (or small offsite sync) at these
  paths when storage is available; none is provisioned automatically.
- Schedule via cron as root: `17 3 * * * sudo -u empire bash /srv/empire/repo/deploy/backup.sh production`

## 8. Cleanup job

The app's retention sweep runs hourly in-process (development/test fixtures
purged; temporary winning-word reveals deleted on next round, cancel, or 24h —
also enforced at read time). Verify after deploy:

```bash
sqlite3 /srv/empire/production/empire.db \
  "SELECT count(*) FROM result_reveals WHERE expires_at < strftime('%s','now')*1000;"
# must print 0 (or the pre-expiry count with a future expiry)
```

Optionally set `CLEANUP_TOKEN` and add an external CRON calling
`POST /api/internal/cleanup` as a second, independent sweep trigger.

## 9. Verify (run before declaring success)

```bash
for H in playempire.uk staging.playempire.uk; do
  curl -sSI https://$H | head -3                       # 200/redirect + TLS
  curl -sS https://$H/api/health
  curl -sS https://$H/api/capabilities
done
```

Then: create a room as an independent session, decode the lobby QR (expect the
`staging`/`playempire.uk` host), open the invite directly to name entry, run a
full guest game (words → 3 readings → starter → result → next round), check
`/api/dev/outbox` still 404s, restart the unit (data persists) and confirm
`result_reveals` expiry behaves. Browser checks only — real-device audio asserts
must not be claimed.

## 10. Retiring the old temp tunnel (AFTER verified prod)

The Mac no longer needs to run anything:

```bash
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787"
# on the Mac: kill the tsx server process listening on :8787
```

Full game history and the temporary URL in `docs/build-progress.md` become
historical; new links always carry `APP_BASE_URL` from the real domain.

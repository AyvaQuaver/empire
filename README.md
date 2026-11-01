# Empire

Empire is a mobile-first companion app for the in-person family word game: players
write secret words on their phones, three shuffled read-outs are spoken aloud by one
speaker device, and the table plays the physical guessing round. The app never
reveals anyone's word — not even to the organiser or to the server's own clients.

Repo: https://github.com/AyvaQuaver/empire (join on the `codex/empire-mvp` branch; open a PR from it).

## Feature summary

- Rooms of 3–20 players, joinable by code, link or QR. No account needed to play.
- Roster lock before word collection; the organiser may remove players only before
  readings begin.
- Private word submissions (duplicate words rejected case-insensitively with a
  neutral message and no loss of your previous word).
- Three independently shuffled, server-generated word-only reading lists plus a
  uniformly random starter announced after the third reading.
- A fenced speaker lease: exactly one device holds the words; organiser takeover is
  explicit; restarts repeat the saved order.
- Browser text-to-speech with pacing and a stall watchdog, a "Test sound" button and
  no autoplay.
- Organiser-reported results with correction (one row per round, audit trail).
- "Play another round" keeps the group and creates a fresh round with fresh secrets.
- Optional accounts (register/verify/sign-in/reset, no email enumeration), guests can
  upgrade in place without losing their history, account deletion anonymises.
- Friends with exact-username search (never emails), crossed-request collapsing and
  in-app game invitations to accepted friends only.

## Privacy model (short version)

Words live in private tables and are released only to the lease-holding speaker
device as a word-only list with no owner metadata. Room snapshots contain readiness
status and your own word only. No words, submissions, or shuffles ever appear in
URLs, localStorage, or logs. See `docs/permissions-matrix.md` for the full matrix and
retention rules.

## Development

Requirements: Node 22+ (built against Node 25; uses the built-in `node:sqlite`).

```bash
npm install
npm run dev        # API on :8787 + Vite on :5173 (proxy configured) — run in two terminals: npm run dev:server & npm run dev
npm test           # vitest: API + privacy + speech suites (27 tests)
npm run build      # typechecks implied above; emits dist/ the server serves in production
npm run cleanup    # one-off retention sweep (also runs hourly in-process)
```

Useful bits:

- `npm run db:reset` deletes the local database file.
- Dev-only email fixture: in local development with `ALLOW_DEV_EMAIL_PREVIEW=true`
  and no SMTP, verification/reset emails land in the local `email_outbox` table.
  There is **no browser route for them** — inspect locally with
  `npm run email:outbox`, a CLI that refuses to run outside local development.
- On boot, the server runs migrations from `server/migrations/0001_init.sql` and
  keeps `robots: noindex` on the SPA.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `EMPIRE_ENV` | Deployment environment: `development` \| `test` \| `staging` \| `production` (falls back to `NODE_ENV`) | `development` |
| `PORT` | API port | `8787` |
| `EMPIRE_DB_FILE` | SQLite file path (`:memory:` in tests) | `./data/empire.db` |
| `SESSION_SECRET` | Stable scrypt pepper; **required in staging/production**, must survive restarts (see above) | `dev-only-change-me` (dev only) |
| `APP_BASE_URL` | Base URL for invitation/verify/reset links and QR codes | `http://localhost:5173` |
| `CORS_ORIGINS` | Comma-separated allowed browser origins | `http://localhost:5173` |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`EMAIL_FROM` | Outbound email; **required in staging/production** | unset |
| `ALLOW_DEV_EMAIL_PREVIEW` | Enables the local CLI outbox reader (`npm run email:outbox`); valid only with `EMPIRE_ENV=development` (validated) | unset |
| `AUTH_ACCOUNTS_ENABLED` | `false` = explicit guest-only preview: account/social endpoints refuse server-side while guest play continues; unset = `true` | unset |
| `CLEANUP_TOKEN` | Optional token for `POST /api/internal/cleanup` (platform CRON) | unset (404 without it) |

## Fonts & assets

- Display/wordmark: [Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2)
  (`@fontsource/baloo-2`), body: Nunito Sans (`@fontsource/nunito-sans`) — both SIL
  Open Font License 1.1.
- Crown/confetti decorations are hand-written SVG (no external image assets).

## Environment policy

One variable chooses the deployment environment explicitly:

| `EMPIRE_ENV` | Meaning | Stable secret | SMTP | Dev outbox |
| --- | --- | --- | --- | --- |
| `development` | Local dev machine | Default OK | Optional (fixture used) | CLI tool with explicit flag |
| `test` | Automated tests (in-memory DB) | Default OK | Optional (fixture) | n/a (DB fixture only) |
| `staging` | Deployed staging (prod hardening) | **Required** | Required **unless `AUTH_ACCOUNTS_ENABLED=false`** | Never |
| `production` | Live | **Required** | Required **unless `AUTH_ACCOUNTS_ENABLED=false`** | Never |

Rules enforced by code and tests:

- **Unknown environment values are REJECTED.** `EMPIRE_ENV=stagng` (or a blank /
  whitespace value, or an invalid explicit `NODE_ENV`) refuses to start. A supported
  value in `EMPIRE_ENV` wins over `NODE_ENV`; if nothing is supplied, the documented
  default is `development`.
- **Stable secret.** Generate with `openssl rand -base64 32`, keep it in the host's
  secret store, never commit it, keep it identical across restarts/redeploys. It is
  the scrypt pepper: **changing it makes existing password hashes unverifiable**
  (every user would need a reset). No automatic rotation; rotation needs a
  migration (per-hash pepper version + rehash at next login).
- **SMTP.** Required in staging/production whenever `AUTH_ACCOUNTS_ENABLED` is `true`
  (verification/reset need real delivery). A guest-only preview
  (`AUTH_ACCOUNTS_ENABLED=false`) may omit SMTP but STILL requires the stable secret
  and all other production hardening. Delivery records persist only minimal metadata
  (type/status/safe error identifier) — never bodies, subjects, recipients or token
  URLs. Later delivery failures surface as generic errors that never echo tokens.
  Validation/hashed-token storage itself is unchanged and stays single-use.
- **Development outbox (fixture).** The email fixture persists complete bodies ONLY
  in `EMPIRE_ENV=development` when `ALLOW_DEV_EMAIL_PREVIEW=true` (or in `test` as an
  in-memory fixture). There is NO browser outbox route anymore — inspect locally with
  `ALLOW_DEV_EMAIL_PREVIEW=true npm run email:outbox`, a CLI that also refuses to run
  outside development. An earlier `/api/dev/outbox` browser route was fully removed.
- **Guest preview.** `AUTH_ACCOUNTS_ENABLED=false` disables register/sign-in/
  verify/resend/forgot/reset/delete, friends, search and invites SERVER-side (403
  with "Guest preview — accounts are not available yet."). Guest play (rooms, words,
  readings, results, guest stats) is untouched, existing accounts are neither
  deleted nor revoked, and re-enabling accounts restores the flows. The frontend
  reads a safe capability flag (`GET /api/capabilities`) and replaces account CTAs
  with "Guest preview — accounts are not available yet."
- Validation runs BEFORE the database is opened, migrations run, schedulers start
  or any request is accepted; failures list each problem area without printing
  secret values.

## Deployment notes (staging)

**Supported deployment model (important):**

- **Exactly one application instance.** The database is SQLite on a **persistent
  local volume**; the app must never run multiple independently-writable replicas
  or scale horizontally. SQLite + WAL + `busy_timeout` (5s) handle single-process
  concurrency; scale-out would require a real database server (out of scope).
- **Node version:** `node:sqlite` is used via `process.getBuiltinModule`; it is
  available without flags on Node ≥ 23.4 and is verified working on Node 22–25
  (this project was built and tested on Node 25.9).
- **Migrations** run automatically at boot (`server/migrations/*.sql`, tracked in
  `_migrations`), idempotently — safe across restarts/redeploys. (0002 adds the
  speaker-transfer authorization table.)
- **Build & start:** `npm ci && npm run build` then `npm run server` — one process
  serves `dist/` and the API on the same origin/port (`PORT`, default 8787).
- **Persistent volume/disk:** mount a volume and point `EMPIRE_DB_FILE` at it
  (e.g. `/var/data/empire.db`). An ephemeral container filesystem will lose accounts,
  games and history on each redeploy.
- **Backups:** online backup is safe with WAL: `sqlite3 $EMPIRE_DB_FILE ".backup
  '/backups/empire-YYYYMMDD.db'"`, or plain copy while stopped. On Fly, enable
  volume snapshots (first 10 GB free). Restore = stop, replace the file, start.
- **Restart/redeploy:** everything persists (accounts, friendships, results,
  history — verified against a real process restart). In-flight readings resume;
  speakers re-tap "Start readings (saved order)" if their lease expired (TTL 3 min).
- The SPA also refuses to show an endless blank/loading screen: a 12 s asset
  watchdog and a 10 s session bootstrap timeout surface retryable errors.
- **HTTPS/cookies:** same origin for site + API; cookies are `HttpOnly`,
  `SameSite=Lax`, and become `Secure` automatically behind a TLS-terminating proxy
  (`x-forwarded-proto`, `trust proxy` = 1). Set `APP_BASE_URL`/`CORS_ORIGINS` to the
  deployed URL. The SPA sends `noindex`.
- **Cleanup:** the hourly in-process sweep always runs. `POST /api/internal/cleanup`
  exists for platform CRON and is **disabled (404) unless `CLEANUP_TOKEN` is set**
  plus the `x-cleanup-token` header (verified by test).
- **Speaker transfer & offline devices:** speaker changes are organiser-authorized
  and participant-accepted (5-minute single-use authorization). A disconnected
  device can't be silenced remotely — transfer UIs show "Stop playback on the
  previous phone before continuing", and the server fences its lease.

**Hosting costs — estimates, verify before purchasing (checked 2026-11-01):**

- **Fly.io:** no free tier for new organizations. Smallest workable staging:
  `shared-cpu-1x` 256 MB ≈ **$2.19/mo** + 1 GB volume **≈ $0.15/mo** + egress
  $0.02/GB → often **≈ $2.35–2.50/mo** total. Free trial ~2 h of runtime.
- **Render:** a free web-service tier exists, but **no persistent disk** is included
  (disks $0.25/GB/mo need paid compute, cheapest headline $7/mo) — the SQLite file
  would otherwise be erased on redeploy ⇒ ≈ **$7.25+/mo** for persistent staging.
- **Email:** Brevo/Twilio SendGrid/etc. free tiers (roughly 100–300 emails/day
  each, terms change) are plausible for verification/reset volume — verify limits
  yourself before committing.

Nothing has been purchased or provisioned.

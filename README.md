# Empire

Empire is a mobile-first companion app for the in-person family word game: players
write secret words on their phones, three shuffled read-outs are spoken aloud by one
speaker device, and the table plays the physical guessing round. The app never
reveals anyone's word — not even to the organiser or to the server's own clients.

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
- Dev-only email preview: run with `ALLOW_DEV_EMAIL_PREVIEW=true` and without SMTP
  configured; verification/reset emails land in the local `email_outbox` table and
  are readable at `GET /api/dev/outbox` (local machine only).
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
| `ALLOW_DEV_EMAIL_PREVIEW` | Enables `GET /api/dev/outbox`; `EMPIRE_ENV=development` only (validated) | unset |
| `CLEANUP_TOKEN` | Optional token for `POST /api/internal/cleanup` (platform CRON) | unset (404 without it) |

## Fonts & assets

- Display/wordmark: [Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2)
  (`@fontsource/baloo-2`), body: Nunito Sans (`@fontsource/nunito-sans`) — both SIL
  Open Font License 1.1.
- Crown/confetti decorations are hand-written SVG (no external image assets).

## Environment policy

One variable chooses the deployment environment explicitly:

| `EMPIRE_ENV` | Meaning | Secrets | SMTP | Dev outbox |
| --- | --- | --- | --- | --- |
| `development` | Local dev machine | Documented defaults allowed | Optional (outbox used) | OK with `ALLOW_DEV_EMAIL_PREVIEW=true` |
| `test` | Automated tests (in-memory DB) | Defaults | Optional | Never exposed as a route |
| `staging` | Deployed staging (shared prod hardening) | **Must be configured** | **Must be configured** | Never |
| `production` | Live | **Must be configured** | **Must be configured** | Never |

(`EMPIRE_ENV` falls back to `NODE_ENV`. Unknown values fall back to `development` for the
local CLI, but the boot validator pays attention to staging/production explicitly.)

**Staging/production refuse to start** (`npm run server` → `validateDeploymentConfig` in
`server/src/config.ts`) when any of the following is missing, blank or an obvious
placeholder:

- `SESSION_SECRET` — a stable, unique secret. Generate with `openssl rand -base64 32`,
  set it as an environment variable in the hosting provider's secret store, and never
  commit it. It must stay EQUAL across restarts and redeploys: it is the scrypt pepper,
  so **changing it makes existing password hashes unverifiable** — every user would
  need a password reset. There is no automatic rotation by design; rotation requires a
  migration strategy (store per-hash pepper version + rehash on next login).
- Complete SMTP configuration (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD`, valid `EMAIL_FROM`) — verification and password-reset email have
  no other transport. Later delivery failures surface as a generic 502/"try again"
  and never echo tokens or leaks.
- `ALLOW_DEV_EMAIL_PREVIEW` must be removed for these environments — contradictory
  configuration is rejected at boot, and the `/api/dev/outbox` route additionally
  only exists when `EMPIRE_ENV=development`.

The dev outbox stores verification/reset links ONLY in development/test local
databases and is readable only through the local-machine preview route. Staging and
production never write reset links to an outbox, never return them in API responses,
and never log them.

Config problems print each failing area in a way that never includes a secret value,
and the process exits non-zero **before accepting requests**.

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

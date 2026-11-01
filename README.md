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
| `PORT` | API port | `8787` |
| `EMPIRE_DB_FILE` | SQLite file path (`:memory:` in tests) | `./data/empire.db` |
| `APP_BASE_URL` | Base URL used for invitation links/QR | `http://localhost:5173` |
| `CORS_ORIGINS` | Comma-separated allowed browser origins | `http://localhost:5173` |
| `EMPIRE_COOKIE_SECURE` | Force `Secure` cookies (auto when behind https) | auto |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | Outbound email; when unset, email is stored in the local outbox | unset |
| `ALLOW_DEV_EMAIL_PREVIEW` | Enables `GET /api/dev/outbox` (non-production only) | unset (`true` for local dev) |
| `CLEANUP_TOKEN` | Optional token for `POST /api/internal/cleanup` (platform CRON) | unset (404 without it) |

## Fonts & assets

- Display/wordmark: [Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2)
  (`@fontsource/baloo-2`), body: Nunito Sans (`@fontsource/nunito-sans`) — both SIL
  Open Font License 1.1.
- Crown/confetti decorations are hand-written SVG (no external image assets).

## Deployment notes (staging)

**Supported deployment model (important):**

- **Exactly one application instance.** The database is SQLite on a **persistent
  local volume**; the app must never run multiple independently-writable replicas
  or scale horizontally. SQLite + WAL + `busy_timeout` (5s) handle single-process
  concurrency; scale-out would require a real database server (out of scope).
- **Node version:** `node:sqlite` is used via `process.getBuiltinModule`; it is
  available without flags on Node ≥ 23.4 and is verified working on Node 22–25
  (this project was built and tested on Node 25.9).
- **Migrations** run automatically at boot (`server/migrations/0001_init.sql`,
  tracked in `_migrations`), idempotently — safe across restarts/redeploys.
- **Backups:** stop-or-copy: `sqlite3 data/empire.db ".backup
  '/backups/empire-YYYYMMDD.db'"` while running (WAL allows online backup), or
  plain `cp` while the service is stopped. Restore = replace the file and restart.
  On Fly, enable volume snapshots (first 10 GB free).
- **Restart/redeploy:** state is entirely in the DB file; verified that accounts,
  friendships, results and history survive a process restart (cookies stay valid).
  In-flight rounds simply resume; speakers may need to re-tap (lease TTL 3 min).
- **HTTPS/origin:** the server serves both `dist/` and the API on **one origin**,
  so cookies are first-party. Set `trust proxy` is enabled; behind a TLS-terminating
  proxy the app auto-detects `x-forwarded-proto` and marks cookies `Secure`. Set
  `APP_BASE_URL`/`CORS_ORIGINS` to the real deployed URL.
- **Cleanup:** the hourly in-process sweep always runs; the external
  `POST /api/internal/cleanup` exists for platform CRON and is **disabled (404)
  unless `CLEANUP_TOKEN` is set** and matched (verified by test).

**Verified hosting costs (checked 2026-11-01; do not provision without approval):**

- **Fly.io:** no free tier for new organizations. Cheapest workable staging:
  `shared-cpu-1x` 256 MB machine **$2.19/mo** + 1 GB volume **$0.15/mo** + egress
  $0.02/GB → **≈ $2.35–2.50/mo**. Free trial covers ~2 h of runtime.
- **Render:** a free web-service tier exists, but free services have **no persistent
  disk** (disks are $0.25/GB/mo and require paid compute, cheapest $7/mo) → the
  SQLite file would be erased on each deploy. Persistent staging on Render means
  **≈ $7.25+/mo**.
- **Email:** Brevo/Twilio SendGrid free transactional tiers (100–300 emails/day)
  suffice for verification/reset volume; effectively **$0/mo**.

Any staging deploy needs these decisions/credentials: domain or provider subdomain
(`*.fly.dev`/`*.onrender.com` are free, no purchase), SMTP account, and DB volume
attachment. Nothing has been purchased.

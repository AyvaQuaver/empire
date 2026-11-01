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

No paid services or domains are arranged yet. A free-tier deployment works on any
host that provides persistent Node + disk for the SQLite file (Render, Fly.io,
Railway):

1. Deploy as a single service: `npm ci && npx tsc -p tsconfig.json --noEmit && npm run build` then `node --run` … start with `npm run server` (the server serves `dist/`
   and the API on one port). Set `APP_BASE_URL` and `CORS_ORIGINS` to the staging URL.
2. Attach a persistent disk and point `EMPIRE_DB_FILE` at it (SQLite on a network
   ephemeral filesystem is lost on redeploy).
3. Configure the platform's scheduled job to call `POST /api/internal/cleanup`
   hourly with the `x-cleanup-token` header, or leave the 24h inactivity cleanup to
   the in-process hourly sweep.
4. Keep `ALLOW_DEV_EMAIL_PREVIEW` unset in staging. Provide real SMTP credentials to
   send verification/reset email.
5. `robots` noindex is included in `web/index.html` so search engines don't index
   the staging URL.

Current blocker: no staging host, no SMTP account — nothing was purchased. See
`docs/build-progress.md` for the honest handoff state.

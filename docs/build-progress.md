# Empire — build progress

Date: 2026-11-01 · branch: `codex/empire-mvp` (local repo; no remote configured)

## 00. Second review round (2026-11-01)

Findings → fixes, verified:

1. **Config fail-fast** (`server/src/config.ts` + `server/src/index.ts`): explicit
   `EMPIRE_ENV` policy (development|test|staging|production). Staging/production
   **refuse to start** (exit before listening) on missing/blank/placeholder
   `SESSION_SECRET`, missing/incomplete SMTP (`SMTP_HOST`, credentials, valid
   `EMAIL_FROM`), or contradictory `ALLOW_DEV_EMAIL_PREVIEW`. No defaults/blank
   substitutions; error messages never include secret values. Secrets documented
   (`openssl rand -base64 32`), kept in provider env stores; stability across
   restarts required; pepper-change breaks existing password hashes (no auto
   rotation). Tests: `startup.test.ts` incl. a spawned staging process really
   refusing to boot, and a register→restart→sign-in/old-cookie recovery suite.
2. **Speaker transfer rebuilt** (`migrations/0002`, `rounds.ts`, `api.ts`,
   `ReadingView.tsx`): force takeover removed. Paths: same-session continue;
   recovery claim by any participant on an EXPIRED/absent lease (atomic — race
   test with two claimants yields exactly one 200 + one 409); organiser-authorized
   transfer (5-min, single-use, round+participant-bound row) accepted only on the
   authorized participant's own device (wrong person/expired/replayed → 410).
   Acceptance atomically issues the lease and fences the old device; transfers
   never touch word data, roster, submissions or the starter. UI shows who is
   speaking now (`snapshot.reading.speaker`), plus a per-me
   `transferPendingForMe` accept button. Speaker access ends with the round.
3. **Lost-audio semantics implemented + documented** (`speech.ts`/`ReadingView.tsx`):
   revoked/failed lease stops the chain and cancels local playback (in-flight
   utterance via `adapter.cancel()`; later words never queued — runner test
   proves "three" is not queued after a 403 ack). The server cannot silence an
   offline device; transfer/recovery UIs show "Stop playback on the previous
   phone before continuing" and the limitation is documented.
4. **Email/outbox strictness** (`email.ts`, `api.ts`): outbox writes/logs only in
   development/test; browser route only when `EMPIRE_ENV === "development"` AND the
   flag is set; staging cannot enable it (validated at boot + route check 404
   test); SMTP delivery failures stay generic and never echo tokens; no
   enumeration anywhere (existing tests cover).
5. **Docs updated** (README + `.env.example`): exact env policy table, secret
   generation/rotation warning, SMTP requirements, backup procedure, migration
   flow, single-instance/volume requirements, speaker-transfer/offline-device
   limitations, costs marked as estimates-awaiting-verification.
6. **Regression browser smoke (4 players, Chromium)**: full flow incl. one-tap
   automatic readings, reload-disconnect mid-chain, manual "Restart readings
   (saved order)" recovery, starter persisted, winner recorded (stats: Runner3
   gamesPlayed 1, wins 1), next round opened with round-1 secrets purged (DB
   checked), no word text in the DOM at any point.

## 0. First review round (2026-11-01)

Findings → fixes, all verified:

1. **"Say it yourself" fallback removed** (`web/src/pages/roomviews/ReadingView.tsx`,
   `WordEntryView.tsx`): the copy "say each word aloud yourself" and its variants are
   gone. No screen ever renders the words; the only word text exists in the browser
   TTS engine of the single lease-holding device (documented honestly, incl. the
   DevTools caveat). Audio failure now recovers via: test-sound, a clear error
   banner, "Restart this reading (same saved order)" and explicit speaker takeover
   (any roster member with force; the previous device's lease is killed and its
   audio stops). Nothing regenerates shuffles or the starter on error.
2. **One-tap flow** (`ReadingView.tsx`): the normal flow is now one tap — "Start
   readings" — followed automatically by all three readings and the starter
   announcement. Recognised-and-fixed dead ends: the organiser could misclick into a
   state with no way to load the words, and reading N+1 required a manual press.
   Manual intervention is strictly recovery (pause/failure/refresh mid-reading).
3. **Authentication audit** (details in `docs/permissions-matrix.md`): scrypt via
   node:crypto with pepper + timingSafeEqual; hashed session tokens; HttpOnly/
   SameSite=Lax/Secure cookies; custom-header CSRF; per-IP and per-account rate
   limits; generic credentials/reset replies; single-use, hashed, expiring
   verification/reset tokens; reset now revokes all sessions (re-verified); account
   deletion now requires password re-authentication. New tests: expired/reused reset
   tokens, sign-out revocation, cache headers, cleanup-endpoint auth, established
   tests for guest-history claim refusal.
4. **Cache hardening** (`server/src/app.ts`): every response now sets
   `Cache-Control: no-store` and `X-Robots-Tag: noindex` — private/state/data never
   cached by browsers, proxies, or service workers (none registered anyway).
5. **Dev-outbox staging behaviour** (`server/src/email.ts`): outbox insert + console
   line restricted to non-production; production without SMTP raises a clear config
   error (boot warning), never fake delivery success.
6. **Verified restart persistence** (`/tmp/empire-persist` run): after killing and
   restarting the server against the same SQLite file, the signed-in cookie still
   resolves, sign-in works, friendships remain, stats/history intact, and finished
   rounds' private rows were already purged (0 rows).
7. **Four-player browser game end-to-end (Chromium)**: lobby polling, UI duplicate
   word rejection (`Mate 2` typed `PRETZEL` → neutral conflict, prior word kept),
   one-tap automatic triple reading + starter announced twice in a row (round 2 as
   re-verification), winner recorded & corrected with stats moving (Mate1 1 win,
   Mate3 0 wins, both gamesPlayed 1), "Play another round" with the same group,
   mate's round-1 word reusable in round 2 (`pretzel` accepted, round-1 rows purged
   — DB checked), Test sound pressed successfully, refresh mid-flow preserved
   identity/starter and surfaced no words in the DOM.
8. **320px overflow fixed** (`web/src/components/decor.tsx`): the confetti SVG's
   presentational `width` beat the container `inset`, causing a 16px horizontal
   scroll at 320px; now `width/height: 100%` — measured overflow gone (320x320).
9. **`npm run build` was broken** (`package.json` pointed `tsc -p server` at a
   nonexistent tsconfig) → fixed to `-p tsconfig.json && -p web/tsconfig.json`.
10. **Hosting research** (README): Fly.io = no free tier, ~$2.35/mo works with a
    persistent volume; Render = free tier exists but nothing persistent below
    ~$7.25/mo. SQLite migration explicitly not made "for looks".

## 1. Implemented scope (working software, not a mock-up)

- **Server (Express + node:sqlite file DB):** rooms/players/rounds/round roster with
  the full server-authoritative state machine (`lobby_open → collecting_words →
  ready_to_read → reading → playing → finished`, plus `cancelled`/`expired`);
  private submissions with case-insensitive duplicate rejection and previous-word
  preservation; three crypto-shuffled word-only lists persisted server-side; random
  starter after the third reading; fenced speaker leases (acquire/renew/takeover/
  release, TTL); reading acks with monotonic progress + restart-repeat-saved-order;
  organiser-reported results (idempotent save + correction with audit); history/stats
  bound to guest session or account; friends (exact-username search, crossed-request
  collapse, invites to accepted friends only, recipient-scoped); auth (register/
  verify/resend/sign-in/forgot/reset/delete, guest upgrade binds the session's
  players, no enumeration); hourly + CRON retention cleanup.
- **Frontend (React + Vite):** reference-matched visual system (cream `#FFF9ED`,
  deep-purple `#29143F`, coral `#F0503B`/`#FF684F`, lavender `#C7ADFF`, pill CTAs,
  panels, Baloo 2 wordmark, handwritten SVG crown/confetti) with every front-of-house
  screen: home, create, join (+token preview), room controller with lobby (QR +
  share), word entry, reading (TTS runner, lease takeover, restart, test sound),
  playing (starter + house rules), result (correction), profile, friends, how-to-play,
  privacy, 404.
- **Privacy guarantees:** words in private_* tables only; word snapshots never include
  any player's word but the caller's; reading payload delivered only to the lease
  holder via header token; nothing secret in URLs/localStorage/logs.
- **Tests:** vitest suite, **27 tests passing** across 7 files (lifecycle, privacy &
  permissions, retention, auth, friends, speech machine, roster churn & correction).
  Notable cases: 4-player full round with duplicate words and double-start
  rejection; payload fencing (wrong session/no header/past-completion all 403);
  reconnection keeps identity/words (cookie re-use); cancelled game refuses joins;
  remove-below-minimum blocks start; per-round word uniqueness reset on
  "Play another round"; correction keeps exactly one game.

## 2. How to run

```bash
npm install
npm run dev        # API :8787 + web :5173 (two terminals / npm-run dev:server + dev:web)
npm test           # 27 tests
npm run build      # production build → dist/ (server serves it with SPA fallback)
npm run cleanup    # manual retention sweep
```

Environment variables are listed in `README.md`. Without `.env`, everything runs on
localhost defaults with file DB `./data/empire.db` (WAL).

## 3. Env vars / credentials still needed

- **SMTP** (host/port/user/pass/from): none configured — email currently lands in
  the local dev outbox (`ALLOW_DEV_EMAIL_PREVIEW=true`, local machine only).
- **Staging host + persistent disk + staging DB**: none purchased/arranged.
- Optional: `CLEANUP_TOKEN` for platform CRON.

## 4. Test outcomes (honest)

- `npx vitest run` → **8 files / 33 tests, all passing** (new: `guards.test.ts`
  session/token/cleanup/cache instrumentation).
- `npx tsc --noEmit -p tsconfig.json` and `-p web/tsconfig.json` → clean.
- `npx eslint server/src server/test web/src scripts` → clean (flat config added).
- `npm run build` → succeeds (~80 KB gzipped JS) — build script itself was broken
  and is fixed.
- Manual browser flows on localhost (Chromium, desktop + 320/375/390 CSS frames via
  a temporary iframe harness — not committed): full FOUR-player game twice,
  duplicate-word conflict in the UI, winner recording + correction + stats, next
  round with fresh secrets, Test sound speech playback, explicit speaker takeover
  coverage in tests, refresh identity checks. Screenshots in `docs/screenshots/`
  (home @320/375/390 + desktop, lobby, 3-player & 4 players, word entry, ready,
  reading speaker view, playing, result, corrected result).
- **Real-device testing was NOT performed**: no physical iOS Safari or Android
  Chrome in the loop. The short manual checklist for when devices are available:
  1. Open the app on iPhone Safari; create a room; confirm the room fits the
     viewport (no zoom-out, no horizontal scroll), tap targets ≥44px feel right.
  2. Confirm speech: iOS requires the *first* `speechSynthesis.speak()` to happen
     inside a user gesture — press **Test sound** first, then Start readings.
  3. Lock screen mid-reading / background the tab: speech pauses (or stops —
     Safari kills silenced tabs); returning should show the paused state and
     "Restart readings" recovery.
  4. Take over as speaker on a second device (Android Chrome): confirm the first
     device's audio stops within a few seconds and the second device continues.
  5. Word privacy sanity: organiser's page shows no words anywhere; network tab on
     the speaker device only shows the word-only payload at lease time.
- **No staging URL exists** — nothing was purchased; Fly.io is the recommended
  (~$2.35/mo verified) staging host with one persistent volume (README).

## 5. Staging URL / blocker

**No staging URL exists.** Deployment was prepared but not executed (see README
"Deployment notes"); the blocker is the deliberate constraint: no domains or paid
services purchased, and no free-tier credentials available in this environment.
Once SMTP + host exist, the path is: build → serve `dist/` behind one port → set
`APP_BASE_URL`/`CORS_ORIGINS` → attach disk for SQLite → CRON cleanup.

## 6. Branch / PR

- Built on branch `codex/empire-mvp` in the local project folder (spec source lives
  outside any repo and no git remote exists), so **no PR can be opened** — commit is
  available locally for pushing once a remote is configured.

## 7. Known limitations (per spec + discovered)

1. Winners are **organiser-reported** (inherent to the physical game); supported by
   correction + audit, but organiser trust is required.
2. The **speaker's device receives the word list** by design; browser DevTools could
   read it. Acceptable for MVP; a native TTS app would close this.
3. **TTS behaviour differs by platform** (~1.5s pacing approximated; watchdog +
   manual-read fallback included).
4. **No real-device test performed** — visual/UX verification is browser-only at
   emulated CSS widths.
5. Guests' stats are session-scoped: clearing the browser loses a guest's history
   (accounts avoid this via guest upgrade).
6. `next_round_roster` only auto-carries previous round participants; latecomers
   must be explicitly added by the organiser via the roster editor.
7. SQLite (single node) is the deliberate MVP choice: fine for a family, not a
   multi-region cloud service.

## Remaining nice-to-have (not blocking spec acceptance)

- E2E test that drives the reading UI (current browser coverage was manual).
- Pusher/websocket upgrade over the 2.5s bounded polling (hidden-tab aware).
- i18n (UI copy is English-only).

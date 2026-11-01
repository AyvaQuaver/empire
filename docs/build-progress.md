# Empire — build progress

Date: 2026-11-01 · branch: `codex/empire-mvp` (local repo; no remote configured)

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

- `npx vitest run` → **7 files / 27 tests, all passing** (~1.5s).
- `npx tsc --noEmit -p tsconfig.json` and `-p web/tsconfig.json` → clean.
- `npx eslint server/src server/test web/src scripts` → clean (flat config added).
- `npx vite build` → succeeds (~80 KB gzipped JS).
- Manual browser flow on localhost (Chromium, 375px frame): create → lobby live
  polling (external clients joined within one poll) → lock → word entry → three
  readings driven end-to-end with speech state machine → random starter announced →
  winner recorded via organiser UI → result view with correction link. Screenshots in
  `docs/screenshots/` (home @375/390/320, lobby, ready, reading, playing, result).
- **Real-device testing was NOT performed** (no iOS/Android devices in the loop;
  screenshots are Chromium at CSS viewport sizes via an iframe harness).

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

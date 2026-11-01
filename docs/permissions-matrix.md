# Empire — permissions matrix (MVP)

This is the authoritative, implementation-verified view of who can see or change
what. Verified by `server/test/permissions.test.ts` (the words/ownership sections),
`server/test/lifecycle.test.ts`, `server/test/roster-retention.test.ts` and the
friends/auth suites under `server/test/`.

Roles: **Outsider** (no session or not in the room), **Player** (room member,
non-organiser), **Organiser**, **Speaker device** (whichever session holds the round's
speaker lease — normally the organiser's device, takeover-able by any roster member).

## Data visibility

| Data | Outsider | Player | Organiser | Speaker device |
| --- | --- | --- | --- | --- |
| Room code/title/genre/status (preview) | ✔ `GET /rooms/:code/preview` | ✔ | ✔ | ✔ |
| Player list (names + avatars) | ✘ membership never listed | ✔ (their room) | ✔ | ✔ |
| Anyone's secret word | ✘ no endpoint exists | ✘ | ✘ (see row below) | ✘ (list has no owners) |
| Own word only (myWord) | ✘ | ✔ | ✔ (own) | ✔ (own) |
| Readiness status per player ("ready"/"waiting") | ✘ | ✔ | ✔ | ✔ |
| Reading payload (word-only shuffled array) | ✘ 403 | ✘ 403 | only if speaker | ✔ with `x-empire-lease` header |
| Reading position ($word N of M$, public progress) | ✘ | ✔ | ✔ | ✔ |
| Round starter (after reading 3) | ✘ | ✔ | ✔ | ✔ |
| Result winner | ✘ | ✔ | ✔ | ✔ |
| Friend requests/invites | ✘ (account+session) | recipient-scoped only | — | — |
| Dev email outbox | ✘ outside local dev | ✘ | ✘ (local dev flag only) | ✘ |

Guarantees verified in tests:

- No state/response ever contains another player's word (`permissions.test.ts`
  "never exposes word ownership to any role"; organiser snapshot includes only their
  own `myWord` and no per-player `word` fields).
- No endpoint exists to read someone else's submission; friendliest probe
  (`my-word?playerId=…`) is ignored — the route reads only session-owned rows.
- Reading payload requires both the speaker's session cookie and the raw lease
  token header; correct-token-wrong-session → 403; acks after completion → 403.
- Payload contains `words: string[]` only — no player ids, no owner mapping.
- Search results show username only (no emails anywhere); invite lists are
  recipient-scoped by SQL (`WHERE to_user_id = session user`).

## State transitions — who may do what

| Action | Outsider | Player | Organiser |
| --- | --- | --- | --- |
| Create room | ✘ (any fresh session can *become* an organiser by creating) | — | — |
| Join open room (code/invite) | ✔ | ✘ (idempotent rejoin) | ✘ (already member) |
| Lock roster (min 3) | ✘ | ✘ 403 | ✔ pre-word-collection |
| Submit/replace own word | ✘ | ✔ until lock/readiness | ✔ |
| Remove a player | ✘ | ✘ | ✔ only before readings |
| Start readings (ready_to_read only) | ✘ | ✘ | ✔ |
| Hold/take over speaker lease | ✘ | ✔ roster member (takeover needs organiser force? — see note) | ✔ |
| Ack positions / complete reading | ✘ | ✔ lease holder only | ✔ lease holder |
| Restart a reading (repeat saved order) | ✘ | ✔ lease holder | ✔ |
| Record winner / correct winner | ✘ | ✘ 403 | ✔ organiser only |
| Play another round | ✘ | ✘ | ✔ (finished/cancelled round only) |
| Cancel game | ✘ | ✘ | ✔ |
| Leave room | ✘ | ✔ (before readings) | ✘ (must cancel) |
| Edit genre | ✘ | ✘ | ✔ lobby_open only |
| Invite friends to room | ✘ | sender only | ✔ (accepted friends, open roster only) |

Note — speaker changes (three paths only):

1. **Same device continues** the holder's own session re-acquires (refresh).
2. **Recovery claim** by any current locked-round participant when the lease has
   **expired or is absent** — atomic, first claimant wins (409 for the loser).
3. **Organiser-approved transfer**: the organiser authorizes a participant
   (`speaker_transfers` row: 5-minute TTL, single-use, round+participant bound);
   the authorized participant accepts **on their own device** — acceptance
   atomically consumes the authorization and issues the new lease, fencing the
   old one. Wrong-person/expired/replayed/absent acceptance → 410.

There is no unrestricted force takeover. Speaker access ends with the round
(ack/payload refused after finish/cancel — verified). Transfers and recovery never
regenerate the shuffled sequences, the starter, submissions, or the roster, and
never grant organiser permissions (outcome verified in `guards.test.ts`).

## Server-enforced word-collection rules

- 3–20 players by config; lock refuses below minimum, start refuses below minimum.
- Roster is the server-side `round_roster` (locked snapshot); late joiners are
  refused (409) until "Play another round".
- Duplicate words rejected case-insensitively (409 `WORD_TAKEN`, neutral message,
  no owner named) and the player's previous valid submission is preserved.
- Readiness is recomputed server-side on submit/leave/remove; below-minimum states
  block starting.

## Retention & data lifecycle (policy)

| Data | Where | Lifetime |
| --- | --- | --- |
| Secret words (private_submissions) | private table | purged when the round finishes, is cancelled, or the room expires; also when the player leaves/is removed |
| Reading sequences (private_reading_sequences) | private table | same purge points as words |
| Game results + participants | round_participants/game_results (+result audit) | kept: history survives; cancelled rounds never count and rank nowhere |
| Sessions | sessions table (hash only) | rows live until account deletion; item clean-up sweeps 24h-inactive rooms |
| Email tokens | email_tokens | expire after ≤60min (verify) / ≤3h (reset); expired rows swept |
| Room invites | room_invites | expire after 48h; swept |
| Rooms/rounds | rooms/rounds | 24h inactivity ⇒ room expired + secrets purged |
| Account deletion (DELETE /auth/account) | users+sessions | user row removed; players/sessions anonymised (`session_id/user_id` nulled); friendships removed; audit kept |

Retention implementation: `server/src/services/cleanup.ts` (`runCleanup`, hourly
in-process + `POST /api/internal/cleanup` for platform CRON + `npm run cleanup`).
Verified by `cleanup.test.ts` and `roster-retention.test.ts`.

## Authentication implementation (audited)

- **Password hashing:** scrypt via Node's standard `node:crypto` (no third-party
  crypto, nothing invented). Format `scrypt$<salt hex>$<key hex>` with a 16-byte
  random salt, 64-byte derived key, an application pepper from `SESSION_SECRET`,
  and `timingSafeEqual` comparison. Default scrypt work factors (N=16384, r=8, p=1,
  ~64MB memory per hash). Unknown accounts get equal-cost dummy hashing so sign-in
  timing doesn't enumerate (`dummyHashWork`); the code lives in `server/src/auth.ts`.
  `config.isProduction` boots with a loud config error if `SESSION_SECRET` is unset
  (`server/src/app.ts`).
- **Sessions:** opaque 32-byte `crypto.randomBytes` tokens (`ids.ts randomToken`),
  stored **only as SHA-256 hashes** in `sessions`. Cookie `empire_sid`:
  `HttpOnly`, `SameSite=Lax`, `Path=/`, 90-day expiry on the cookie while the DB
  row is authoritative, `Secure` automatically when served over TLS (detected via
  `x-forwarded-proto`, with `trust proxy` = 1). Revocation: explicit sign-out,
  account deletion, and **password reset deletes every session of that user**
  (verified: `guards.test.ts > password reset revokes every existing session`).
  Every API request refreshes `last_seen_at` (sliding inactivity).
- **CSRF:** `SameSite=Lax` cookies plus a required custom `x-empire-with: fetch`
  header on all mutating requests (set by the app's own fetch wrapper). A
  cross-site form cannot send this header without CORS preflight approval.
- **Rate limits** (in-memory fixed window, `server/src/rateLimit.ts` + routes in
  `api.ts`): auth (register/verify/sign-in) 20 / 15 min per IP; forgot-password 8 /
  15 min per IP; reset 10 / 15 min per IP; verification resend 2-min cooldown
  per account; sign-in creates room-creation throttles and join/word limits too.
- **No enumeration:** unknown user + wrong password return the identical
  `INVALID_CREDENTIALS` (with equal-cost work); forgot-password always answers the
  same sentence; only optionally searchable usernames surface via the intended
  exact-search endpoint (field-level `USERNAME_TAKEN`/`EMAIL_TAKEN` on register
  duplicates is deliberate UX, documented as such).
- **Verification/reset tokens:** 24 random bytes, sent by email, stored hashed
  (SHA-256) in `email_tokens` with expiry (verify 24h, reset 1h), **single-use**
  (`used_at` set inside the consuming transaction — reuse → 400, verified in
  `guards.test.ts > reset tokens are single-use and expire`, which also covers an
  artificially expired token).
- **Guest → account upgrade:** registration upgrades the *current* session only;
  `players.user_id` rows for THIS session's memberships are rebound so stats/
  history follow the account. No other session's players are claimed (verified:
  `auth.test.ts > guest membership survives guest→account upgrade and claims no
  one else's games`).
- **Account deletion:** requires password **re-authentication** now (a stolen
  session alone can't destroy an account; wrong password → 401, verified in
  `auth.test.ts`). Deletion anonymises: `players.user_id`/`sessions.user_id`
  nulled, friendships/requests/tokens/sessions/user row deleted, result audit rows
  keep non-personal history.
- **Logs:** the server never logs words, tokens, cookies or passwords. The
  development outbox console line (recipient + subject only) exists only in the
  explicit development fixture mode.
- **Dev email outbox isolation:** complete bodies are persisted ONLY when
  `EMPIRE_ENV=development` (or the `test` in-memory fixture) is explicit; staging/
  production persist nothing but minimal delivery metadata (kind/status/safe error
  identifier — never bodies, subjects, recipients or SMTP error text). The old
  `GET /api/dev/outbox` browser route was REMOVED after review: a tunnel makes
  "local" servers reachable from anywhere and environment flags are not
  authorization. Inspect the fixture locally with
  `ALLOW_DEV_EMAIL_PREVIEW=true npm run email:outbox` (CLI, refuses non-development).
  Migration `0003_purge_email_bodies.sql` purged any previously stored bodies and
  disabled outstanding unused email tokens at upgrade time (accounts and game data
  untouched).
- **Guest preview:** with `AUTH_ACCOUNTS_ENABLED=false` every account/credential or
  social endpoint refuses server-side with "Guest preview — accounts are not
  available yet." Guest game flows are unaffected; existing accounts/data remain.

## Known permission limitations (honest disclosure)

1. Winners are organiser-reported only — the game's mechanics are physical; the app
   trusts the organiser's report (with correction + audit).
2. The speaker device necessarily receives the word list; anyone with access to that
   device's browser DevTools (network tab) can read the payload. Best-effort local
   cancellation stops new words from being queued after a lease revocation, but the
   server cannot remotely silence a device that stays offline — transfer and
   recovery UIs show "Stop playback on the previous phone before continuing".
3. TTS differs between platforms (voice availability, pacing); the stall watchdog
   and restart-same-order recovery mitigate.
4. Sessions are cookie-only; a shared device keeps the player's room membership
   until sign out — log-out clears the guest identity (no phantom memberships).

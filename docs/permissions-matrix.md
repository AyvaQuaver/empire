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

Note — speaker takeover: any roster member may request takeover with the explicit
force flag; the current holder's lease is killed (fence bumped) and their stale
acks are rejected. The UI labels this clearly ("Taking over stops that device's
lease…").

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

## Known permission limitations (honest disclosure)

1. Winners are organiser-reported only — the game's mechanics are physical; the app
   trusts the organiser's report (with correction + audit).
2. The speaker device necessarily receives the word list; anyone with access to that
   device's browser DevTools (network tab) can read the payload. That's inherent to
   TTS in the browser.
3. TTS differs between platforms (voice availability, pacing); the stall watchdog
   and "say it yourself" fallback mitigate.
4. Sessions are cookie-only; a shared device keeps the player's room membership
   until sign out or expiry — log-out clears the guest identity (no phantom
   memberships).

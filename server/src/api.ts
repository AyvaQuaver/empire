import { type NextFunction, type Request, type Response, Router } from "express";
import type { DB } from "./db.js";
import { config } from "./config.js";
import { AppError, ERR } from "./errors.js";
import { rateLimitOr429, clearRateLimits } from "./rateLimit.js";
import { requireSession } from "./middleware.js";
import { setSessionCookie, clearSessionCookie, sessionMiddleware, csrfCheck } from "./middleware.js";
import * as authService from "./services/authService.js";
import * as roomsService from "./services/rooms.js";
import * as roundsService from "./services/rounds.js";
import * as resultsService from "./services/results.js";
import * as historyService from "./services/history.js";
import * as profileService from "./services/profile.js";
import * as friendsService from "./services/friends.js";
import { runCleanup } from "./services/cleanup.js";
import { buildRoomSnapshot } from "./snapshot.js";
import { getUser } from "./auth.js";

export function buildRouter(db: DB): Router {
  const router = Router();

  // -- helpers -----------------------------------------------------------
  const sessionIdOf = (req: Request): string => requireSession(req).id;
  const sessionUser = (req: Request) => {
    const s = requireSession(req);
    return s.user_id ? getUser(db, s.user_id) : null;
  };
  const roomByParam = (req: Request): roomsService.RoomRow => {
    const room = roomsService.getRoomByCode(db, String(req.params.code));
    if (!room) throw new AppError(ERR.NOT_FOUND, 404, "No game found with that code.");
    return room;
  };
  const _roundForRoom = (room: roomsService.RoomRow): roomsService.RoundRow => {
    const round = roomsService.getRound(db, room.current_round_id);
    if (!round) throw new AppError(ERR.STATE, 409, "No active round.");
    return round;
  };

  // -- health ------------------------------------------------------------
  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "empire-api" });
  });

  // -- capabilities (safe, no secrets/config) ------------------------------
  router.get("/capabilities", (_req, res) => {
    res.json({
      accountsEnabled: config.authAccountsEnabled,
      accountsNotice: config.authAccountsEnabled ? null : "Guest preview — accounts are not available yet.",
    });
  });

  // -- auth --------------------------------------------------------------
  const requireAccountsEnabled = () => {
    if (config.authAccountsEnabled) return;
    throw new AppError(
      ERR.FORBIDDEN,
      403,
      "Guest preview — accounts are not available yet. You can play as a guest.",
    );
  };

  router.post("/auth/register", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      rateLimitOr429(`auth:ip:${req.ip}`, 20, 15 * 60 * 1000);
      const user = await authService.register(db, s.id, {
        username: String(req.body?.username ?? ""),
        email: String(req.body?.email ?? ""),
        password: String(req.body?.password ?? ""),
      });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/sign-in", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      rateLimitOr429(`auth:ip:${req.ip}`, 20, 15 * 60 * 1000);
      const out = await authService.signIn(db, {
        username: String(req.body?.username ?? ""),
        password: String(req.body?.password ?? ""),
      });
      // New session on sign-in: the old guest session stays untouched on shared devices.
      setSessionCookie(db, res, req, out.userId);
      const user = getUser(db, out.userId);
      res.json({ user: user ? { id: user.id, username: user.username, emailVerified: !!user.email_verified_at } : null });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/sign-out", (req, res, next) => {
    try {
      const s = requireSession(req);
      authService.signOutSession(db, s.id);
      clearSessionCookie(res, req);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/verify", (req, res, next) => {
    try {
      requireAccountsEnabled();
      authService.verifyEmail(db, String(req.body?.token ?? ""));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/resend-verification", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      await authService.resendVerification(db, sessionIdOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/forgot-password", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      rateLimitOr429(`forgot:ip:${req.ip}`, 8, 15 * 60 * 1000);
      await authService.forgotPassword(db, String(req.body?.usernameOrEmail ?? ""));
      res.json({ ok: true, message: "If that account exists, we've sent a reset link." });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/reset-password", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      rateLimitOr429(`reset:ip:${req.ip}`, 10, 15 * 60 * 1000);
      await authService.resetPassword(db, String(req.body?.token ?? ""), String(req.body?.password ?? ""));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/auth/account", async (req, res, next) => {
    try {
      requireAccountsEnabled();
      // Password re-authentication: the signed-in session alone can't delete an account.
      const password = String(req.body?.password ?? "");
      await authService.deleteAccount(db, sessionIdOf(req), password);
      clearSessionCookie(res, req);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", (req, res) => {
    const s = requireSession(req);
    const user = sessionUser(req);
    const memberships = user
      ? []
      : ([] as never[]); // no bulk listing by design
    void memberships; // no bulk listing by design
    void s;
    res.json({
      signedIn: !!user,
      user: user ? { ...userProfilePayload(db, user), emailVerified: !!user.email_verified_at } : null,
    });
  });


  // -- profile ------------------------------------------------------------
  // Editable display name for the AUTHENTICATED user only. Sign-in username,
  // email and credentials are untouched; history bound by account id keeps
  // following the same person.
  router.patch("/me/profile", (req, res, next) => {
    try {
      const s = requireSession(req);
      if (!s.user_id) throw new AppError(ERR.UNAUTHENTICATED, 401, "Sign in to edit your profile.");
      rateLimitOr429(`profile:user:${s.user_id}`, 20, 5 * 60 * 1000);
      const profile = profileService.updateDisplayName(db, s.user_id, req.body?.displayName);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  // -- rooms -------------------------------------------------------------
  router.post("/rooms", (req, res, next) => {
    try {
      const s = requireSession(req);
      rateLimitOr429(`create:session:${s.id}`, 5, 5 * 60 * 1000);
      const out = roomsService.createRoom(db, s.id, s.user_id, {
        displayName: String(req.body?.displayName ?? ""),
        title: req.body?.title ? String(req.body.title) : undefined,
        genre: String(req.body?.genre ?? ""),
      });
      const snapshot = buildRoomSnapshot(db, getFresh(db, out.room.id), s.id, config.appBaseUrl);
      res.json({ room: { code: out.room.code }, invitationUrl: snapshot?.invitationUrl, round: out.round });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/join", (req, res, next) => {
    try {
      const s = requireSession(req);
      rateLimitOr429(`join:ip:${req.ip ?? "unknown"}`, 15, 5 * 60 * 1000);
      const out = roomsService.joinRoom(db, s.id, s.user_id, {
        code: req.body?.code ? String(req.body.code) : undefined,
        invitationToken: req.body?.invitationToken ? String(req.body.invitationToken) : undefined,
        displayName: String(req.body?.displayName ?? ""),
        // Room-scope duplicate resolution for signed-in players: applied to
        // THIS membership only, the account's display name is untouched.
        lobbyNickname: req.body?.lobbyNickname ? String(req.body.lobbyNickname) : undefined,
      });
      res.json({ room: { code: out.room.code }, reconnected: out.reconnected });
    } catch (err) {
      next(err);
    }
  });

  router.get("/rooms/:code/state", (req, res, next) => {
    try {
      const s = requireSession(req);
      const room = roomByParam(req);
      const snapshot = buildRoomSnapshot(db, room, s.id, config.appBaseUrl);
      if (!snapshot) {
        // Non-members get identity-only data (room code + status), never players.
        const preview = roomsService.roomPreview(db, { code: room.code });
        res.json({ member: false, room: { code: room.code, title: preview.title, genre: preview.genre, status: preview.status } });
        return;
      }
      res.json({ member: true, snapshot });
    } catch (err) {
      next(err);
    }
  });

  router.get("/rooms/:code/preview", (req, res) => {
    const room = roomsService.getRoomByCode(db, String(req.params.code));
    if (!room) {
      res.status(404).json({ error: { code: ERR.NOT_FOUND, message: "No game found with that code." } });
      return;
    }
    res.json(roomsService.roomPreview(db, { code: room.code }));
  });

  router.get("/join/preview", (req, res) => {
    const token = req.query.token ? String(req.query.token) : undefined;
    if (!token) {
      res.status(400).json({ error: { code: ERR.VALIDATION, message: "Invite link is missing." } });
      return;
    }
    res.json(roomsService.roomPreview(db, { invitationToken: token }));
  });

  router.patch("/rooms/:code", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const updated = roomsService.updateRoom(db, sessionIdOf(req), room, {
        genre: req.body?.genre !== undefined ? String(req.body.genre) : undefined,
        title: req.body?.title !== undefined ? String(req.body.title) : undefined,
      });
      res.json({ ok: true, room: { title: updated.title, genre: updated.genre } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/lock", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const round = roomsService.lockRoster(db, sessionIdOf(req), room);
      res.json({ ok: true, round: { id: round.id, state: round.state } });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/leave", (req, res, next) => {
    try {
      const room = roomByParam(req);
      roomsService.leaveRoom(db, sessionIdOf(req), room);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/remove", (req, res, next) => {
    try {
      const room = roomByParam(req);
      roomsService.removePlayer(db, sessionIdOf(req), room, String(req.body?.playerId ?? ""));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/cancel", (req, res, next) => {
    try {
      const room = roomByParam(req);
      roomsService.cancelRoom(db, sessionIdOf(req), room);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/rooms/:code/next-roster", (req, res, next) => {
    try {
      const room = roomByParam(req);
      roomsService.patchNextRoster(db, sessionIdOf(req), room, {
        addPlayerId: req.body?.addPlayerId ? String(req.body.addPlayerId) : undefined,
        removePlayerId: req.body?.removePlayerId ? String(req.body.removePlayerId) : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // -- submissions -------------------------------------------------------
  router.get("/rooms/:code/my-word", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const player = roomsService.requireMember(db, room, sessionIdOf(req));
      const round = roomsService.getRound(db, room.current_round_id);
      res.json({ word: round ? roundsService.getOwnSubmission(db, round.id, player.id) : null });
    } catch (err) {
      next(err);
    }
  });

  router.put("/rooms/:code/my-word", (req, res, next) => {
    try {
      const s = requireSession(req);
      rateLimitOr429(`word:session:${s.id}`, 30, 5 * 60 * 1000);
      const out = roundsService.submitWord(db, String(req.params.code), s.id, String(req.body?.word ?? ""));
      res.json({ ok: true, wordSaved: true, word: out.word, roundState: out.round.state });
    } catch (err) {
      next(err);
    }
  });

  // -- readings ----------------------------------------------------------
  // Round-authoritative word pacing (see rounds.ts). Speaker/organiser only,
  // validated against the allowed set; a replacement speaker inherits it.
  router.post("/rounds/:id/word-pause", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const ms = roundsService.setWordPause(db, room, round, sessionIdOf(req), Number(req.body?.ms ?? null));
      res.json({ ok: true, wordPauseMs: ms });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/reading/start", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const out = roundsService.startReading(db, room.code, sessionIdOf(req));
      res.json({ ok: true, readingNumber: out.readingNumber, leaseToken: out.leaseToken });
    } catch (err) {
      next(err);
    }
  });

  // -- speaker transfer (organiser-approved, participant-accepted) ---------
  router.post("/rooms/:code/speaker/authorize", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const out = roundsService.authorizeSpeakerTransfer(db, room, sessionIdOf(req), String(req.body?.playerId ?? ""));
      res.json({ ok: true, expiresAt: out.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/speaker/accept", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const s = requireSession(req);
      const player = roomsService.requireMember(db, room, s.id);
      const leaseToken = roundsService.acceptSpeakerTransfer(db, round, s.id, player);
      res.json({ ok: true, leaseToken });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/lease", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const s = requireSession(req);
      const action = String(req.body?.action ?? "");
      const player = roomsService.requireMember(db, room, s.id);
      if (action === "acquire") {
        // Recovery claim: only succeeds when no valid speaker lease exists
        // (expired or absent). An active lease belongs to whoever holds it.
        const out = roundsService.acquireLease(db, round, s.id, player, {});
        res.json({ ok: true, leaseToken: out.leaseToken });
      } else if (action === "renew") {
        roundsService.renewLease(db, round, s.id, String(req.body?.leaseToken ?? ""));
        res.json({ ok: true });
      } else if (action === "release") {
        roundsService.releaseLease(db, round, s.id, String(req.body?.leaseToken ?? ""));
        res.json({ ok: true });
      } else {
        throw new AppError(ERR.VALIDATION, 400, "Unknown lease action.");
      }
    } catch (err) {
      next(err);
    }
  });

  router.get("/rounds/:id/reading/words", (req, res, next) => {
    // Only the lease-holding speaker device receives words — no ownership metadata.
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const s = requireSession(req);
      const leaseToken = String(req.get("x-empire-lease") ?? "");
      const n = Number(req.query.reading ?? "0");
      if (!Number.isInteger(n) || n < 1) throw new AppError(ERR.VALIDATION, 400, "Invalid reading number.");
      roomsService.requireMember(db, room, s.id);
      const payload = roundsService.getReadingPayload(db, room, round, s.id, leaseToken, n);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/reading/ack", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const s = requireSession(req);
      roundsService.ackPosition(
        db,
        round,
        s.id,
        String(req.body?.leaseToken ?? ""),
        Number(req.body?.readingNumber ?? 0),
        Number(req.body?.position ?? 0),
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/reading/complete", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const s = requireSession(req);
      const out = roundsService.completeReading(
        db,
        round,
        s.id,
        String(req.body?.leaseToken ?? ""),
        Number(req.body?.readingNumber ?? 0),
      );
      res.json({ ok: true, readingNumber: out.readingNumber, playingNow: out.finishedPlay });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/reading/restart", (req, res, next) => {
    try {
      const room = roomByParam(req);
      const round = roomsService.getRound(db, room.current_round_id);
      if (!round) throw new AppError(ERR.STATE, 409, "No active round.");
      const s = requireSession(req);
      const player = roomsService.requireMember(db, room, s.id);
      const out = roundsService.restartReading(
        db,
        room,
        round,
        s.id,
        player,
        Number(req.body?.readingNumber ?? 0),
        req.body?.leaseToken ? String(req.body.leaseToken) : null,
      );
      res.json({ ok: true, words: out.words, readingNumber: out.readingNumber, leaseToken: out.leaseToken });
    } catch (err) {
      next(err);
    }
  });

  // -- results -----------------------------------------------------------
  router.post("/rounds/:id/result", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      resultsService.recordResult(db, sessionIdOf(req), room, String(req.body?.winnerPlayerId ?? ""));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // -- winning-word reveal (temporary, round participants only) -----------
  router.get("/rounds/:id/reveal", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const reveal = resultsService.resultRevealFor(db, room, sessionIdOf(req));
      res.json({ reveal });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/reveal-word", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      resultsService.submitRevealWord(db, room, sessionIdOf(req), String(req.body?.word ?? ""));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/cancel-round", (req, res, next) => {    try {
      const room = roomByParam(req);
      roundsService.cancelRound(db, sessionIdOf(req), room);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rounds/:id/next-round", (req, res, next) => {
    try {
      const round = requireRound(db, String(req.params.id));
      const room = roomsService.getRoomById(db, round.room_id) as roomsService.RoomRow;
      const next = roomsService.startNextRound(db, sessionIdOf(req), room);
      res.json({ ok: true, round: { id: next.id, seq: next.seq, state: next.state } });
    } catch (err) {
      next(err);
    }
  });

  // -- profile & history -------------------------------------------------
  router.get("/me/stats", (req, res, next) => {
    try {
      const s = requireSession(req);
      const stats = statsForSession(db, s);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  router.get("/me/history", (req, res, next) => {
    try {
      const s = requireSession(req);
      const games = historyService.gamesForUser(db, s.user_id, sessionPlayerIds(db, s.id));
      res.json({
        games: games.map((g) => ({
          roundId: g.roundId,
          roomTitle: g.roomTitle,
          genre: g.genre,
          finishedAt: g.finishedAt,
          winnerName: g.winnerName,
          won: g.won,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // -- friends & invites -------------------------------------------------
  router.get("/friends", (req, res) => {
    requireAccountsEnabled();
    res.json({ friends: friendsService.friendsOf(db, sessionIdOf(req)) });
  });

  router.get("/friends/requests", (req, res) => {
    requireAccountsEnabled();
    res.json({ requests: friendsService.friendRequestsFor(db, sessionIdOf(req)) });
  });

  router.post("/friends/search", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      rateLimitOr429(`search:session:${s.id}`, 20, 60 * 1000);
      res.json(friendsService.searchUsername(db, s.id, String(req.body?.username ?? "")));
    } catch (err) {
      next(err);
    }
  });

  router.post("/friends/requests", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      rateLimitOr429(`frequest:session:${s.id}`, 10, 60 * 1000);
      const username = String(req.body?.username ?? "");
      const found = friendsService.searchUsername(db, s.id, username);
      if (!found.found || !found.userId) {
        throw new AppError(ERR.NOT_FOUND, 404, "No player with that exact username was found.");
      }
      friendsService.sendFriendRequest(db, s.id, found.userId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/friends/requests/:id/respond", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      const accept = req.body?.accept === true;
      friendsService.respondFriendRequest(db, s.id, Number(req.params.id), accept);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/friends/requests/:id/cancel", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      friendsService.cancelFriendRequest(db, s.id, Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/friends/:userId", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      // removeFriend resolves the caller's user id from the session internally.
      friendsService.removeFriend(db, s.id, String(req.params.userId));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/rooms/:code/invites", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      const room = roomByParam(req);
      const player = roomsService.requireMember(db, room, s.id);
      if (!s.user_id) throw new AppError(ERR.UNAUTHENTICATED, 401, "Sign in to invite friends.");
      const inviteeUserId = String(req.body?.userId ?? "");
      // Invitation targets must be accepted friends; recipient-only visibility is in friends.ts.
      friendsService.sendRoomInvite(db, room, { id: player.id }, s.user_id, inviteeUserId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/invites", (req, res) => {
  requireAccountsEnabled();
    const s = requireSession(req);
    if (!s.user_id) {
      res.json({ invites: [] });
      return;
    }
    res.json({ invites: friendsService.invitesForUser(db, s.id) });
  });

  router.post("/invites/:id/accept", (req, res, next) => {
    try {
      requireAccountsEnabled();
      const s = requireSession(req);
      const out = friendsService.acceptRoomInvite(db, s.id, Number(req.params.id));
      res.json({ ok: true, roomCode: out.roomCode });
    } catch (err) {
      next(err);
    }
  });

  // The dev email outbox is NOT browser-accessible. It was removed: a tunnel or
  // proxy makes "local server" reachable from anywhere, and environment flags
  // are not a substitute for authorization. Use the local CLI instead:
  //   ALLOW_DEV_EMAIL_PREVIEW=true npm run email:outbox
  // (see scripts/email-outbox.ts — it refuses to run outside local development).

  // Cleanup can also be triggered manually (CRON in staging hits POST /internal/cleanup
  // only when CLEANUP_TOKEN matches; no token = 404).
  router.post("/internal/cleanup", (req, res) => {
    const expected = process.env.CLEANUP_TOKEN;
    if (!expected || req.get("x-cleanup-token") !== expected) {
      res.status(404).json({ error: { code: ERR.NOT_FOUND, message: "Not found." } });
      return;
    }
    res.json(runCleanup(db));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: { code: ERR.NOT_FOUND, message: "Not found" } });
  });

  // Structured errors only: stable codes, friendly copy, no stack traces.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next;
    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }
    console.error("[api] unhandled error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: ERR.INTERNAL, message: "Something went wrong on our side." } });
  });

  return router;
}

function getFresh(db: DB, roomId: string): roomsService.RoomRow {
  return roomsService.getRoomById(db, roomId) as roomsService.RoomRow;
}

function requireRound(db: DB, roundId: string): roomsService.RoundRow {
  const db2: DB = db;
  void db2;
  const round = db.prepare("SELECT * FROM rounds WHERE id = ?").get(roundId) as roomsService.RoundRow | undefined;
  if (!round) throw new AppError(ERR.NOT_FOUND, 404, "Round not found.");
  return round;
}

// Session-derived player ids for guest identity history (never client-supplied).
function sessionPlayerIds(db: DB, sessionId: string): string[] {
  const rows = db
    .prepare("SELECT id FROM players WHERE session_id = ?")
    .all(sessionId) as { id: string }[];
  return rows.map((r) => r.id);
}

// Profile payload for /me: persists the avatar colour on first read.
function userProfilePayload(db: DB, user: { id: string; username: string; display_name?: string | null; avatar_color?: string | null }) {
  const profile = profileService.ensureProfile(db, user);
  return { id: user.id, username: user.username, displayName: profile.displayName, avatarColor: profile.avatarColor };
}

function statsForSession(db: DB, s: { id: string; user_id: string | null }) {
  return historyService.statsForUser(db, s.user_id, sessionPlayerIds(db, s.id));
}

export { sessionMiddleware, csrfCheck, clearRateLimits, rateLimitOr429 };

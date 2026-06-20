import { Hono } from "hono";
import * as svc from "../services/multiplayer.service";
import { mintRoomToken, ROOM_TOKEN_TTL_SECONDS } from "../crypto/room-token";
import { rateLimit } from "../middleware/rate-limit";
import type { TurnStrategy } from "../types/multiplayer";
import { mpidConfig } from "../multiplayer/config";
import * as identityClient from "../multiplayer/identity-client";
import * as relayClient from "../multiplayer/relay-client";

const app = new Hono();

// Creating rooms and minting invite tokens are privileged + abusable, so they
// get their own token bucket (per IP) on top of the global auth gate.
const roomMutationLimiter = rateLimit({
  bucket: "multiplayer-mutate",
  max: 30,
  windowMs: 60 * 1000,
  message: "Too many multiplayer requests. Slow down for a moment.",
});

function normalizeStrategy(raw: unknown): TurnStrategy | undefined {
  return raw === "freeform" ? "freeform" : raw === "round_robin" ? "round_robin" : undefined;
}

/** Create a room on a chat the caller owns. */
app.post("/rooms", roomMutationLimiter, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const chatId = typeof body.chat_id === "string" ? body.chat_id : "";
  if (!chatId) return c.json({ error: "chat_id is required" }, 400);

  // Forks the source chat and creates the room on the fork (original preserved).
  const result = svc.forkAndCreateRoom(userId, chatId, {
    turnStrategy: normalizeStrategy(body.turn_strategy),
    settings: typeof body.settings === "object" && body.settings ? body.settings : undefined,
  });
  if ("error" in result) {
    if (result.error === "chat_not_found") return c.json({ error: "Chat not found" }, 404);
    if (result.error === "fork_failed") return c.json({ error: "Could not fork the chat" }, 500);
    return c.json({ error: "A room already exists for this chat" }, 409);
  }
  return c.json(svc.getRoomStateForHost(userId, result.room.id), 201);
});

/** Look up the room bound to a chat (host view), if any. */
app.get("/rooms/by-chat/:chatId", (c) => {
  const userId = c.get("userId");
  const room = svc.getRoomByChatId(c.req.param("chatId"));
  if (!room || room.host_user_id !== userId) return c.json({ room: null });
  return c.json({ room: svc.getRoomStateForHost(userId, room.id) });
});

app.get("/rooms/:roomId", (c) => {
  const userId = c.get("userId");
  const state = svc.getRoomStateForHost(userId, c.req.param("roomId"));
  if (!state) return c.json({ error: "Not found" }, 404);
  return c.json(state);
});

app.get("/rooms/:roomId/participants", (c) => {
  const userId = c.get("userId");
  const state = svc.getRoomStateForHost(userId, c.req.param("roomId"));
  if (!state) return c.json({ error: "Not found" }, 404);
  return c.json({ participants: state.participants });
});

app.patch("/rooms/:roomId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const room = svc.updateRoom(userId, c.req.param("roomId"), {
    status: body.status === "open" || body.status === "locked" ? body.status : undefined,
    turnStrategy: normalizeStrategy(body.turn_strategy),
    settings: typeof body.settings === "object" && body.settings ? body.settings : undefined,
  });
  if (!room) return c.json({ error: "Not found" }, 404);
  return c.json(svc.getRoomStateForHost(userId, room.id));
});

app.post("/rooms/:roomId/close", async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const ok = svc.closeRoom(userId, roomId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  // Tear down any remote bridge + Identity Server registration (best-effort).
  relayClient.stopRelayBridge(roomId);
  await identityClient.closeRoom(roomId);
  return c.json({ ok: true });
});

// ── Remote multiplayer (Identity Server) ──

/** Register the room with the Identity Server + open the outbound relay bridge. */
app.post("/rooms/:roomId/remote/enable", roomMutationLimiter, async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  if (!svc.getRoomStateForHost(userId, roomId)) return c.json({ error: "Not found" }, 404);
  if (!mpidConfig.enabled) {
    return c.json({ error: "Remote multiplayer is not configured (set MPIDENTITY_URL)" }, 400);
  }
  const registered = await identityClient.registerRoom(roomId, {
    reachability: "relay-only",
    maxPeers: svc.getRoom(roomId)?.settings.maxPeers,
  });
  if (!registered) return c.json({ error: "Identity Server unreachable" }, 502);
  await relayClient.startRelayBridge(roomId);
  return c.json({ ok: true, server: mpidConfig.url });
});

/** Mint a rolling one-time invite code via the Identity Server. */
app.post("/rooms/:roomId/remote/invite", roomMutationLimiter, async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  if (!svc.getRoomStateForHost(userId, roomId)) return c.json({ error: "Not found" }, 404);
  const invite = await identityClient.createInvite(roomId);
  if (!invite) return c.json({ error: "Could not create remote invite" }, 502);
  return c.json({ ...invite, server: mpidConfig.url });
});

/**
 * Peer side: redeem an invite code via the configured Identity Server and
 * return the JoinGrant (relay URL + peer token) so the frontend can connect to
 * the relay. Proxied so the browser never calls the Identity Server directly.
 */
app.post("/join", roomMutationLimiter, async (c) => {
  if (!mpidConfig.enabled) {
    return c.json({ error: "Remote multiplayer is not configured (set MPIDENTITY_URL)" }, 400);
  }
  const body = await c.req.json().catch(() => ({}) as any);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return c.json({ error: "code is required" }, 400);
  const grant = await identityClient.redeemInvite(code, {
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
  });
  if (!grant) return c.json({ error: "Invalid or expired invite" }, 403);
  return c.json(grant);
});

/** Tear down the remote bridge + Identity Server registration. */
app.post("/rooms/:roomId/remote/disable", async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  if (!svc.getRoomStateForHost(userId, roomId)) return c.json({ error: "Not found" }, 404);
  relayClient.stopRelayBridge(roomId);
  await identityClient.closeRoom(roomId);
  return c.json({ ok: true });
});

/** Mint a single host-issued room access token (Phase 1 invite material). */
app.post("/rooms/:roomId/invite", roomMutationLimiter, async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  // Only the host may mint tokens for the room.
  const state = svc.getRoomStateForHost(userId, roomId);
  if (!state) return c.json({ error: "Not found" }, 404);

  const subject = crypto.randomUUID();
  const token = await mintRoomToken({ roomId, subject });
  return c.json({
    token,
    roomId,
    expiresAt: Math.floor(Date.now() / 1000) + ROOM_TOKEN_TTL_SECONDS,
  });
});

// ── Host turn controls (REST fallbacks for the WS-driven actions) ──

app.post("/rooms/:roomId/turn/promote", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const ok = svc.hostPromote(userId, c.req.param("roomId"), String(body.participant_id ?? ""));
  return c.json({ ok }, ok ? 200 : 400);
});

app.post("/rooms/:roomId/turn/skip", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const ok = svc.hostSkip(userId, c.req.param("roomId"), String(body.participant_id ?? ""));
  return c.json({ ok }, ok ? 200 : 400);
});

app.post("/rooms/:roomId/participants/:participantId/kick", (c) => {
  const userId = c.get("userId");
  const ok = svc.hostKick(userId, c.req.param("roomId"), c.req.param("participantId"));
  return c.json({ ok }, ok ? 200 : 400);
});

app.post("/rooms/:roomId/participants/:participantId/ban", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const ok = svc.hostBan(
    userId,
    c.req.param("roomId"),
    c.req.param("participantId"),
    typeof body.reason === "string" ? body.reason : undefined,
  );
  return c.json({ ok }, ok ? 200 : 400);
});

// ── Freeform window controls ──

app.post("/rooms/:roomId/freeform/start", (c) => {
  const userId = c.get("userId");
  const room = svc.openFreeformWindow(userId, c.req.param("roomId"));
  if (!room) return c.json({ error: "Not found or not a freeform room" }, 400);
  return c.json({ ok: true, deadline: room.freeform_deadline });
});

app.post("/rooms/:roomId/freeform/end", (c) => {
  const userId = c.get("userId");
  const ok = svc.endFreeformWindow(userId, c.req.param("roomId"));
  return c.json({ ok }, ok ? 200 : 400);
});

/**
 * Peer side: record a room the user joined as a local chat in their own history
 * (so it shows in recent/manage chats), seeded with the snapshot.
 */
app.post("/shadow", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}) as any);
  if (typeof body.chatId !== "string" || typeof body.roomId !== "string") {
    return c.json({ error: "chatId and roomId are required" }, 400);
  }
  const reconnectToken = typeof body.reconnectToken === "string" ? body.reconnectToken : undefined;
  const res = svc.ensureJoinedRoomChat(userId, {
    chatId: body.chatId,
    roomId: body.roomId,
    name: typeof body.name === "string" ? body.name : undefined,
    characterName: typeof body.characterName === "string" ? body.characterName : undefined,
    messages: Array.isArray(body.messages) ? body.messages : undefined,
    reconnectToken,
    // Record which server holds the room (only meaningful with a reconnect token).
    server: reconnectToken ? mpidConfig.url : undefined,
  });
  return c.json(res);
});

/**
 * Peer side: rejoin a previously-joined remote room from history using the
 * durable reconnect token stored on the shadow chat — no new invite code
 * needed. The token never leaves the server here; the browser only sends the
 * chat id. Returns a fresh JoinGrant (relay URL + peer token) for the frontend
 * to connect to the relay, exactly like `/join`.
 */
app.post("/reconnect", roomMutationLimiter, async (c) => {
  if (!mpidConfig.enabled) {
    return c.json({ error: "Remote multiplayer is not configured (set MPIDENTITY_URL)" }, 400);
  }
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}) as any);
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  if (!chatId) return c.json({ error: "chatId is required" }, 400);

  const stored = svc.getJoinedRoomReconnect(userId, chatId);
  if (!stored?.reconnectToken) {
    return c.json({ error: "This room can't be rejoined automatically — ask the host for a new invite" }, 409);
  }

  const grant = await identityClient.reconnect(stored.reconnectToken);
  if (!grant) {
    return c.json({ error: "Could not rejoin — the room may be closed, or you were removed" }, 403);
  }

  // Persist the refreshed (sliding-expiry) reconnect token for next time.
  if (grant.reconnectToken) {
    svc.ensureJoinedRoomChat(userId, { chatId, roomId: grant.roomId, reconnectToken: grant.reconnectToken });
  }
  return c.json(grant);
});

export { app as multiplayerRoutes };

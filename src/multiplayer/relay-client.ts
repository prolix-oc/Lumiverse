/**
 * Host-side relay bridge. The host connects OUTBOUND to the Identity Server's
 * relay (so it never needs inbound exposure) and bridges:
 *   - relay frames from remote peers → multiplayer service actions
 *   - the room's broadcast stream (lifecycle + feed) → relay frames to peers
 *
 * Remote peers are ordinary `token` participants in the host's room — the
 * multiplayer service is transport-agnostic, so turn rules, bans, and the
 * submit gate all apply identically whether a peer is local-WS or relayed.
 */

import { mpidConfig } from "./config";
import { deriveRoomSecret } from "./room-secret";
import { mintHostToken } from "./mpid-token";
import * as identityClient from "./identity-client";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as mp from "../services/multiplayer.service";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
// App-level keepalive. Mobile/cellular NAT silently drops idle connections
// (often within ~30s) and Termux/Doze can freeze the socket, leaving a HALF-OPEN
// connection that never fires `onclose` — the host then keeps "sending" into the
// void and every peer desyncs. A short ping keeps the NAT mapping warm; the
// server's pong proves it's still reachable. If no frame arrives within the
// liveness window we force a reconnect instead of silently desyncing.
const HEARTBEAT_MS = 20_000;
const LIVENESS_TIMEOUT_MS = 60_000;
// Refresh the room's control-plane liveness (rooms.last_heartbeat) over HTTP,
// independent of the relay WS — so the Identity Server's view of the room stays
// current even across WS reconnects.
const ROOM_HEARTBEAT_MS = 60_000;

interface Bridge {
  roomId: string;
  chatId: string;
  ws: WebSocket | null;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  roomHeartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Epoch ms of the last frame received from the relay (any frame, incl. pong). */
  lastFrameAt: number;
  stopped: boolean;
  memberToParticipant: Map<string, string>;
  unsubs: Array<() => void>;
}

const bridges = new Map<string, Bridge>();

export function isRemoteBridgeActive(roomId: string): boolean {
  return bridges.has(roomId);
}

export async function startRelayBridge(roomId: string): Promise<boolean> {
  if (!mpidConfig.enabled) return false;
  if (bridges.has(roomId)) return true;
  const room = mp.getRoom(roomId);
  if (!room) return false;

  const bridge: Bridge = {
    roomId,
    chatId: room.chat_id,
    ws: null,
    reconnectMs: INITIAL_RECONNECT_MS,
    reconnectTimer: null,
    heartbeatTimer: null,
    roomHeartbeatTimer: null,
    lastFrameAt: 0,
    stopped: false,
    memberToParticipant: new Map(),
    unsubs: [],
  };
  bridges.set(roomId, bridge);

  // Mirror the room's full broadcast stream to remote peers.
  bridge.unsubs.push(
    eventBus.onRoomBroadcast((rid, event, payload) => {
      if (rid !== bridge.roomId) return;
      sendFrame(bridge, { v: 1, t: "msg", d: { event, payload } });
    }),
  );

  // Keep the room's control-plane liveness + capacity fresh on the Identity
  // Server (so a later maxPeers change propagates).
  const roomHb = setInterval(() => {
    void identityClient.heartbeat(bridge.roomId, undefined, undefined, mp.getRoom(bridge.roomId)?.settings.maxPeers);
  }, ROOM_HEARTBEAT_MS);
  if (typeof (roomHb as { unref?: () => void }).unref === "function") {
    (roomHb as { unref: () => void }).unref();
  }
  bridge.roomHeartbeatTimer = roomHb;

  await connect(bridge);
  return true;
}

export function stopRelayBridge(roomId: string): void {
  const bridge = bridges.get(roomId);
  if (!bridge) return;
  bridge.stopped = true;
  if (bridge.reconnectTimer) clearTimeout(bridge.reconnectTimer);
  if (bridge.roomHeartbeatTimer) clearInterval(bridge.roomHeartbeatTimer);
  stopHeartbeat(bridge);
  for (const unsub of bridge.unsubs) unsub();
  try {
    bridge.ws?.close();
  } catch {
    /* already closed */
  }
  bridges.delete(roomId);
}

async function connect(bridge: Bridge): Promise<void> {
  if (bridge.stopped) return;
  try {
    const secret = await deriveRoomSecret(bridge.roomId);
    const token = await mintHostToken(bridge.roomId, secret, mpidConfig.url, 300);
    const url = `${mpidConfig.relayWsUrl}?token=${encodeURIComponent(token)}&role=host`;
    const ws = new WebSocket(url);
    bridge.ws = ws;
    ws.onopen = () => {
      if (bridge.ws !== ws) return; // superseded by a newer connection
      bridge.reconnectMs = INITIAL_RECONNECT_MS;
      startHeartbeat(bridge);
      // After a reconnect, peers may have missed events during the outage —
      // resend each a fresh room snapshot so they re-sync (no-op on first
      // connect: no peers materialized yet).
      rehydratePeers(bridge);
      console.log(`[mp-remote] relay bridge connected for room ${bridge.roomId}`);
    };
    ws.onmessage = (e) => {
      if (bridge.ws !== ws) return;
      bridge.lastFrameAt = Date.now(); // any frame (incl. pong) proves liveness
      handleRelayFrame(bridge, typeof e.data === "string" ? e.data : String(e.data));
    };
    ws.onclose = () => {
      if (bridge.ws !== ws) return; // ignore a stale socket's late close
      bridge.ws = null;
      stopHeartbeat(bridge);
      if (!bridge.stopped) scheduleReconnect(bridge);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  } catch (err) {
    console.warn("[mp-remote] relay connect failed:", err instanceof Error ? err.message : err);
    scheduleReconnect(bridge);
  }
}

function scheduleReconnect(bridge: Bridge): void {
  if (bridge.reconnectTimer || bridge.stopped) return;
  bridge.reconnectTimer = setTimeout(() => {
    bridge.reconnectTimer = null;
    connect(bridge).catch(() => scheduleReconnect(bridge));
  }, bridge.reconnectMs);
  if (typeof (bridge.reconnectTimer as { unref?: () => void }).unref === "function") {
    (bridge.reconnectTimer as { unref: () => void }).unref();
  }
  bridge.reconnectMs = Math.min(bridge.reconnectMs * 2, MAX_RECONNECT_MS);
}

function startHeartbeat(bridge: Bridge): void {
  stopHeartbeat(bridge);
  bridge.lastFrameAt = Date.now();
  const timer = setInterval(() => {
    const ws = bridge.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // No frame (not even a pong) within the liveness window → the connection is
    // dead (typically half-open on mobile/Termux). Tear it down + reconnect
    // rather than keep streaming into a black hole.
    if (Date.now() - bridge.lastFrameAt > LIVENESS_TIMEOUT_MS) {
      console.warn(`[mp-remote] relay bridge stale for room ${bridge.roomId} — forcing reconnect`);
      forceReconnect(bridge);
      return;
    }
    sendFrame(bridge, { v: 1, t: "ctrl", d: { type: "ping" } });
  }, HEARTBEAT_MS);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  bridge.heartbeatTimer = timer;
}

function stopHeartbeat(bridge: Bridge): void {
  if (bridge.heartbeatTimer) {
    clearInterval(bridge.heartbeatTimer);
    bridge.heartbeatTimer = null;
  }
}

/** Re-send the room snapshot to every peer we've materialized, so they re-sync
 *  after a bridge reconnect (each gets their own selfParticipantId; the relay
 *  drops sends to members who have since left). */
function rehydratePeers(bridge: Bridge): void {
  if (bridge.memberToParticipant.size === 0) return;
  const room = mp.getRoom(bridge.roomId);
  if (!room) return;
  for (const [memberId, participantId] of bridge.memberToParticipant) {
    sendFrame(bridge, {
      v: 1,
      t: "msg",
      to: memberId,
      d: { event: "ROOM_STATUS", payload: mp.buildHydrationPayload(room, participantId) },
    });
  }
}

/** Tear down a (likely dead) socket and reconnect, without waiting on onclose —
 *  a half-open socket may never fire it. */
function forceReconnect(bridge: Bridge): void {
  const ws = bridge.ws;
  bridge.ws = null;
  stopHeartbeat(bridge);
  try {
    ws?.close();
  } catch {
    /* already dead */
  }
  if (!bridge.stopped) scheduleReconnect(bridge);
}

function sendFrame(bridge: Bridge, frame: { v: 1; t: string; d: unknown; to?: string }): void {
  const ws = bridge.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket closing */
  }
}

/** A frame arrived from a remote peer (relay stamps `from` = memberId). */
function handleRelayFrame(bridge: Bridge, raw: string): void {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (!frame || frame.v !== 1) return;

  // Server→host control frames carry no `from`. Currently: an invite was
  // redeemed → roll a fresh code so the host always has an unused one to share.
  if (frame.t === "ctrl") {
    const d = frame.d as Record<string, any> | undefined;
    if (d?.type === "invite_consumed") void cycleInviteCode(bridge.roomId);
    return;
  }

  if (typeof frame.from !== "string") return;
  const memberId = frame.from;
  const d = frame.d as Record<string, any> | undefined;
  if (!d || typeof d.type !== "string") return;

  // Lazily materialize the remote member as a room participant.
  let participantId = bridge.memberToParticipant.get(memberId);
  if (!participantId) {
    const join = mp.joinByToken(bridge.roomId, memberId, {
      displayName: typeof d.displayName === "string" ? d.displayName : undefined,
      persona: d.persona,
    });
    if (!join.ok) {
      // Tell the peer WHY (full / closed / banned) instead of dropping silently,
      // so they don't sit "connected but never in the room".
      sendFrame(bridge, {
        v: 1,
        t: "msg",
        to: memberId,
        d: { event: "ROOM_JOIN_REJECTED", payload: { roomId: bridge.roomId, reason: join.reason } },
      });
      return;
    }
    participantId = join.participant.id;
    bridge.memberToParticipant.set(memberId, participantId);
  }

  // A peer announcing itself → unicast the room snapshot + message history back
  // (the broadcast ROOM_PARTICIPANT_JOINED reaches everyone else separately).
  if (d.type === "room_join") {
    const room = mp.getRoom(bridge.roomId);
    if (room) {
      sendFrame(bridge, {
        v: 1,
        t: "msg",
        to: memberId,
        d: { event: "ROOM_STATUS", payload: mp.buildHydrationPayload(room, participantId) },
      });
    }
    return;
  }

  switch (d.type) {
    case "room_message":
      mp.submitPeerMessage(bridge.roomId, participantId, d.content);
      break;
    case "room_typing":
      mp.markTyping(bridge.roomId, participantId, !!d.typing);
      break;
    case "room_persona_change":
      mp.updateParticipantPersona(bridge.roomId, participantId, d.persona);
      break;
    case "room_persona_lorebook":
      mp.updateParticipantLorebook(bridge.roomId, participantId, d.lorebook);
      break;
    case "room_pass_turn":
      mp.passTurn(bridge.roomId, participantId);
      break;
    case "room_leave":
      mp.leaveParticipant(bridge.roomId, participantId);
      bridge.memberToParticipant.delete(memberId);
      break;
    default:
      break; // unknown action — ignore
  }
}

/**
 * A peer redeemed the host's one-time code → mint a fresh one and push it to the
 * host's OWN frontend (host user topic only — never the room, so peers never see
 * invite codes). Best-effort: if the Identity Server is unreachable, the host's
 * displayed code simply stays until it's regenerated manually.
 */
async function cycleInviteCode(roomId: string): Promise<void> {
  const room = mp.getRoom(roomId);
  if (!room) return;
  const invite = await identityClient.createInvite(roomId);
  if (!invite) return;
  eventBus.emit(
    EventType.ROOM_INVITE_CODE,
    { roomId, code: invite.code, expiresAt: invite.expiresAt, server: mpidConfig.url },
    room.host_user_id,
  );
}

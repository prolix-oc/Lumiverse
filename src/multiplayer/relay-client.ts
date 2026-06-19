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
import { eventBus } from "../ws/bus";
import * as mp from "../services/multiplayer.service";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

interface Bridge {
  roomId: string;
  chatId: string;
  ws: WebSocket | null;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
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

  await connect(bridge);
  return true;
}

export function stopRelayBridge(roomId: string): void {
  const bridge = bridges.get(roomId);
  if (!bridge) return;
  bridge.stopped = true;
  if (bridge.reconnectTimer) clearTimeout(bridge.reconnectTimer);
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
      bridge.reconnectMs = INITIAL_RECONNECT_MS;
      console.log(`[mp-remote] relay bridge connected for room ${bridge.roomId}`);
    };
    ws.onmessage = (e) => handleRelayFrame(bridge, typeof e.data === "string" ? e.data : String(e.data));
    ws.onclose = () => {
      bridge.ws = null;
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
  if (!frame || frame.v !== 1 || typeof frame.from !== "string") return;
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
    if (!join.ok) return;
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

/**
 * Multiplayer rooms service — the host-authoritative core.
 *
 * A "room" IS the host's chat. This service is a TRUSTED BROKER: it accepts an
 * untrusted peer action over the WS layer, authorizes it against room / turn /
 * ban state, then performs the privileged write AS THE HOST via the existing
 * `chatsSvc.createMessage(...)` / `generateSvc.startGeneration(...)`. Every
 * existing per-user ownership check therefore keeps working unchanged, and a
 * peer can never escalate beyond the narrow surface exposed here.
 *
 * Real-time fan-out: peer chat messages and bot stream tokens reuse the
 * existing MESSAGE_SENT / STREAM_TOKEN_RECEIVED / GENERATION_* events; an
 * in-process listener (registered in `initMultiplayer`) re-broadcasts them to
 * the `room:{roomId}` topic via `eventBus.publishToRoom`, which does NOT fire
 * in-process listeners (so re-broadcasting cannot recurse).
 */

import { Buffer } from "node:buffer";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chatsSvc from "./chats.service";
import * as generateSvc from "./generate.service";
import { setMultiplayerPersonaProvider } from "./prompt-assembly.service";
import { mpidConfig } from "../multiplayer/config";
import type { Message } from "../types/message";
import {
  type Room,
  type RoomSettings,
  type RoomStatus,
  type TurnStrategy,
  type Participant,
  type ParticipantRole,
  type ParticipantView,
  type RoomStateView,
  type PersonaSnapshot,
  type JoinProfile,
  type IdentityKind,
  HARD_MAX_PEERS,
  DEFAULT_FREEFORM_WINDOW_SEC,
  MIN_FREEFORM_WINDOW_SEC,
  MAX_FREEFORM_WINDOW_SEC,
  MAX_DISPLAY_NAME_LEN,
  MAX_PERSONA_NAME_LEN,
  MAX_PERSONA_DESCRIPTION_LEN,
  MAX_ROOM_MESSAGE_BYTES,
  MAX_AVATAR_URL_LEN,
  MAX_AVATAR_DATA_URL_LEN,
} from "../types/multiplayer";

// ─── result types ─────────────────────────────────────────────────────────────

export type JoinResult =
  | { ok: true; room: Room; participant: Participant }
  | { ok: false; reason: "not_found" | "closed" | "banned" | "full" | "invalid" };

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_your_turn" | "closed" | "kicked" | "invalid" | "too_large" };

const HYDRATION_MESSAGE_TAIL = 100;

// ─── row mapping ────────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeSettings(raw: unknown): RoomSettings {
  const obj = parseJson<Partial<RoomSettings>>(raw, {});
  const maxPeers = clampInt(obj.maxPeers ?? HARD_MAX_PEERS, 1, HARD_MAX_PEERS);
  const freeformWindowSec = clampInt(
    obj.freeformWindowSec ?? DEFAULT_FREEFORM_WINDOW_SEC,
    MIN_FREEFORM_WINDOW_SEC,
    MAX_FREEFORM_WINDOW_SEC,
  );
  return { maxPeers, freeformWindowSec };
}

function rowToRoom(row: any): Room {
  return {
    id: row.id,
    chat_id: row.chat_id,
    host_user_id: row.host_user_id,
    status: row.status as RoomStatus,
    turn_strategy: row.turn_strategy as TurnStrategy,
    freeform_deadline: row.freeform_deadline ?? null,
    turn_order: parseJson<string[]>(row.turn_order, []),
    current_turn_participant_id: row.current_turn_participant_id ?? null,
    turn_index: row.turn_index ?? 0,
    round_counter: row.round_counter ?? 0,
    settings: normalizeSettings(row.settings),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToParticipant(row: any): Participant {
  return {
    id: row.id,
    room_id: row.room_id,
    role: row.role as ParticipantRole,
    identity_kind: row.identity_kind as IdentityKind,
    identity_ref: row.identity_ref,
    display_name: row.display_name ?? "",
    persona_snapshot: parseJson<PersonaSnapshot | null>(row.persona_snapshot, null),
    status: row.status,
    joined_at: row.joined_at,
    last_seen: row.last_seen,
  };
}

// ─── validation / sanitization of UNTRUSTED peer input ──────────────────────────

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, n));
}

/** Strip control chars + angle brackets (no legit use in a name) and clamp. */
function sanitizeDisplayName(raw: unknown, max = MAX_DISPLAY_NAME_LEN): string {
  if (typeof raw !== "string") return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F<>]/g, "")
    .trim()
    .slice(0, max);
}

/** Clamp persona description, drop NUL/angle brackets, keep newlines. */
function sanitizePersonaText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F<>]/g, "")
    .slice(0, max);
}

/**
 * Avatar URLs are SERVER-issued (the host/Identity Server re-hosts the WebP and
 * returns the URL). Only accept same-origin relative API paths — never an
 * absolute URL, `javascript:`/`data:` scheme, or anything with a host. Anything
 * else collapses to null so a peer can't smuggle an active-content URL.
 */
function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Embedded compressed raster avatar (broadcast so every client can render a
  // peer's persona avatar — persona-avatar URLs are user-scoped and not
  // cross-fetchable). webp/png/jpeg ONLY — never svg (script execution risk).
  if (raw.startsWith("data:")) {
    if (raw.length <= MAX_AVATAR_DATA_URL_LEN && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
      return raw;
    }
    return null;
  }
  if (raw.length > MAX_AVATAR_URL_LEN) return null;
  // Same-origin host API path (Phase-1 local avatars).
  if (/^\/api\/v1\/[A-Za-z0-9/_.\-]+(\?[A-Za-z0-9=&_.\-]*)?$/.test(raw)) return raw;
  // The configured Identity Server's content-addressed avatar path (remote
  // peers re-host their WebP there). Origin must match exactly; path is a fixed
  // /avatars/<sha256> shape — no room for an active-content URL.
  if (mpidConfig.enabled && raw.startsWith(`${mpidConfig.url}/avatars/`) && /^https?:\/\/[^/]+\/avatars\/[0-9a-f]{64}$/.test(raw)) {
    return raw;
  }
  return null;
}

function sanitizePersonaSnapshot(raw: unknown): PersonaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = sanitizeDisplayName(obj.name, MAX_PERSONA_NAME_LEN);
  if (!name) return null;
  const snapshot: PersonaSnapshot = { name };
  const description = sanitizePersonaText(obj.description, MAX_PERSONA_DESCRIPTION_LEN);
  if (description) snapshot.description = description;
  if (obj.pronouns && typeof obj.pronouns === "object") {
    const p = obj.pronouns as Record<string, unknown>;
    snapshot.pronouns = {
      subjective: sanitizeDisplayName(p.subjective, 24) || undefined,
      objective: sanitizeDisplayName(p.objective, 24) || undefined,
      possessive: sanitizeDisplayName(p.possessive, 24) || undefined,
    };
  }
  const avatarUrl = sanitizeAvatarUrl(obj.avatarUrl);
  if (avatarUrl) snapshot.avatarUrl = avatarUrl;
  return snapshot;
}

// ─── chat → room id routing cache (hot path: stream-token fan-out) ──────────────

const chatRoomIdCache = new Map<string, string | null>();

/** Returns the OPEN/locked room id for a chat (cached), or null if not a room. */
export function getRoomIdForChat(chatId: string): string | null {
  const cached = chatRoomIdCache.get(chatId);
  if (cached !== undefined) return cached;
  try {
    const row = getDb()
      .query("SELECT id FROM multiplayer_rooms WHERE chat_id = ? AND status != 'closed'")
      .get(chatId) as { id: string } | null;
    const roomId = row?.id ?? null;
    chatRoomIdCache.set(chatId, roomId);
    return roomId;
  } catch {
    // The multiplayer_rooms table may be absent (e.g. a partially-migrated test
    // DB). Treat the chat as non-multiplayer rather than breaking the prompt
    // assembly / fan-out paths that call this on every chat.
    return null;
  }
}

function invalidateChatRoute(chatId: string): void {
  chatRoomIdCache.delete(chatId);
}

// ─── room lookups ───────────────────────────────────────────────────────────────

export function getRoom(roomId: string): Room | null {
  const row = getDb().query("SELECT * FROM multiplayer_rooms WHERE id = ?").get(roomId);
  return row ? rowToRoom(row) : null;
}

export function getRoomByChatId(chatId: string): Room | null {
  const row = getDb()
    .query("SELECT * FROM multiplayer_rooms WHERE chat_id = ? AND status != 'closed'")
    .get(chatId);
  return row ? rowToRoom(row) : null;
}

export function getParticipant(participantId: string): Participant | null {
  const row = getDb().query("SELECT * FROM multiplayer_participants WHERE id = ?").get(participantId);
  return row ? rowToParticipant(row) : null;
}

export function listParticipants(roomId: string, opts?: { activeOnly?: boolean }): Participant[] {
  const sql = opts?.activeOnly
    ? "SELECT * FROM multiplayer_participants WHERE room_id = ? AND status = 'active' ORDER BY joined_at ASC"
    : "SELECT * FROM multiplayer_participants WHERE room_id = ? ORDER BY joined_at ASC";
  return (getDb().query(sql).all(roomId) as any[]).map(rowToParticipant);
}

function isBanned(roomId: string, identityKind: IdentityKind, identityRef: string): boolean {
  const row = getDb()
    .query("SELECT 1 FROM multiplayer_bans WHERE room_id = ? AND identity_kind = ? AND identity_ref = ?")
    .get(roomId, identityKind, identityRef);
  return !!row;
}

// ─── views / payloads ───────────────────────────────────────────────────────────

function toParticipantView(p: Participant, currentTurnId: string | null): ParticipantView {
  return {
    id: p.id,
    role: p.role,
    displayName: p.display_name,
    persona: p.persona_snapshot,
    status: p.status,
    isCurrentTurn: p.id === currentTurnId,
  };
}

export function buildRoomStateView(
  room: Room,
  opts?: { hostView?: boolean; selfParticipantId?: string },
): RoomStateView {
  const participants = listParticipants(room.id, { activeOnly: true }).map((p) =>
    toParticipantView(p, room.current_turn_participant_id),
  );
  const view: RoomStateView = {
    roomId: room.id,
    chatId: room.chat_id,
    status: room.status,
    turnStrategy: room.turn_strategy,
    freeformDeadline: room.freeform_deadline,
    currentTurnParticipantId: room.current_turn_participant_id,
    turnOrder: room.turn_order,
    round: room.round_counter,
    participants,
  };
  if (opts?.selfParticipantId) view.selfParticipantId = opts.selfParticipantId;
  if (opts?.hostView) {
    view.hostUserId = room.host_user_id;
    view.settings = room.settings;
  }
  return view;
}

function basePayload(room: Room): { chatId: string; roomId: string } {
  return { chatId: room.chat_id, roomId: room.id };
}

function emitTurnChanged(room: Room, extra?: Record<string, unknown>): void {
  eventBus.publishToRoom(room.id, EventType.ROOM_TURN_CHANGED, {
    ...basePayload(room),
    turnStrategy: room.turn_strategy,
    currentTurnParticipantId: room.current_turn_participant_id,
    turnOrder: room.turn_order,
    round: room.round_counter,
    freeformDeadline: room.freeform_deadline,
    ...extra,
  });
}

// ─── room CRUD ──────────────────────────────────────────────────────────────────

export function createRoom(
  hostUserId: string,
  chatId: string,
  opts: { turnStrategy?: TurnStrategy; settings?: Partial<RoomSettings> } = {},
): Room | { error: "chat_not_found" | "already_exists" } {
  // Host must own the chat.
  const chat = chatsSvc.getChat(hostUserId, chatId);
  if (!chat) return { error: "chat_not_found" };

  const existing = getDb()
    .query("SELECT id FROM multiplayer_rooms WHERE chat_id = ?")
    .get(chatId) as { id: string } | null;
  if (existing) return { error: "already_exists" };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const turnStrategy: TurnStrategy = opts.turnStrategy === "freeform" ? "freeform" : "round_robin";
  const settings = normalizeSettings({
    maxPeers: opts.settings?.maxPeers,
    freeformWindowSec: opts.settings?.freeformWindowSec,
  });

  // Seed a host participant. The host's turn slot is first in the order.
  const hostParticipantId = crypto.randomUUID();

  getDb().transaction(() => {
    getDb()
      .query(
        `INSERT INTO multiplayer_rooms
           (id, chat_id, host_user_id, status, turn_strategy, turn_order, turn_index, round_counter, settings, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, 0, 0, ?, ?, ?)`,
      )
      .run(id, chatId, hostUserId, turnStrategy, JSON.stringify([hostParticipantId]), JSON.stringify(settings), now, now);

    getDb()
      .query(
        `INSERT INTO multiplayer_participants
           (id, room_id, role, identity_kind, identity_ref, display_name, persona_snapshot, status, joined_at, last_seen)
         VALUES (?, ?, 'host', 'user', ?, ?, '{}', 'active', ?, ?)`,
      )
      .run(hostParticipantId, id, hostUserId, "", now, now);
  })();

  // Mark the chat so the normal chat-open path can detect a room cheaply.
  chatsSvc.mergeChatMetadata(hostUserId, chatId, { multiplayer_room_id: id });
  invalidateChatRoute(chatId);

  const room = getRoom(id)!;
  // For round-robin, set the host as the opening turn.
  if (room.turn_strategy === "round_robin") {
    setCurrentTurn(room, 0);
  }
  return getRoom(id)!;
}

/**
 * Fork the host's current chat into a NEW chat and create the room on the fork
 * (the original chat is left untouched). Branching at the last message gives a
 * full copy of the conversation. The fork is named + flagged as a multiplayer
 * chat so pickers can badge it.
 */
export function forkAndCreateRoom(
  hostUserId: string,
  sourceChatId: string,
  opts: { turnStrategy?: TurnStrategy; settings?: Partial<RoomSettings> } = {},
): { room: Room; chatId: string } | { error: "chat_not_found" | "fork_failed" | "already_exists" } {
  const source = chatsSvc.getChat(hostUserId, sourceChatId);
  if (!source) return { error: "chat_not_found" };

  const messages = chatsSvc.getMessages(hostUserId, sourceChatId);
  let forkedChatId: string;
  if (messages.length > 0) {
    const forked = chatsSvc.branchChat(hostUserId, sourceChatId, messages[messages.length - 1].id);
    if (!forked) return { error: "fork_failed" };
    forkedChatId = forked.id;
  } else {
    // No messages to branch — make an empty copy with the same character.
    const copy = chatsSvc.createChat(hostUserId, {
      character_id: source.character_id,
      name: source.name,
    });
    forkedChatId = copy.id;
  }

  // Name it clearly + persistently flag it as a multiplayer chat (separate from
  // multiplayer_room_id, which tracks the *active* room and is cleared on close).
  const base = (source.name || "Chat")
    .replace(/\s+—\s+Branch.*$/i, "")
    .replace(/\s+\(Multiplayer\)$/i, "");
  chatsSvc.updateChat(hostUserId, forkedChatId, { name: `${base} (Multiplayer)` });
  chatsSvc.mergeChatMetadata(hostUserId, forkedChatId, { multiplayer: true });

  const room = createRoom(hostUserId, forkedChatId, opts);
  if ("error" in room) return room;
  return { room, chatId: forkedChatId };
}

export function getRoomStateForHost(hostUserId: string, roomId: string): RoomStateView | null {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId) return null;
  const hostParticipant = listParticipants(roomId).find(
    (p) => p.identity_kind === "user" && p.identity_ref === hostUserId,
  );
  return buildRoomStateView(room, { hostView: true, selfParticipantId: hostParticipant?.id });
}

export function updateRoom(
  hostUserId: string,
  roomId: string,
  patch: { status?: RoomStatus; turnStrategy?: TurnStrategy; settings?: Partial<RoomSettings> },
): Room | null {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId) return null;

  const now = Math.floor(Date.now() / 1000);
  const status = patch.status ?? room.status;
  const turnStrategy = patch.turnStrategy ?? room.turn_strategy;
  const settings = patch.settings
    ? normalizeSettings({ ...room.settings, ...patch.settings })
    : room.settings;

  getDb()
    .query(
      "UPDATE multiplayer_rooms SET status = ?, turn_strategy = ?, settings = ?, updated_at = ? WHERE id = ?",
    )
    .run(status, turnStrategy, JSON.stringify(settings), now, roomId);

  invalidateChatRoute(room.chat_id);
  const updated = getRoom(roomId)!;
  eventBus.publishToRoom(roomId, EventType.ROOM_STATUS, {
    ...basePayload(updated),
    status: updated.status,
    room: buildRoomStateView(updated),
  });
  return updated;
}

export function closeRoom(hostUserId: string, roomId: string): boolean {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId) return false;

  clearFreeformTimer(roomId);
  getDb()
    .query("UPDATE multiplayer_rooms SET status = 'closed', freeform_deadline = NULL, updated_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), roomId);
  chatsSvc.mergeChatMetadata(hostUserId, room.chat_id, { multiplayer_room_id: undefined });
  invalidateChatRoute(room.chat_id);

  eventBus.publishToRoom(roomId, EventType.ROOM_STATUS, {
    ...basePayload(room),
    status: "closed",
  });

  // Disconnect every peer socket (host stays connected as a normal user client).
  for (const p of listParticipants(roomId, { activeOnly: true })) {
    if (p.role === "peer") eventBus.disconnectParticipant(p.id, 1000, "room closed");
  }
  return true;
}

// ─── join / leave ───────────────────────────────────────────────────────────────

function upsertParticipant(
  room: Room,
  identityKind: IdentityKind,
  identityRef: string,
  role: ParticipantRole,
  profile: JoinProfile,
): JoinResult {
  if (room.status === "closed") return { ok: false, reason: "closed" };
  if (isBanned(room.id, identityKind, identityRef)) return { ok: false, reason: "banned" };

  const now = Math.floor(Date.now() / 1000);
  const displayName = sanitizeDisplayName(profile.displayName);
  const persona = sanitizePersonaSnapshot(profile.persona);

  const existing = getDb()
    .query(
      "SELECT * FROM multiplayer_participants WHERE room_id = ? AND identity_kind = ? AND identity_ref = ?",
    )
    .get(room.id, identityKind, identityRef) as any;

  if (existing) {
    // Reconnect / re-join: re-activate the same row (keeps the turn slot).
    const wasActive = existing.status === "active";
    getDb()
      .query(
        "UPDATE multiplayer_participants SET status = 'active', display_name = ?, persona_snapshot = ?, last_seen = ? WHERE id = ?",
      )
      .run(
        displayName || existing.display_name,
        persona ? JSON.stringify(persona) : existing.persona_snapshot,
        now,
        existing.id,
      );
    const participant = getParticipant(existing.id)!;
    if (!wasActive && role === "peer") ensureInTurnOrder(getRoom(room.id)!, participant.id);
    return { ok: true, room: getRoom(room.id)!, participant };
  }

  // New participant — enforce peer capacity.
  if (role === "peer") {
    const activePeers = getDb()
      .query("SELECT COUNT(*) c FROM multiplayer_participants WHERE room_id = ? AND role = 'peer' AND status = 'active'")
      .get(room.id) as { c: number };
    if (activePeers.c >= room.settings.maxPeers) return { ok: false, reason: "full" };
  }

  const id = crypto.randomUUID();
  getDb()
    .query(
      `INSERT INTO multiplayer_participants
         (id, room_id, role, identity_kind, identity_ref, display_name, persona_snapshot, status, joined_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, room.id, role, identityKind, identityRef, displayName, persona ? JSON.stringify(persona) : "{}", now, now);

  const fresh = getRoom(room.id)!;
  if (role === "peer") ensureInTurnOrder(fresh, id);
  return { ok: true, room: getRoom(room.id)!, participant: getParticipant(id)! };
}

/** WS connect via host-minted room token (remote peer / synthetic identity). */
export function joinByToken(roomId: string, subject: string, profile: JoinProfile): JoinResult {
  const room = getRoom(roomId);
  if (!room) return { ok: false, reason: "not_found" };
  const result = upsertParticipant(room, "token", subject, "peer", profile);
  if (result.ok) broadcastJoin(result.room, result.participant);
  return result;
}

/** WS join from a logged-in local account (multi-tab / LAN testing). */
export function joinByUser(roomId: string, userId: string, profile: JoinProfile): JoinResult {
  const room = getRoom(roomId);
  if (!room) return { ok: false, reason: "not_found" };
  // The host re-attaches to its seeded host participant; everyone else is a peer.
  const role: ParticipantRole = userId === room.host_user_id ? "host" : "peer";
  const result = upsertParticipant(room, "user", userId, role, profile);
  if (result.ok) broadcastJoin(result.room, result.participant);
  return result;
}

function broadcastJoin(room: Room, participant: Participant): void {
  eventBus.publishToRoom(room.id, EventType.ROOM_PARTICIPANT_JOINED, {
    ...basePayload(room),
    participant: toParticipantView(participant, room.current_turn_participant_id),
  });
}

/** Build the private hydration payload sent directly to a joining socket. */
export function buildHydrationPayload(room: Room, selfParticipantId: string): {
  chatId: string;
  roomId: string;
  room: RoomStateView;
  messages: Message[];
} {
  const messages = chatsSvc.getMessages(room.host_user_id, room.chat_id).slice(-HYDRATION_MESSAGE_TAIL);
  return {
    chatId: room.chat_id,
    roomId: room.id,
    room: buildRoomStateView(room, { selfParticipantId }),
    messages,
  };
}

export function leaveParticipant(roomId: string, participantId: string, opts?: { kicked?: boolean }): void {
  const room = getRoom(roomId);
  if (!room) return;
  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId) return;

  const status = opts?.kicked ? "kicked" : "left";
  getDb()
    .query("UPDATE multiplayer_participants SET status = ?, last_seen = ? WHERE id = ?")
    .run(status, Math.floor(Date.now() / 1000), participantId);

  removeFromTurnOrder(getRoom(roomId)!, participantId);

  if (!opts?.kicked) {
    eventBus.publishToRoom(roomId, EventType.ROOM_PARTICIPANT_LEFT, {
      ...basePayload(room),
      participantId,
    });
  }
}

/** WS socket closed without an explicit leave — treat as a leave for MVP. */
export function handleDisconnect(roomId: string, participantId: string): void {
  const participant = getParticipant(participantId);
  // Host disconnecting (a normal user client) should not tear down the room.
  if (!participant || participant.role === "host") return;
  if (participant.status !== "active") return;
  leaveParticipant(roomId, participantId);
}

// ─── persona relay ──────────────────────────────────────────────────────────────

export function updateParticipantPersona(
  roomId: string,
  participantId: string,
  rawPersona: unknown,
): Participant | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId || participant.status !== "active") return null;

  const persona = sanitizePersonaSnapshot(rawPersona);
  getDb()
    .query("UPDATE multiplayer_participants SET persona_snapshot = ?, last_seen = ? WHERE id = ?")
    .run(persona ? JSON.stringify(persona) : "{}", Math.floor(Date.now() / 1000), participantId);

  eventBus.publishToRoom(roomId, EventType.ROOM_PERSONA_CHANGED, {
    ...basePayload(room),
    participantId,
    persona,
    displayName: participant.display_name,
  });
  return getParticipant(participantId);
}

// ─── presence / typing ──────────────────────────────────────────────────────────

export function markTyping(roomId: string, participantId: string, typing: boolean): void {
  const room = getRoom(roomId);
  if (!room) return;
  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId || participant.status !== "active") return;
  touchParticipant(participantId);
  eventBus.publishToRoom(roomId, EventType.ROOM_PRESENCE, {
    ...basePayload(room),
    participantId,
    typing: !!typing,
  });
}

export function touchParticipant(participantId: string): void {
  getDb()
    .query("UPDATE multiplayer_participants SET last_seen = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), participantId);
}

// ─── turn engine ────────────────────────────────────────────────────────────────

function persistTurn(room: Room): void {
  getDb()
    .query(
      "UPDATE multiplayer_rooms SET turn_order = ?, turn_index = ?, current_turn_participant_id = ?, round_counter = ?, freeform_deadline = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      JSON.stringify(room.turn_order),
      room.turn_index,
      room.current_turn_participant_id,
      room.round_counter,
      room.freeform_deadline,
      Math.floor(Date.now() / 1000),
      room.id,
    );
}

/** Point the turn at `turn_order[index]`, normalizing the index into range. */
function setCurrentTurn(room: Room, index: number): void {
  if (room.turn_order.length === 0) {
    room.turn_index = 0;
    room.current_turn_participant_id = null;
  } else {
    room.turn_index = ((index % room.turn_order.length) + room.turn_order.length) % room.turn_order.length;
    room.current_turn_participant_id = room.turn_order[room.turn_index];
  }
  persistTurn(room);
  emitTurnChanged(room);
}

function ensureInTurnOrder(room: Room, participantId: string): void {
  if (room.turn_order.includes(participantId)) return;
  room.turn_order = [...room.turn_order, participantId];
  // Re-derive current from the (possibly previously-empty) order.
  if (!room.current_turn_participant_id) {
    setCurrentTurn(room, room.turn_index);
  } else {
    persistTurn(room);
  }
}

function removeFromTurnOrder(room: Room, participantId: string): void {
  const idx = room.turn_order.indexOf(participantId);
  if (idx === -1) return;
  const wasCurrent = room.current_turn_participant_id === participantId;
  room.turn_order = room.turn_order.filter((id) => id !== participantId);

  if (room.turn_order.length === 0) {
    room.turn_index = 0;
    room.current_turn_participant_id = null;
    persistTurn(room);
    emitTurnChanged(room);
    return;
  }
  if (wasCurrent) {
    // Keep the same slot index (now occupied by the next participant).
    setCurrentTurn(room, room.turn_index);
  } else {
    // Fix the pointer so it still references the same current participant.
    room.turn_index = room.turn_order.indexOf(room.current_turn_participant_id!);
    if (room.turn_index < 0) room.turn_index = 0;
    persistTurn(room);
  }
}

/** Advance round-robin to the next participant (wraps → new round). */
function advanceTurn(room: Room): void {
  if (room.turn_strategy !== "round_robin" || room.turn_order.length === 0) return;
  const next = room.turn_index + 1;
  if (next >= room.turn_order.length) room.round_counter += 1;
  setCurrentTurn(room, next);
}

// ── freeform timers (in-process; re-armed on boot) ──

const freeformTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearFreeformTimer(roomId: string): void {
  const t = freeformTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    freeformTimers.delete(roomId);
  }
}

function armFreeformTimer(roomId: string, deadlineSec: number): void {
  clearFreeformTimer(roomId);
  const ms = Math.max(0, deadlineSec * 1000 - Date.now());
  const timer = setTimeout(() => {
    freeformTimers.delete(roomId);
    runFreeformGeneration(roomId).catch((err) =>
      console.error("[multiplayer] freeform generation failed:", err),
    );
  }, ms);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  freeformTimers.set(roomId, timer);
}

export function openFreeformWindow(hostUserId: string, roomId: string): Room | null {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId || room.status === "closed") return null;
  if (room.turn_strategy !== "freeform") return null;
  const deadline = Math.floor(Date.now() / 1000) + room.settings.freeformWindowSec;
  room.freeform_deadline = deadline;
  room.current_turn_participant_id = null;
  persistTurn(room);
  armFreeformTimer(roomId, deadline);
  emitTurnChanged(room, { windowOpen: true });
  return room;
}

export function endFreeformWindow(hostUserId: string, roomId: string): boolean {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId) return false;
  if (room.turn_strategy !== "freeform" || room.freeform_deadline === null) return false;
  clearFreeformTimer(roomId);
  runFreeformGeneration(roomId).catch((err) =>
    console.error("[multiplayer] freeform generation failed:", err),
  );
  return true;
}

const freeformGenerating = new Set<string>();

async function runFreeformGeneration(roomId: string): Promise<void> {
  const room = getRoom(roomId);
  if (!room || room.status === "closed") return;
  // Close the window.
  room.freeform_deadline = null;
  persistTurn(room);
  emitTurnChanged(room, { windowOpen: false });

  // Only generate if at least one trailing user message is pending.
  const messages = chatsSvc.getMessages(room.host_user_id, room.chat_id);
  const last = messages[messages.length - 1];
  if (!last || !last.is_user) {
    eventBus.publishToRoom(roomId, EventType.ROOM_ROUND_COMPLETE, {
      ...basePayload(room),
      round: room.round_counter,
    });
    return;
  }
  freeformGenerating.add(roomId);
  await triggerHostGeneration(room);
}

// ─── peer message submit ──────────────────────────────────────────────────────────

export function submitPeerMessage(roomId: string, participantId: string, rawContent: unknown): SubmitResult {
  const room = getRoom(roomId);
  if (!room) return { ok: false, reason: "not_found" };
  if (room.status === "closed") return { ok: false, reason: "closed" };

  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId) return { ok: false, reason: "not_found" };
  if (participant.status === "kicked") return { ok: false, reason: "kicked" };
  if (isBanned(roomId, participant.identity_kind, participant.identity_ref)) return { ok: false, reason: "kicked" };

  if (typeof rawContent !== "string") return { ok: false, reason: "invalid" };
  const content = rawContent.trim();
  if (content.length === 0) return { ok: false, reason: "invalid" };
  if (Buffer.byteLength(content, "utf8") > MAX_ROOM_MESSAGE_BYTES) return { ok: false, reason: "too_large" };

  // Turn authorization (server-side; never trust the client UI gate).
  if (room.turn_strategy === "round_robin") {
    if (room.current_turn_participant_id !== participantId) return { ok: false, reason: "not_your_turn" };
  } else {
    // freeform: only within an open window
    const now = Math.floor(Date.now() / 1000);
    if (room.freeform_deadline === null || now >= room.freeform_deadline) {
      return { ok: false, reason: "not_your_turn" };
    }
  }

  touchParticipant(participantId);
  writePeerMessage(room, participant, content);

  // Round-robin generates immediately; freeform waits for the deadline.
  if (room.turn_strategy === "round_robin") {
    triggerHostGeneration(room).catch((err) =>
      console.error("[multiplayer] generation failed:", err),
    );
  }
  return { ok: true };
}

function writePeerMessage(room: Room, participant: Participant, content: string): Message {
  const name = participant.persona_snapshot?.name || participant.display_name || "Guest";
  return chatsSvc.createMessage(
    room.chat_id,
    {
      is_user: true,
      name,
      content,
      extra: {
        // Lightweight author attribution (rides in extra JSON; no messages-table
        // column). The avatar is deliberately NOT stamped per message — it's
        // resolved from the live participant on the frontend, so a data-URL
        // avatar isn't duplicated onto every row.
        mp: {
          participantId: participant.id,
          displayName: participant.display_name,
          personaName: participant.persona_snapshot?.name,
        },
      },
    },
    room.host_user_id,
  );
}

/** A participant voluntarily ends their round-robin turn without speaking. */
export function passTurn(roomId: string, participantId: string): void {
  const room = getRoom(roomId);
  if (!room || room.turn_strategy !== "round_robin") return;
  if (room.current_turn_participant_id !== participantId) return;
  advanceTurn(room);
}

async function triggerHostGeneration(room: Room): Promise<void> {
  try {
    await generateSvc.startGeneration({
      userId: room.host_user_id,
      chat_id: room.chat_id,
      generation_type: "normal",
    });
  } catch (err) {
    console.error("[multiplayer] startGeneration error:", err);
  }
}

// ─── host controls (host-asserted) ──────────────────────────────────────────────

function assertHostRoom(hostUserId: string, roomId: string): Room | null {
  const room = getRoom(roomId);
  if (!room || room.host_user_id !== hostUserId) return null;
  return room;
}

export function hostPromote(hostUserId: string, roomId: string, participantId: string): boolean {
  const room = assertHostRoom(hostUserId, roomId);
  if (!room || room.turn_strategy !== "round_robin") return false;
  const idx = room.turn_order.indexOf(participantId);
  if (idx === -1) return false;
  setCurrentTurn(room, idx);
  return true;
}

export function hostSkip(hostUserId: string, roomId: string, participantId: string): boolean {
  const room = assertHostRoom(hostUserId, roomId);
  if (!room || room.turn_strategy !== "round_robin") return false;
  if (room.current_turn_participant_id !== participantId) {
    // Only the current participant can be "skipped"; otherwise no-op.
    return false;
  }
  advanceTurn(room);
  eventBus.publishToRoom(room.id, EventType.ROOM_TURN_SKIPPED, {
    ...basePayload(room),
    skippedParticipantId: participantId,
    currentTurnParticipantId: room.current_turn_participant_id,
  });
  return true;
}

export function hostKick(hostUserId: string, roomId: string, participantId: string): boolean {
  const room = assertHostRoom(hostUserId, roomId);
  if (!room) return false;
  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId || participant.role === "host") return false;

  leaveParticipant(roomId, participantId, { kicked: true });
  eventBus.publishToRoom(roomId, EventType.ROOM_PARTICIPANT_KICKED, {
    ...basePayload(room),
    participantId,
    banned: false,
  });
  eventBus.disconnectParticipant(participantId, 1008, "kicked");
  return true;
}

export function hostBan(hostUserId: string, roomId: string, participantId: string, reason?: string): boolean {
  const room = assertHostRoom(hostUserId, roomId);
  if (!room) return false;
  const participant = getParticipant(participantId);
  if (!participant || participant.room_id !== roomId || participant.role === "host") return false;

  getDb()
    .query(
      `INSERT OR IGNORE INTO multiplayer_bans (id, room_id, identity_kind, identity_ref, display_name, reason, banned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      roomId,
      participant.identity_kind,
      participant.identity_ref,
      participant.display_name,
      sanitizePersonaText(reason, 280),
      Math.floor(Date.now() / 1000),
    );

  leaveParticipant(roomId, participantId, { kicked: true });
  eventBus.publishToRoom(roomId, EventType.ROOM_PARTICIPANT_KICKED, {
    ...basePayload(room),
    participantId,
    banned: true,
  });
  eventBus.disconnectParticipant(participantId, 1008, "banned");
  return true;
}

// ─── generation hooks (called from the in-process fan-out listener) ──────────────

const armedRooms = new Set<string>();

function onUserMessageSent(chatId: string): void {
  const roomId = getRoomIdForChat(chatId);
  if (!roomId) return;
  const room = getRoom(roomId);
  if (room?.turn_strategy === "round_robin") armedRooms.add(roomId);
}

function onGenerationEnded(chatId: string): void {
  const roomId = getRoomIdForChat(chatId);
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) return;

  if (freeformGenerating.has(roomId)) {
    freeformGenerating.delete(roomId);
    room.round_counter += 1;
    persistTurn(room);
    eventBus.publishToRoom(roomId, EventType.ROOM_ROUND_COMPLETE, {
      ...basePayload(room),
      round: room.round_counter,
    });
    return;
  }

  if (room.turn_strategy === "round_robin" && armedRooms.has(roomId)) {
    armedRooms.delete(roomId);
    advanceTurn(room);
  }
}

/** Active PEER personas for a room's chat (host persona flows normally). */
export function getActivePeerPersonasForChat(chatId: string): Array<{ name: string; description?: string }> {
  const roomId = getRoomIdForChat(chatId);
  if (!roomId) return [];
  return listParticipants(roomId, { activeOnly: true })
    .filter((p) => p.role === "peer" && p.persona_snapshot?.name)
    .map((p) => ({ name: p.persona_snapshot!.name, description: p.persona_snapshot!.description }));
}

// ─── init: fan-out listener + persona provider + freeform timer re-arm ───────────

let initialized = false;

export function initMultiplayer(): void {
  if (initialized) return;
  initialized = true;

  // Re-broadcast chat/generation events to the room topic. publishToRoom does
  // NOT fire in-process listeners, so this cannot recurse.
  const REBROADCAST: EventType[] = [
    EventType.MESSAGE_SENT,
    EventType.MESSAGE_EDITED,
    EventType.MESSAGE_DELETED,
    EventType.MESSAGE_SWIPED,
    EventType.GENERATION_STARTED,
    EventType.GENERATION_IN_PROGRESS,
    EventType.GENERATION_ENDED,
    EventType.GENERATION_STOPPED,
    EventType.STREAM_TOKEN_RECEIVED,
  ];
  for (const ev of REBROADCAST) {
    eventBus.on(ev, (msg) => {
      const chatId = msg.payload?.chatId ?? msg.payload?.message?.chat_id;
      if (!chatId) return;
      const roomId = getRoomIdForChat(chatId);
      if (!roomId) return;
      // Feed topic = peers only. The host owns the chat and already receives
      // these on its user topic, so re-broadcasting to the shared room topic
      // would double-deliver every message/token to the host.
      eventBus.publishToRoomFeed(roomId, msg.event, msg.payload);
    });
  }

  // Turn engine hooks.
  eventBus.on(EventType.MESSAGE_SENT, (msg) => {
    const message = msg.payload?.message;
    const chatId = msg.payload?.chatId ?? message?.chat_id;
    if (chatId && message?.is_user) onUserMessageSent(chatId);
  });
  eventBus.on(EventType.GENERATION_ENDED, (msg) => {
    const chatId = msg.payload?.chatId;
    if (chatId) onGenerationEnded(chatId);
  });

  // Inject active peer personas into prompt assembly for room chats.
  setMultiplayerPersonaProvider(getActivePeerPersonasForChat);

  // Re-arm freeform deadline timers dropped by a restart.
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = getDb()
      .query(
        "SELECT id, freeform_deadline FROM multiplayer_rooms WHERE status != 'closed' AND freeform_deadline IS NOT NULL",
      )
      .all() as Array<{ id: string; freeform_deadline: number }>;
    for (const row of rows) {
      if (row.freeform_deadline <= now) {
        runFreeformGeneration(row.id).catch(() => {});
      } else {
        armFreeformTimer(row.id, row.freeform_deadline);
      }
    }
  } catch (err) {
    console.warn("[multiplayer] freeform re-arm failed:", err);
  }
}

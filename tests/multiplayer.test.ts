/**
 * Multiplayer rooms: turn engine (round-robin advance / promote / skip / pass),
 * join + ban + capacity, peer-message authorization + author attribution, and
 * freeform window gating. Exercises the service directly against an in-memory
 * DB (baseline 001-065 snapshot + the 088 multiplayer migration).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as mp from "../src/services/multiplayer.service";
import type { Room } from "../src/types/multiplayer";

const HOST = "host-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  db.run(
    await Bun.file(join(import.meta.dir, "..", "src", "db", "migrations", "088_multiplayer.sql")).text(),
  );
}

function makeRoom(strategy: "round_robin" | "freeform"): { chatId: string; room: Room } {
  const character = charactersSvc.createCharacter(HOST, { name: "Bot" });
  const chat = chatsSvc.createChat(HOST, { character_id: character.id });
  const result = mp.createRoom(HOST, chat.id, { turnStrategy: strategy });
  if ("error" in result) throw new Error(`createRoom failed: ${result.error}`);
  return { chatId: chat.id, room: result };
}

function joinPeer(roomId: string, subject: string, name: string): string {
  const j = mp.joinByToken(roomId, subject, { displayName: name });
  if (!j.ok) throw new Error(`join failed: ${j.reason}`);
  return j.participant.id;
}

describe("multiplayer turn engine", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("createRoom seeds a host participant and opens the host's turn", () => {
    const { room } = makeRoom("round_robin");
    const state = mp.getRoomStateForHost(HOST, room.id)!;
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0].role).toBe("host");
    expect(state.currentTurnParticipantId).toBe(state.participants[0].id);
  });

  test("forkAndCreateRoom forks the chat, marks it multiplayer, preserves the original", () => {
    const character = charactersSvc.createCharacter(HOST, { name: "Bot" });
    const chat = chatsSvc.createChat(HOST, { character_id: character.id });
    chatsSvc.createMessage(chat.id, { is_user: true, name: "U", content: "hello" }, HOST);

    const result = mp.forkAndCreateRoom(HOST, chat.id, { turnStrategy: "round_robin" });
    if ("error" in result) throw new Error(`fork failed: ${result.error}`);

    // The room lives on a NEW forked chat, not the original.
    expect(result.chatId).not.toBe(chat.id);
    const fork = chatsSvc.getChat(HOST, result.chatId)!;
    expect(fork.metadata.multiplayer).toBe(true);
    expect(fork.name).toMatch(/Multiplayer/);
    expect(chatsSvc.getMessages(HOST, result.chatId)).toHaveLength(1); // history copied

    // Original chat is untouched + is NOT a room.
    expect(mp.getRoomByChatId(chat.id)).toBeNull();
    expect(mp.getRoomByChatId(result.chatId)).not.toBeNull();
  });

  test("ensureJoinedRoomChat records a joined room in the peer's own history", () => {
    const PEER = "peer-user";
    const hostChatId = crypto.randomUUID();
    const roomId = crypto.randomUUID();

    const res = mp.ensureJoinedRoomChat(PEER, {
      chatId: hostChatId,
      roomId,
      name: "Alice's Room",
      characterName: "Bot",
      messages: [
        { is_user: true, name: "Bob", content: "hi" },
        { is_user: false, name: "Bot", content: "hello" },
      ],
    });
    expect(res.ok).toBe(true);

    const chat = chatsSvc.getChat(PEER, hostChatId)!;
    expect(chat.metadata.multiplayer).toBe(true);
    expect(chat.metadata.joined_room.roomId).toBe(roomId);
    expect(chat.character_id).not.toBeNull(); // under the placeholder char → shows in lists
    expect(chatsSvc.getMessages(PEER, hostChatId)).toHaveLength(2); // snapshot persisted

    // Idempotent: re-recording doesn't duplicate.
    expect(mp.ensureJoinedRoomChat(PEER, { chatId: hostChatId, roomId, messages: [] }).ok).toBe(true);
    expect(chatsSvc.getMessages(PEER, hostChatId)).toHaveLength(2);
  });

  test("ensureJoinedRoomChat stores a reconnect token getJoinedRoomReconnect reads back", () => {
    const PEER = "peer-user-rc";
    const hostChatId = crypto.randomUUID();
    const roomId = crypto.randomUUID();

    mp.ensureJoinedRoomChat(PEER, {
      chatId: hostChatId,
      roomId,
      name: "Remote Room",
      reconnectToken: "tok-abc",
      server: "https://mp.example",
    });

    const chat = chatsSvc.getChat(PEER, hostChatId)!;
    expect(chat.metadata.joined_room.remote).toBe(true);
    expect(chat.metadata.joined_room.reconnect).toBe("tok-abc");

    const back = mp.getJoinedRoomReconnect(PEER, hostChatId)!;
    expect(back.roomId).toBe(roomId);
    expect(back.reconnectToken).toBe("tok-abc");
    expect(back.server).toBe("https://mp.example");

    // A refreshed token updates in place (sliding expiry) without duplicating.
    mp.ensureJoinedRoomChat(PEER, { chatId: hostChatId, roomId, reconnectToken: "tok-xyz" });
    expect(mp.getJoinedRoomReconnect(PEER, hostChatId)!.reconnectToken).toBe("tok-xyz");

    // Scoped to the owner — another user can't read the credential.
    expect(mp.getJoinedRoomReconnect("intruder", hostChatId)).toBeNull();
  });

  test("a chat can only host one room", () => {
    const character = charactersSvc.createCharacter(HOST, { name: "Bot" });
    const chat = chatsSvc.createChat(HOST, { character_id: character.id });
    expect("error" in mp.createRoom(HOST, chat.id, {})).toBe(false);
    const second = mp.createRoom(HOST, chat.id, {});
    expect("error" in second && second.error).toBe("already_exists");
  });

  test("round-robin: join appends to order; pass / promote / skip advance the turn", () => {
    const { room } = makeRoom("round_robin");
    const hostP = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    const peerA = joinPeer(room.id, "peerA", "Ada");
    const peerB = joinPeer(room.id, "peerB", "Bo");

    expect(mp.getRoom(room.id)!.turn_order).toEqual([hostP, peerA, peerB]);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(hostP);

    mp.passTurn(room.id, hostP);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(peerA);

    mp.hostPromote(HOST, room.id, peerB);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(peerB);

    // skip the current participant → wraps back to the host, new round
    mp.hostSkip(HOST, room.id, peerB);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(hostP);
    expect(mp.getRoom(room.id)!.round_counter).toBe(1);
  });

  test("leaving the current participant advances; leaving another fixes the pointer", () => {
    const { room } = makeRoom("round_robin");
    const hostP = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    const peerA = joinPeer(room.id, "peerA", "Ada");
    const peerB = joinPeer(room.id, "peerB", "Bo");

    mp.hostPromote(HOST, room.id, peerA); // current = peerA
    // peerB (not current) leaves → current stays peerA, order compacts
    mp.leaveParticipant(room.id, peerB);
    expect(mp.getRoom(room.id)!.turn_order).toEqual([hostP, peerA]);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(peerA);

    // peerA (current) leaves → advances to the participant now in that slot (host, wraps)
    mp.leaveParticipant(room.id, peerA);
    expect(mp.getRoom(room.id)!.current_turn_participant_id).toBe(hostP);
  });

  test("round-robin submit is turn-gated and stamps author attribution", () => {
    const { room, chatId } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");

    // host's turn → peer rejected
    const early = mp.submitPeerMessage(room.id, peerA, "hi");
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.reason).toBe("not_your_turn");

    mp.hostPromote(HOST, room.id, peerA);
    const ok = mp.submitPeerMessage(room.id, peerA, "hello everyone");
    expect(ok.ok).toBe(true);

    const messages = chatsSvc.getMessages(HOST, chatId);
    const last = messages[messages.length - 1];
    expect(last.is_user).toBe(true);
    expect(last.name).toBe("Ada");
    expect(last.extra.mp.participantId).toBe(peerA);
  });

  test("empty and oversized messages are rejected", () => {
    const { room } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");
    mp.hostPromote(HOST, room.id, peerA);
    expect(mp.submitPeerMessage(room.id, peerA, "   ").ok).toBe(false);
    expect(mp.submitPeerMessage(room.id, peerA, "x".repeat(20_000)).ok).toBe(false);
  });

  test("freeform: submit only inside an open window", () => {
    const { room } = makeRoom("freeform");
    const peerA = joinPeer(room.id, "peerA", "Ada");

    expect(mp.submitPeerMessage(room.id, peerA, "too early").ok).toBe(false);
    mp.openFreeformWindow(HOST, room.id);
    expect(mp.submitPeerMessage(room.id, peerA, "in window").ok).toBe(true);
  });

  test("freeform: generation fires early once every active participant has submitted", () => {
    const { room } = makeRoom("freeform");
    const hostP = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    const peerA = joinPeer(room.id, "peerA", "Ada");

    mp.openFreeformWindow(HOST, room.id);
    expect(mp.getRoom(room.id)!.freeform_deadline).not.toBeNull();

    // One peer has submitted but the host hasn't — the window stays open.
    expect(mp.submitPeerMessage(room.id, peerA, "i act").ok).toBe(true);
    expect(mp.getRoom(room.id)!.freeform_deadline).not.toBeNull();

    // The host submits too → everyone has contributed → the window closes
    // immediately (generation fired) rather than waiting for the deadline.
    expect(mp.submitPeerMessage(room.id, hostP, "the GM narrates").ok).toBe(true);
    expect(mp.getRoom(room.id)!.freeform_deadline).toBeNull();
  });

  test("freeform: a holdout leaving lets the remaining submitters trigger the round", () => {
    const { room } = makeRoom("freeform");
    const hostP = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    const peerA = joinPeer(room.id, "peerA", "Ada");
    const peerB = joinPeer(room.id, "peerB", "Bo");

    mp.openFreeformWindow(HOST, room.id);
    expect(mp.submitPeerMessage(room.id, hostP, "go").ok).toBe(true);
    expect(mp.submitPeerMessage(room.id, peerA, "i act").ok).toBe(true);
    // peerB never submits → still open.
    expect(mp.getRoom(room.id)!.freeform_deadline).not.toBeNull();

    // peerB leaves → the only remaining un-submitted participant is gone, so the
    // round completes without waiting out the deadline.
    mp.leaveParticipant(room.id, peerB);
    expect(mp.getRoom(room.id)!.freeform_deadline).toBeNull();
  });

  test("ban kicks the participant and blocks rejoin; capacity is enforced", () => {
    const { room } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");

    expect(mp.hostBan(HOST, room.id, peerA, "spam")).toBe(true);
    const rejoin = mp.joinByToken(room.id, "peerA", { displayName: "Ada" });
    expect(rejoin.ok).toBe(false);
    expect(rejoin.ok === false && rejoin.reason).toBe("banned");
  });

  test("display names are sanitized (control chars + angle brackets stripped)", () => {
    const { room } = makeRoom("round_robin");
    const j = mp.joinByToken(room.id, "peerX", { displayName: "<script>Eve" });
    if (!j.ok) throw new Error("join failed");
    expect(j.participant.display_name).toBe("scriptEve");
  });

  test("persona avatar: compressed data-URL accepted, SVG/oversized rejected", () => {
    const { room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");

    const webp = "data:image/webp;base64," + "A".repeat(200);
    mp.updateParticipantPersona(room.id, peer, { name: "Ada", avatarUrl: webp });
    expect(mp.getParticipant(peer)?.persona_snapshot?.avatarUrl).toBe(webp);

    // SVG data URLs (script execution risk) must be rejected → null.
    mp.updateParticipantPersona(room.id, peer, { name: "Ada", avatarUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
    expect(mp.getParticipant(peer)?.persona_snapshot?.avatarUrl ?? null).toBeNull();

    // Oversized data URLs rejected.
    mp.updateParticipantPersona(room.id, peer, { name: "Ada", avatarUrl: "data:image/webp;base64," + "A".repeat(40_000) });
    expect(mp.getParticipant(peer)?.persona_snapshot?.avatarUrl ?? null).toBeNull();
  });

  test("peer cannot invoke host controls", () => {
    const { room } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");
    // A peer's identity_ref is not the host_user_id, so host-asserted ops fail.
    expect(mp.hostKick("peerA", room.id, peerA)).toBe(false);
    expect(mp.hostPromote("peerA", room.id, peerA)).toBe(false);
  });
});

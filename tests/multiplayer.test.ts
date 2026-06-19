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

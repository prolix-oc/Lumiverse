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
import * as settingsSvc from "../src/services/settings.service";
import * as poolSvc from "../src/services/generation-pool.service";
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
    const avatarUrl = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=";
    mp.updateParticipantPersona(room.id, peerA, { name: "Ada", avatarUrl });

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
    expect(last.extra.mp.avatarUrl).toBe(avatarUrl);
  });

  test("empty and oversized messages are rejected", () => {
    const { room } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");
    mp.hostPromote(HOST, room.id, peerA);
    expect(mp.submitPeerMessage(room.id, peerA, "   ").ok).toBe(false);
    expect(mp.submitPeerMessage(room.id, peerA, "x".repeat(20_000)).ok).toBe(false);
  });

  test("freeform window honors a custom duration and clamps to [10, 3600]", () => {
    const mk = (sec: number) => {
      const ch = charactersSvc.createCharacter(HOST, { name: "Bot" });
      const c = chatsSvc.createChat(HOST, { character_id: ch.id });
      const r = mp.createRoom(HOST, c.id, { turnStrategy: "freeform", settings: { freeformWindowSec: sec } });
      if ("error" in r) throw new Error(`createRoom failed: ${r.error}`);
      return r;
    };
    // A large value is stored as-is — NOT capped at the 120 default.
    expect(mk(600).settings.freeformWindowSec).toBe(600);
    expect(mk(99999).settings.freeformWindowSec).toBe(3600); // clamp to max
    expect(mk(2).settings.freeformWindowSec).toBe(10); // clamp to min

    // The opened window honors the configured duration (~600s, not ~120).
    const room = mk(600);
    const opened = mp.openFreeformWindow(HOST, room.id)!;
    expect(opened.freeform_deadline! - Math.floor(Date.now() / 1000)).toBeGreaterThan(550);
  });

  test("freeform window duration is editable only while no window is open", () => {
    const { room } = makeRoom("freeform"); // default 120
    // Ended → change applies.
    expect(mp.updateRoom(HOST, room.id, { settings: { freeformWindowSec: 300 } })!.settings.freeformWindowSec).toBe(300);

    // Open a window → the duration is now locked (can't move the goalposts mid-round).
    mp.openFreeformWindow(HOST, room.id);
    const blocked = mp.updateRoom(HOST, room.id, { settings: { freeformWindowSec: 600 } })!;
    expect(blocked.settings.freeformWindowSec).toBe(300);
    expect(blocked.freeform_deadline).not.toBeNull();
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

  test("freeform recovers after a stopped/crashed generation — a new window generates again", () => {
    const { room } = makeRoom("freeform");
    const hostP = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    const peerA = joinPeer(room.id, "peerA", "Ada");

    // Round 1: open + everyone submits → generation fires, window closes.
    mp.openFreeformWindow(HOST, room.id);
    mp.submitPeerMessage(room.id, peerA, "a1");
    mp.submitPeerMessage(room.id, hostP, "h1");
    expect(mp.getRoom(room.id)!.freeform_deadline).toBeNull();

    // That generation never completes here (no LLM in tests) and — simulating a
    // STOP/crash — never fires GENERATION_ENDED, so the in-progress flag is left
    // set. A new window must still be able to generate (otherwise the room's
    // freeform is permanently stuck — the reported "cannot recover" state).
    mp.openFreeformWindow(HOST, room.id);
    expect(mp.getRoom(room.id)!.freeform_deadline).not.toBeNull();
    mp.submitPeerMessage(room.id, peerA, "a2");
    mp.submitPeerMessage(room.id, hostP, "h2");
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

  test("host generation connection resolves active → default → any (never hard-fails with profiles)", () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const addConn = (id: string, isDefault: number, updated: number) =>
      db
        .query(
          "INSERT INTO connection_profiles (id, user_id, name, provider, is_default, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(id, HOST, "Profile", "openai", isDefault, "{}", now, updated);

    // No profiles at all → undefined (a genuine misconfiguration, not our bug).
    expect(mp.resolveHostConnectionId(HOST)).toBeUndefined();

    const c1 = crypto.randomUUID();
    const c2 = crypto.randomUUID();
    addConn(c1, 0, now - 100);
    addConn(c2, 0, now); // most-recently-updated

    // No default + no active selection → falls back to any owned profile (the
    // most recent), instead of throwing "No connection profile found".
    expect(mp.resolveHostConnectionId(HOST)).toBe(c2);

    // An explicit DB default beats "any".
    db.query("UPDATE connection_profiles SET is_default = 1 WHERE id = ?").run(c1);
    expect(mp.resolveHostConnectionId(HOST)).toBe(c1);

    // The host's active UI selection (activeProfileId) beats the default — so a
    // room generates on the same connection the host's normal sends use.
    settingsSvc.putSetting(HOST, "activeProfileId", c2);
    expect(mp.resolveHostConnectionId(HOST)).toBe(c2);

    // A stale active id (profile since deleted) is ignored → back to the default.
    settingsSvc.putSetting(HOST, "activeProfileId", "missing-id");
    expect(mp.resolveHostConnectionId(HOST)).toBe(c1);
  });

  test("hydration embeds an in-flight generation so mid-join peers resume streaming", () => {
    const { room, chatId } = makeRoom("round_robin");

    // Nothing generating → no snapshot.
    expect(mp.buildHydrationPayload(room, "self").generation).toBeNull();

    // Host starts streaming a reply.
    const genId = crypto.randomUUID();
    poolSvc.createPoolEntry({
      generationId: genId,
      userId: HOST,
      chatId,
      generationType: "normal",
      characterName: "Bot",
      model: "m",
      targetMessageId: "msg-1",
    });
    poolSvc.setPoolStatus(genId, "streaming");
    poolSvc.appendPoolContent(genId, "Hello, trav");

    const hy = mp.buildHydrationPayload(room, "self");
    expect(hy.generation?.active).toBe(true);
    expect(hy.generation?.generationId).toBe(genId);
    expect(hy.generation?.content).toBe("Hello, trav");
    expect(hy.generation?.targetMessageId).toBe("msg-1");

    // Host-local impersonate drafts are never resumed on a peer.
    const imp = crypto.randomUUID();
    poolSvc.createPoolEntry({
      generationId: imp,
      userId: HOST,
      chatId,
      generationType: "impersonate",
      characterName: "Bot",
      model: "m",
    });
    poolSvc.setPoolStatus(imp, "streaming");
    expect(mp.buildHydrationPayload(room, "self").generation).toBeNull();
  });

  test("character (bot) avatar is relayed via hydration, sanitized", () => {
    const { room } = makeRoom("round_robin");
    // None set → null.
    expect(mp.buildHydrationPayload(room, "self").characterAvatar).toBeNull();

    // A compressed WebP data URL is accepted + relayed to peers.
    const webp = "data:image/webp;base64," + "A".repeat(200);
    mp.setRoomCharacterAvatar(room.id, webp);
    expect(mp.buildHydrationPayload(room, "self").characterAvatar).toBe(webp);

    // SVG (script-exec risk) is rejected — the prior value is kept.
    mp.setRoomCharacterAvatar(room.id, "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(mp.buildHydrationPayload(room, "self").characterAvatar).toBe(webp);
  });

  test("hydration is trimmed to fit under the relay frame cap", () => {
    const character = charactersSvc.createCharacter(HOST, { name: "Bot" });
    const chat = chatsSvc.createChat(HOST, { character_id: character.id });
    const result = mp.createRoom(HOST, chat.id, {});
    if ("error" in result) throw new Error("createRoom failed");

    // Insert way more message data than a single 256 KB frame can hold.
    const big = "x".repeat(4000);
    for (let i = 0; i < 100; i++) {
      chatsSvc.createMessage(chat.id, { is_user: true, name: "U", content: big }, HOST);
    }

    const hy = mp.buildHydrationPayload(result, "self");
    const bytes = new TextEncoder().encode(JSON.stringify(hy)).length;
    expect(bytes).toBeLessThan(256 * 1024); // fits the relay cap (no silent drop)
    expect(hy.messages.length).toBeLessThan(100); // oldest were trimmed
    expect(hy.messages.length).toBeGreaterThan(0); // but the recent tail is kept
  });

  test("peer cannot invoke host controls", () => {
    const { room } = makeRoom("round_robin");
    const peerA = joinPeer(room.id, "peerA", "Ada");
    // A peer's identity_ref is not the host_user_id, so host-asserted ops fail.
    expect(mp.hostKick("peerA", room.id, peerA)).toBe(false);
    expect(mp.hostPromote("peerA", room.id, peerA)).toBe(false);
  });
});

describe("multiplayer peer persona lorebook relay", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  // A relayed lorebook is a `character_book` (the world-book export shape).
  const CB = (entries: Array<Record<string, unknown>>) => ({ entries });

  test("relayed lorebook materializes into namespaced runtime entries", () => {
    const { chatId, room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");

    mp.updateParticipantLorebook(
      room.id,
      peer,
      CB([
        { keys: ["dragon"], content: "Dragons breathe fire." },
        { keys: ["castle", "keep"], content: "The castle is on a hill.", position: 4, depth: 2 },
      ]),
    );

    const wi = mp.getActivePeerLorebookEntriesForChat(chatId);
    expect(wi).not.toBeNull();
    expect(wi!.bookIds).toEqual([`mp-peer:${peer}`]);
    expect(wi!.entries).toHaveLength(2);

    // Stable, namespaced identity: no collision with the host's UUID entries,
    // and a consistent id across turns for sticky/cooldown state.
    const first = wi!.entries[0];
    expect(first.id).toBe(`mp-peer:${peer}:0`);
    expect(first.uid).toBe(`mp-peer:${peer}:0`);
    expect(first.world_book_id).toBe(`mp-peer:${peer}`);
    expect(first.key).toEqual(["dragon"]);
    expect(first.content).toBe("Dragons breathe fire.");

    const second = wi!.entries[1];
    expect(second.id).toBe(`mp-peer:${peer}:1`);
    expect(second.key).toEqual(["castle", "keep"]);
    expect(second.position).toBe(4);
  });

  test("a null payload clears a previously-relayed lorebook", () => {
    const { chatId, room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");
    mp.updateParticipantLorebook(room.id, peer, CB([{ keys: ["x"], content: "X." }]));
    expect(mp.getActivePeerLorebookEntriesForChat(chatId)).not.toBeNull();

    mp.updateParticipantLorebook(room.id, peer, null);
    expect(mp.getActivePeerLorebookEntriesForChat(chatId)).toBeNull();
  });

  test("drops un-activatable entries (no keys, not constant) but keeps constants", () => {
    const { chatId, room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");
    mp.updateParticipantLorebook(
      room.id,
      peer,
      CB([
        { keys: [], content: "Never matches." }, // dropped — can never activate
        { keys: [], content: "Always on.", constant: true }, // kept — constant
        { keys: ["y"], content: "" }, // dropped — empty content
      ]),
    );
    const wi = mp.getActivePeerLorebookEntriesForChat(chatId);
    expect(wi).not.toBeNull();
    expect(wi!.entries).toHaveLength(1);
    expect(wi!.entries[0].content).toBe("Always on.");
    expect(wi!.entries[0].constant).toBe(true);
  });

  test("caps relayed entry count", () => {
    const { chatId, room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");
    const many = Array.from({ length: 200 }, (_, i) => ({ keys: [`k${i}`], content: `C${i}` }));
    mp.updateParticipantLorebook(room.id, peer, CB(many));
    const wi = mp.getActivePeerLorebookEntriesForChat(chatId)!;
    expect(wi.entries.length).toBeLessThanOrEqual(64);
    expect(wi.entries.length).toBeGreaterThan(0);
  });

  test("clears a peer's lorebook when they leave", () => {
    const { chatId, room } = makeRoom("round_robin");
    const peer = joinPeer(room.id, "peerA", "Ada");
    mp.updateParticipantLorebook(room.id, peer, CB([{ keys: ["x"], content: "X." }]));
    mp.leaveParticipant(room.id, peer);
    expect(mp.getActivePeerLorebookEntriesForChat(chatId)).toBeNull();
  });

  test("ignores a host-role lorebook (host's book flows through normal assembly)", () => {
    const { chatId, room } = makeRoom("round_robin");
    joinPeer(room.id, "peerA", "Ada"); // a peer exists but relays no lorebook
    const hostId = mp.getRoomStateForHost(HOST, room.id)!.participants[0].id;
    mp.updateParticipantLorebook(room.id, hostId, CB([{ keys: ["x"], content: "X." }]));
    // The host's attached book is injected by normal assembly, never as a peer
    // entry — so the peer-lorebook provider yields nothing here.
    expect(mp.getActivePeerLorebookEntriesForChat(chatId)).toBeNull();
  });

  test("two peers' lorebooks are namespaced separately", () => {
    const { chatId, room } = makeRoom("freeform");
    const peerA = joinPeer(room.id, "peerA", "Ada");
    const peerB = joinPeer(room.id, "peerB", "Bo");
    mp.updateParticipantLorebook(room.id, peerA, CB([{ keys: ["a"], content: "A." }]));
    mp.updateParticipantLorebook(room.id, peerB, CB([{ keys: ["b"], content: "B." }]));
    const wi = mp.getActivePeerLorebookEntriesForChat(chatId)!;
    expect(wi.bookIds.sort()).toEqual([`mp-peer:${peerA}`, `mp-peer:${peerB}`].sort());
    expect(wi.entries.map((e) => e.world_book_id).sort()).toEqual(
      [`mp-peer:${peerA}`, `mp-peer:${peerB}`].sort(),
    );
  });
});

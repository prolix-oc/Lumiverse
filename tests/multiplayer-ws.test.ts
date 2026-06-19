/**
 * Multiplayer WebSocket integration: a real token-authenticated peer socket
 * against a live Bun.serve running the actual ws handler. Validates the parts
 * the service-level unit tests don't reach — room-token auth, join hydration,
 * turn gating over the wire, the ROOM_* lifecycle topic, and the peer-only
 * FEED topic (peer receives MESSAGE_SENT without the host double-delivery).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { initIdentity } from "../src/crypto/init";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { eventBus } from "../src/ws/bus";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as mp from "../src/services/multiplayer.service";
import { mintRoomToken } from "../src/crypto/room-token";

const HOST = "host-user";
let server: ReturnType<typeof Bun.serve> | null = null;
let port = 0;

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  db.run(
    await Bun.file(join(import.meta.dir, "..", "src", "db", "migrations", "088_multiplayer.sql")).text(),
  );
}

/** Resolve with the first WS message matching `predicate` (or reject on timeout). */
function waitFor(ws: WebSocket, predicate: (d: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error("timed out waiting for ws event"));
    }, timeoutMs);
    const onMsg = (e: MessageEvent) => {
      let data: any;
      try { data = JSON.parse(e.data as string); } catch { return; }
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(data);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

beforeAll(async () => {
  await initIdentity(); // derives the room-token key from the real identity file (read-only)
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();

  // Stand up a real server with ONLY the ws route (avoids the full auth stack).
  const { wsHandler } = await import("../src/ws/handler");
  const { websocket } = await import("hono/bun");
  const { Hono } = await import("hono");
  const app = new Hono();
  app.get("/api/ws", wsHandler);
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  port = server.port;
  eventBus.setServer(server as any);
  mp.initMultiplayer();
});

afterAll(() => {
  server?.stop(true);
});

describe("multiplayer WS integration", () => {
  test("token peer: hydrate, turn-gate, lifecycle + feed delivery", async () => {
    const character = charactersSvc.createCharacter(HOST, { name: "Bot" });
    const chat = chatsSvc.createChat(HOST, { character_id: character.id });
    const room = mp.createRoom(HOST, chat.id, { turnStrategy: "round_robin" });
    if ("error" in room) throw new Error(room.error);

    const token = await mintRoomToken({ roomId: room.id, subject: "peer-ws-1", displayName: "Ada" });
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?roomToken=${encodeURIComponent(token)}`);

    // 1. CONNECTED (peer-scoped) → carries our participant id
    const connected = await waitFor(ws, (d) => d.event === "CONNECTED");
    expect(connected.payload.peer).toBe(true);
    const myId: string = connected.payload.participantId;
    expect(typeof myId).toBe("string");

    // 2. ROOM_STATUS hydration with room snapshot + messages array
    const hydration = await waitFor(ws, (d) => d.event === "ROOM_STATUS" && !!d.payload.room);
    expect(hydration.payload.room.roomId).toBe(room.id);
    expect(Array.isArray(hydration.payload.messages)).toBe(true);

    // 3. Out of turn (host opens) → submit rejected
    ws.send(JSON.stringify({ type: "room_message", content: "too early" }));
    const rejected = await waitFor(ws, (d) => d.event === "ROOM_MESSAGE_REJECTED");
    expect(rejected.payload.reason).toBe("not_your_turn");

    // 4. Host promotes the peer → peer receives ROOM_TURN_CHANGED (lifecycle topic)
    expect(mp.hostPromote(HOST, room.id, myId)).toBe(true);
    const turn = await waitFor(ws, (d) => d.event === "ROOM_TURN_CHANGED");
    expect(turn.payload.currentTurnParticipantId).toBe(myId);

    // 5. In turn → message accepted; peer receives MESSAGE_SENT over the FEED
    //    topic, with author attribution stamped in extra.mp.
    ws.send(JSON.stringify({ type: "room_message", content: "hello from ada" }));
    const sent = await waitFor(
      ws,
      (d) => d.event === "MESSAGE_SENT" && d.payload?.message?.content === "hello from ada",
    );
    expect(sent.payload.message.is_user).toBe(true);
    expect(sent.payload.message.name).toBe("Ada");
    expect(sent.payload.message.extra.mp.participantId).toBe(myId);

    ws.close();
  });

  test("an invalid room token is refused at upgrade", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?roomToken=not.a.valid.token`);
    const authErr = await waitFor(ws, (d) => d.event === "AUTH_ERROR");
    expect(authErr.payload.message).toMatch(/room token/i);
    ws.close();
  });
});

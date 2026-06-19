/**
 * Stop-generation semantics, end to end against a mock local OpenAI-compatible
 * SSE server:
 *
 *  - stopGeneration aborts the provider stream AND the upstream server sees
 *    the disconnect (reader.cancel() alone doesn't close the connection in
 *    Bun — a local llama.cpp would keep generating and block its slot).
 *  - stopGeneration is user-scoped: another user's id can't abort it.
 *  - stopChatGenerations stops the chat's active generation when the client's
 *    generation id is stale — the /generate/stop fallback path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { readdirSync } from "fs";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as chatsSvc from "../src/services/chats.service";
import * as connectionsSvc from "../src/services/connections.service";
import * as presetsSvc from "../src/services/presets.service";
import * as genSvc from "../src/services/generate.service";
import * as poolSvc from "../src/services/generation-pool.service";

const USER_ID = "stop-test-user";
const enc = new TextEncoder();

interface RequestState { cancelled: boolean; sent: number }
const requests: RequestState[] = [];
let server: ReturnType<typeof Bun.serve>;
let connectionId: string;
let presetId: string;

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

beforeAll(async () => {
  // Mock OpenAI-compatible server streaming a token every 10ms, recording
  // when the client connection actually goes away.
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const state: RequestState = { cancelled: false, sent: 0 };
      requests.push(state);
      let timer: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            state.sent++;
            const chunk = { choices: [{ delta: { content: `tok${state.sent} ` }, finish_reason: null }] };
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch {
              if (timer) clearInterval(timer);
            }
          }, 10);
        },
        cancel() {
          state.cancelled = true;
          if (timer) clearInterval(timer);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  // Baseline is a 001-065 snapshot; apply later migrations on top (skipping
  // any change the baseline already absorbed).
  const migrationsDir = join(import.meta.dir, "..", "src", "db", "migrations");
  const post065 = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && parseInt(f.slice(0, 3), 10) > 65)
    .sort();
  for (const file of post065) {
    try {
      db.run(await Bun.file(join(migrationsDir, file)).text());
    } catch { /* baseline already includes this change */ }
  }

  presetId = presetsSvc.createPreset(USER_ID, {
    name: "stop-test-preset",
    provider: "custom",
    parameters: { max_tokens: 4096 },
  } as any).id;
  connectionId = (await connectionsSvc.createConnection(USER_ID, {
    name: "local-mock",
    provider: "custom",
    api_url: `http://localhost:${server.port}/v1`,
    model: "mock-model",
    is_default: true,
  } as any)).id;
});

afterAll(() => {
  server.stop(true);
  closeDatabase();
});

/** Start a streaming generation in a fresh temporary chat and wait for the
 *  mock server to begin emitting tokens. Returns that request's server state. */
async function startStreamingGeneration(): Promise<{ chatId: string; generationId: string; state: RequestState }> {
  const requestIndex = requests.length;
  const chat = chatsSvc.createChat(USER_ID, {
    character_id: null,
    name: "Stop Test Chat",
    metadata: { temporary: true },
  });
  chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Go." }, USER_ID);
  const { generationId } = await genSvc.startGeneration({
    userId: USER_ID,
    chat_id: chat.id,
    connection_id: connectionId,
    preset_id: presetId,
    generation_type: "normal",
  } as any);
  expect(await waitFor(() => requests[requestIndex]?.sent >= 3, 5000)).toBe(true);
  return { chatId: chat.id, generationId, state: requests[requestIndex] };
}

describe("stop generation", () => {
  test("stopGeneration aborts the stream and the upstream server sees the disconnect", async () => {
    const { chatId, generationId, state } = await startStreamingGeneration();

    expect(genSvc.stopGeneration(USER_ID, generationId)).toBe(true);

    // The upstream server must observe the close promptly — this is what
    // makes a local llama.cpp actually stop generating and free its slot.
    expect(await waitFor(() => state.cancelled, 2000)).toBe(true);
    expect(await waitFor(() => poolSvc.getPoolForChat(USER_ID, chatId)?.status === "stopped", 2000)).toBe(true);
  });

  test("stopGeneration is user-scoped and misses unknown ids", async () => {
    const { chatId, generationId, state } = await startStreamingGeneration();

    expect(genSvc.stopGeneration("someone-else", generationId)).toBe(false);
    expect(genSvc.stopGeneration(USER_ID, "no-such-generation")).toBe(false);
    expect(state.cancelled).toBe(false);

    // The /generate/stop fallback: a stale id still stops the chat's
    // active generation instead of silently no-opping.
    expect(genSvc.stopChatGenerations(USER_ID, chatId)).toBe(true);
    expect(await waitFor(() => state.cancelled, 2000)).toBe(true);
  });

  test("stopChatGenerations reports false when nothing is running", () => {
    expect(genSvc.stopChatGenerations(USER_ID, "idle-chat")).toBe(false);
  });
});

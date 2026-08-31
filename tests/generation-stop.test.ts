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
import * as councilSettingsSvc from "../src/services/council/council-settings.service";
import {
  getWebSearchSettings,
  putWebSearchSettings,
} from "../src/services/web-search-settings.service";
import { registerHostCouncilTool } from "../src/services/council/host-tools";

const USER_ID = "stop-test-user";
const enc = new TextEncoder();

interface RequestState {
  cancelled: boolean;
  paused: boolean;
  sent: number;
  kind: "child" | "root" | "root-inline";
  body: Record<string, unknown>;
  model: string;
}
const requests: RequestState[] = [];
let server: ReturnType<typeof Bun.serve>;
let connectionId: string;
let chatConnectionId: string;
let presetId: string;
let agentPresetId: string;
let rootFixtureToolExecutions = 0;
let rootFixtureToolQueries: string[] = [];
let rootFixtureActive = false;

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
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const serializedBody = JSON.stringify(body);
      const isChild = serializedBody.includes("You are a subordinate agent.");
      const isRootInlineFixture = rootFixtureActive;
      const state: RequestState = {
        cancelled: false,
        paused: false,
        sent: 0,
        kind: isRootInlineFixture ? "root-inline" : isChild ? "child" : "root",
        body,
        model: typeof body.model === "string" ? body.model : "",
      };
      requests.push(state);
      if (isChild) {
        state.sent = 1;
        return new Response(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: "child result" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 2,
            total_tokens: 4,
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isRootInlineFixture) {
        state.sent = 1;
        const tools = body.tools;
        const toolCallingEnabled = Array.isArray(tools) && tools.length > 0;
        const round = requests.filter(
          (request) => request.kind === "root-inline",
        ).length - 1;
        if (toolCallingEnabled) {
          return new Response(
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: `root-call-${round}`,
                    type: "function",
                    function: {
                      name: "fixture_web_search",
                      arguments: JSON.stringify({ query: `fixture-${round}` }),
                    },
                  }],
                },
                finish_reason: null,
              }],
            })}\n\ndata: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({
            choices: [{
              delta: { content: "finalized after tool rounds" },
              finish_reason: null,
            }],
          })}\n\ndata: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (serializedBody.includes("SECURITY_IMPERSONATE_SUCCESS")) {
        state.sent = 1;
        return new Response(
          `data: ${JSON.stringify({
            choices: [{
              delta: { content: "impersonated result" },
              finish_reason: null,
            }],
          })}\n\ndata: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      let timer: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            if (state.paused) return;
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
  agentPresetId = presetsSvc.createPreset(USER_ID, {
    name: "agent-impersonate-test-preset",
    provider: "custom",
    parameters: { max_tokens: 64 },
    metadata: {
      agentConfig: {
        version: 1,
        enabled: true,
        maxInvocations: 64,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [{
          id: "writer",
          name: "Writer",
          systemPrompt: "Return a short result.",
          connectionProfileId: null,
          toolIds: [],
          loreScope: "active",
          allowMainDelegation: false,
          failurePolicy: "required",
          streamActivity: true,
          maxOutputTokens: 64,
          timeoutMs: 5_000,
        }],
      },
    },
    prompt_order: [
      {
        id: crypto.randomUUID(),
        name: "Agent",
        content: "{{agent::writer::stream}}\nDo the child task.\n{{/agent}}",
        role: "user",
        enabled: true,
        position: "pre_history",
        depth: 0,
        marker: null,
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
      },
      {
        id: crypto.randomUUID(),
        name: "Chat History",
        content: "",
        role: "system",
        enabled: true,
        position: "pre_history",
        depth: 0,
        marker: "chat_history",
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
      },
    ],
  }).id;
  chatConnectionId = (await connectionsSvc.createConnection(USER_ID, {
    name: "chat-bound-mock",
    provider: "custom",
    api_url: `http://localhost:${server.port}/v1`,
    model: "chat-profile-model",
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

async function startImpersonateAgentGeneration(
  input: string,
): Promise<{ chatId: string; generationId: string; requestIndex: number }> {
  const requestIndex = requests.length;
  const chat = chatsSvc.createChat(USER_ID, {
    character_id: null,
    name: "Agent Impersonate Test",
    metadata: { temporary: true },
  });
  chatsSvc.createMessage(
    chat.id,
    { is_user: false, name: "Assistant", content: "Previous response." },
    USER_ID,
  );
  const { generationId } = await genSvc.startGeneration({
    userId: USER_ID,
    chat_id: chat.id,
    connection_id: connectionId,
    preset_id: agentPresetId,
    generation_type: "impersonate",
    impersonate_input: input,
  });
  return { chatId: chat.id, generationId, requestIndex };
}

describe("stop generation", () => {
  test("ordinary inline tool round exhaustion finalizes pending calls", async () => {
    const previousWorkerSetting = process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
    const previousCouncilSettings = councilSettingsSvc.getCouncilSettings(USER_ID);
    const previousWebSearchSettings = await getWebSearchSettings(USER_ID);
    rootFixtureToolExecutions = 0;
    rootFixtureToolQueries = [];
    rootFixtureActive = true;
    registerHostCouncilTool("web_search", async ({ args }) => {
      rootFixtureToolExecutions += 1;
      rootFixtureToolQueries.push(
        typeof args.query === "string" ? args.query : "",
      );
      return `fixture-result-${rootFixtureToolExecutions}`;
    });

    try {
      process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = "false";
      await putWebSearchSettings(USER_ID, {
        enabled: true,
        apiUrl: "http://fixture.invalid",
      });
      councilSettingsSvc.putCouncilSettings(USER_ID, {
        councilMode: true,
        members: [{
          id: "fixture",
          packId: "fixture-pack",
          packName: "Fixture Pack",
          itemId: "fixture-item",
          itemName: "Fixture Member",
          tools: ["web_search"],
          role: "Fixture",
          chance: 100,
        }],
        toolsSettings: { mode: "inline" },
      });

      const chat = chatsSvc.createChat(USER_ID, {
        character_id: null,
        name: "Inline Tool Limit Test",
        metadata: { temporary: true },
      });
      chatsSvc.createMessage(
        chat.id,
        {
          is_user: true,
          name: "User",
          content: "ROOT_INLINE_TOOL_LIMIT",
        },
        USER_ID,
      );

      const requestIndex = requests.length;
      await genSvc.startGeneration({
        userId: USER_ID,
        chat_id: chat.id,
        connection_id: connectionId,
        preset_id: presetId,
        generation_type: "normal",
      } as any);
      expect(await waitFor(
        () => rootFixtureToolExecutions >= 3,
        5_000,
      )).toBe(true);
      expect(await waitFor(() => {
        const status = poolSvc.getPoolForChat(USER_ID, chat.id)?.status;
        return status === "completed" || status === "error" || status === "stopped";
      }, 5_000)).toBe(true);

      const fixtureRequests = requests
        .slice(requestIndex)
        .filter((request) => request.kind === "root-inline");
      expect(fixtureRequests.slice(0, 3)).toHaveLength(3);
      expect(rootFixtureToolExecutions).toBe(3);
      expect(rootFixtureToolQueries).toEqual([
        "fixture-0",
        "fixture-1",
        "fixture-2",
      ]);
      expect(fixtureRequests).toHaveLength(4);

      expect(fixtureRequests.slice(0, 3).every((request) => {
        const tools = request.body.tools;
        return Array.isArray(tools) && tools.length > 0;
      })).toBe(true);
      const finalizationTools = fixtureRequests[3]!.body.tools;
      expect(finalizationTools === undefined || (
        Array.isArray(finalizationTools) && finalizationTools.length === 0
      )).toBe(true);
      const serializedRequests = fixtureRequests.map(
        (request) => JSON.stringify(request.body),
      );
      expect(serializedRequests[1]).toContain("fixture-result-1");
      expect(serializedRequests[2]).toContain("fixture-result-2");
      expect(serializedRequests[3]).toContain("fixture-result-3");

      const messages = chatsSvc.getMessages(USER_ID, chat.id);
      const assistant = messages.find(
        (message) =>
          !message.is_user &&
          message.content.includes("finalized after tool rounds"),
      );
      expect(assistant?.content).toBe("finalized after tool rounds");
    } finally {
      rootFixtureActive = false;
      if (previousWorkerSetting === undefined) {
        delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
      } else {
        process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = previousWorkerSetting;
      }
      councilSettingsSvc.putCouncilSettings(USER_ID, previousCouncilSettings);
      await putWebSearchSettings(USER_ID, {
        enabled: previousWebSearchSettings.enabled,
        apiUrl: previousWebSearchSettings.apiUrl,
      });
    }
  });
  test("chat settings override the requested connection profile and its default model", async () => {
    const requestIndex = requests.length;
    const chat = chatsSvc.createChat(USER_ID, {
      character_id: null,
      name: "Chat-bound Connection Test",
      metadata: { temporary: true, connection_profile_id: chatConnectionId },
    });
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Go." }, USER_ID);

    const { generationId } = await genSvc.startGeneration({
      userId: USER_ID,
      chat_id: chat.id,
      connection_id: connectionId,
      preset_id: presetId,
      generation_type: "normal",
    } as any);

    expect(poolSvc.getPoolForChat(USER_ID, chat.id)?.model).toBe("chat-profile-model");
    expect(await waitFor(() => requests[requestIndex]?.sent >= 1, 5000)).toBe(true);
    expect(requests[requestIndex].model).toBe("chat-profile-model");
    expect(await genSvc.stopGeneration(USER_ID, generationId)).toBe(true);
  });

  test("chat settings can override the bound connection's model", async () => {
    const requestIndex = requests.length;
    const chat = chatsSvc.createChat(USER_ID, {
      character_id: null,
      name: "Chat-bound Model Test",
      metadata: {
        temporary: true,
        connection_profile_id: chatConnectionId,
        connection_model: "chat-model-override",
      },
    });
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Go." }, USER_ID);

    const { generationId } = await genSvc.startGeneration({
      userId: USER_ID,
      chat_id: chat.id,
      connection_id: connectionId,
      preset_id: presetId,
      generation_type: "normal",
    } as any);

    expect(poolSvc.getPoolForChat(USER_ID, chat.id)?.model).toBe("chat-model-override");
    expect(await waitFor(() => requests[requestIndex]?.sent >= 1, 5000)).toBe(true);
    expect(requests[requestIndex].model).toBe("chat-model-override");
    expect(await genSvc.stopGeneration(USER_ID, generationId)).toBe(true);
  });
  test("stopGeneration aborts the stream and the upstream server sees the disconnect", async () => {
    const { chatId, generationId, state } = await startStreamingGeneration();

    expect(await genSvc.stopGeneration(USER_ID, generationId)).toBe(true);

    // The upstream server must observe the close promptly — this is what
    // makes a local llama.cpp actually stop generating and free its slot.
    expect(await waitFor(() => state.cancelled, 2000)).toBe(true);
    expect(await waitFor(() => poolSvc.getPoolForChat(USER_ID, chatId)?.status === "stopped", 2000)).toBe(true);
  });

  test("stopGeneration is user-scoped and misses unknown ids", async () => {
    const { chatId, generationId, state } = await startStreamingGeneration();

    expect(await genSvc.stopGeneration("someone-else", generationId)).toBe(false);
    expect(await genSvc.stopGeneration(USER_ID, "no-such-generation")).toBe(false);
    expect(state.cancelled).toBe(false);

    // The /generate/stop fallback: a stale id still stops the chat's
    // active generation instead of silently no-opping.
    expect(await genSvc.stopChatGenerations(USER_ID, chatId)).toBe(true);
    expect(await waitFor(() => state.cancelled, 2000)).toBe(true);
  });

  test("stopChatGenerations reports false when nothing is running", async () => {
    expect(await genSvc.stopChatGenerations(USER_ID, "idle-chat")).toBe(false);
  });

  test("generation sweep allows streams that keep receiving tokens beyond ten minutes", async () => {
    const { generationId, state } = await startStreamingGeneration();
    const realNow = Date.now;
    const currentTime = realNow();
    let mockNow = currentTime + 10 * 60 * 1000 + 1;
    Date.now = () => mockNow;

    try {
      // A token received after the request has crossed the former hard cap
      // refreshes the inactivity deadline instead of terminating the stream.
      await new Promise((resolve) => setTimeout(resolve, 30));
      genSvc.sweepInactiveGenerations();
      expect(state.cancelled).toBe(false);
    } finally {
      await genSvc.stopGeneration(USER_ID, generationId);
    }
  });

  test("generation sweep aborts a stream that stops producing tokens", async () => {
    const { generationId, state } = await startStreamingGeneration();
    state.paused = true;
    // Let an already-scheduled interval tick observe the pause.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000 + 1;
    try {
      genSvc.sweepInactiveGenerations();
    } finally {
      Date.now = realNow;
    }

    expect(await genSvc.stopGeneration(USER_ID, generationId)).toBe(false);
  });

  test("does not persist intrinsic activity on a successful impersonated user message", async () => {
    const { chatId } = await startImpersonateAgentGeneration(
      "SECURITY_IMPERSONATE_SUCCESS",
    );
    expect(await waitFor(
      () => poolSvc.getPoolForChat(USER_ID, chatId)?.status === "completed",
      5_000,
    )).toBe(true);

    const messages = chatsSvc.getMessages(USER_ID, chatId);
    const impersonated = messages.find(
      (message) =>
        message.is_user &&
        message.content.includes("impersonated result"),
    );
    expect(impersonated).toBeDefined();
    expect(impersonated?.extra.agentActivity).toBeUndefined();
    expect(impersonated?.extra.agentActivityBySwipe).toBeUndefined();
  });

  test("does not persist intrinsic activity on a partially stopped impersonated user message", async () => {
    const { chatId, generationId, requestIndex } =
      await startImpersonateAgentGeneration("SECURITY_IMPERSONATE_PARTIAL");
    expect(await waitFor(
      () => requests
        .slice(requestIndex)
        .some((request) => request.kind === "root" && request.sent >= 3),
      5_000,
    )).toBe(true);

    expect(await genSvc.stopGeneration(USER_ID, generationId)).toBe(true);
    expect(await waitFor(
      () => poolSvc.getPoolForChat(USER_ID, chatId)?.status === "stopped",
      2_000,
    )).toBe(true);

    const messages = chatsSvc.getMessages(USER_ID, chatId);
    const impersonated = messages.find(
      (message) => message.is_user && message.content.includes("tok"),
    );
    expect(impersonated).toBeDefined();
    expect(impersonated?.extra.agentActivity).toBeUndefined();
    expect(impersonated?.extra.agentActivityBySwipe).toBeUndefined();
  });
});

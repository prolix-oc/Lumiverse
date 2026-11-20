import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type { McpDiscoveredTool } from "../types/mcp-server";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as presets from "./presets.service";
import { setChatBinding } from "./preset-profiles.service";
import * as pool from "./generation-pool.service";
import * as assemblyWorker from "./prompt-assembly-worker-client";
import { getMcpClientManager } from "./mcp-client-manager";
import { putCouncilSettings } from "./council/council-settings.service";
import { dryRunGeneration, startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const userId = "mcp-inline-test";
const serverId = "23d97e36-8f87-48cd-81ea-13c04ef947c5";
const otherServerId = "ab8b914a-e262-478e-a28f-ea86bc344f78";
const schema = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "integer" } },
  required: ["query"],
};
function tool(name = "lookup", id = serverId): McpDiscoveredTool {
  return { server_id: id, server_name: id === serverId ? "Reference server" : "Other server",
    name, description: `Find references with ${name}.`, input_schema: schema };
}

let discovered = [tool()];
const ended: Array<{ generationId: string; error?: string }> = [];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
let secretSpy: ReturnType<typeof spyOn<typeof secrets, "getSecret">>;
let eventSpy: ReturnType<typeof spyOn<typeof eventBus, "emit">>;
let assemblySpy: ReturnType<typeof spyOn<typeof assemblyWorker, "canUsePromptAssemblyWorker">>;
const manager = getMcpClientManager();
let toolsSpy: ReturnType<typeof spyOn<typeof manager, "getDiscoveredTools">>;
let connectedSpy: ReturnType<typeof spyOn<typeof manager, "getAllConnected">>;
let callSpy: ReturnType<typeof spyOn<typeof manager, "callTool">>;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
  });
  assemblySpy = spyOn(assemblyWorker, "canUsePromptAssemblyWorker").mockReturnValue(false);
  toolsSpy = spyOn(manager, "getDiscoveredTools").mockImplementation((id) => id === userId ? discovered : []);
  connectedSpy = spyOn(manager, "getAllConnected").mockImplementation((id) => id === userId
    ? [...new Set(discovered.map((value) => value.server_id))].map((id) => ({
        id, connected: true, tool_count: 1, tools: discovered.filter((value) => value.server_id === id),
      })) : []);
  callSpy = spyOn(manager, "callTool").mockResolvedValue("MCP_RESULT");
});

afterEach(async () => {
  await Bun.sleep(5);
  fetchSpy?.mockRestore();
  callSpy.mockClear();
  discovered = [tool()];
  putCouncilSettings(userId, { councilMode: false, members: [] });
});

afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  pool.stopPoolSweep();
  pool.clearAllPoolEntries();
  for (const spy of [secretSpy, eventSpy, assemblySpy, toolsSpy, connectedSpy, callSpy]) spy.mockRestore();
  closeDatabase();
});

type Provider = "google" | "anthropic" | "openai";
function definitions(request: any, provider: Provider): any[] {
  if (provider === "google") return request.tools?.[0]?.functionDeclarations ?? [];
  if (provider === "openai") return (request.tools ?? []).map((value: any) => value.function);
  return request.tools ?? [];
}

async function run(options: {
  provider?: Provider; functionCalling?: boolean; macro?: string; noPreset?: boolean;
  impersonate?: boolean; owner?: string; councilOnly?: boolean; dryRun?: boolean;
  boundFunctionCalling?: boolean; forcePreset?: boolean;
} = {}) {
  const provider = options.provider ?? "google";
  const owner = options.owner ?? userId;
  const connection = await connections.createConnection(owner, {
    name: "MCP mock", provider, model: "test-model", api_url: "https://example.test",
  });
  const preset = options.noPreset ? null : presets.createPreset(owner, {
    name: "MCP test", provider,
    prompts: { completionSettings: { enableFunctionCalling: options.functionCalling ?? true } },
    prompt_order: [
      { id: "history", name: "History", content: "", enabled: true, role: "user", marker: "chat_history",
        position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null },
      ...(options.macro ? [{
        id: "tools", name: "Tools", content: `BEGIN ${options.macro} END`, enabled: true,
        role: "system", marker: null, position: "post_history", depth: 0,
        isLocked: false, color: null, injectionTrigger: [], group: null,
      }] : []),
    ],
  });
  const chat = chats.createChat(owner, {
    character_id: null, name: "Test", metadata: { temporary: true, ...(preset ? {} : { no_preset: true }) },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Find a reference." }, owner);
  if (options.boundFunctionCalling !== undefined) {
    const boundPreset = presets.createPreset(owner, {
      name: "Chat-bound MCP preset", provider, prompt_order: preset!.prompt_order,
      prompts: { completionSettings: { enableFunctionCalling: options.boundFunctionCalling } },
    });
    setChatBinding(owner, chat.id, boundPreset.id, {});
  }
  const input = {
    userId: owner, chat_id: chat.id, connection_id: connection.id, preset_id: preset?.id,
    force_preset_id: options.forcePreset,
    parameters: { _streaming: false },
    ...(options.impersonate ? { generation_type: "impersonate" as const } : {}),
  };
  if (options.dryRun) return { requests: [], preview: await dryRunGeneration(input) };

  const requests: any[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    const request = JSON.parse(init?.body as string);
    requests.push(request);
    const available = definitions(request, provider);
    const calls = requests.length === 1
      ? available.filter((value) => !options.councilOnly || value.description.startsWith("[Mira]"))
        .map((value, index) => ({ name: value.name, args: { query: `Query ${index}` } }))
      : [];
    if (provider === "google") return Response.json({
      candidates: [{ content: { parts: calls.length ? calls.map((call) => ({ functionCall: call })) : [{ text: "Done." }] }, finishReason: "STOP" }],
    });
    if (provider === "anthropic") return Response.json({
      content: calls.length ? calls.map((call, index) => ({ type: "tool_use", id: `call_${index}`, name: call.name, input: call.args })) : [{ type: "text", text: "Done." }],
      stop_reason: calls.length ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 7 },
    });
    return Response.json({
      choices: [{ message: calls.length ? { content: "", tool_calls: calls.map((call, index) => ({
        id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) } : { content: "Done." }, finish_reason: calls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
  }) as typeof fetch);
  const generation = await startGeneration(input);
  const deadline = Date.now() + 3_000;
  while (!ended.some((event) => event.generationId === generation.generationId) && Date.now() < deadline) await Bun.sleep(5);
  const event = ended.find((value) => value.generationId === generation.generationId);
  expect(event).toBeDefined();
  expect(event?.error).toBeUndefined();
  return { requests, preview: undefined };
}

describe("MCP tools in primary generation", () => {
  for (const provider of ["google", "anthropic", "openai"] as const) {
    test(`advertises tools and returns their results through ${provider} without Council`, async () => {
      const { requests } = await run({ provider });
      expect(requests).toHaveLength(2);
      const [definition] = definitions(requests[0], provider);
      expect(definition.name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
      expect(definition.description).toContain("Find references");
      expect(definition.parameters ?? definition.input_schema).toEqual(schema);
      if (provider !== "google") expect(definition.strict).toBe(false);
      expect(callSpy.mock.calls).toEqual([[userId, serverId, "lookup", { query: "Query 0" }, expect.any(Number)]]);
      expect(JSON.stringify(requests[1])).toContain("MCP_RESULT");
    });
  }

  test("routes identically named tools to their own servers", async () => {
    discovered = [tool(), tool("lookup", otherServerId)];
    const { requests } = await run();
    expect(new Set(definitions(requests[0], "google").map((value) => value.name)).size).toBe(2);
    expect(callSpy.mock.calls.map((call) => call.slice(1, 3))).toEqual([[serverId, "lookup"], [otherServerId, "lookup"]]);
  });

  test("preserves distinct dotted, underscored, and long tool names", async () => {
    discovered = [tool("reference.lookup"), tool("reference_lookup"), tool(`lookup_${"x".repeat(100)}`)];
    const { requests } = await run();
    const aliases = definitions(requests[0], "google").map((value) => value.name);
    expect(new Set(aliases).size).toBe(3);
    for (const alias of aliases) expect(alias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    expect(callSpy.mock.calls.map((call) => call[2])).toEqual(discovered.map((value) => value.name));
  });

  for (const options of [{ functionCalling: false }, { impersonate: true }, { owner: "other-user" }]) {
    test(`omits MCP tools and their prompt list for ${JSON.stringify(options)}`, async () => {
      const { requests } = await run({ ...options, macro: "{{mcpToolsActive}} {{mcpTools}}" });
      expect(requests).toHaveLength(1);
      expect(definitions(requests[0], "google")).toEqual([]);
      expect(JSON.stringify(requests[0])).not.toContain("Find references");
      expect(callSpy).not.toHaveBeenCalled();
    });
  }

  test("omits disconnected tools", async () => {
    discovered = [];
    const { requests } = await run({ macro: "{{mcpTools}}" });
    expect(definitions(requests[0], "google")).toEqual([]);
    expect(callSpy).not.toHaveBeenCalled();
  });

  test("supports no-preset temporary chats", async () => {
    const { requests } = await run({ noPreset: true });
    expect(definitions(requests[0], "google")).toHaveLength(1);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  test("places MCP descriptions only in the requested preset block", async () => {
    const { requests } = await run({ macro: "{{if::{{mcpToolsActive}}}}{{mcpTools}}{{/if}}" });
    const alias = definitions(requests[0], "google")[0].name;
    const contents = requests[0].contents;
    expect(contents[0].parts[0].text).toBe("Find a reference.");
    expect(contents[1].role).toBe("user"); // Gemini carries system blocks after history as user content.
    expect(contents[1].parts[0].text).toContain(`BEGIN **Available MCP tools:**\n- **${alias}**:`);
    expect(contents[1].parts[0].text).toContain("Reference server");
    expect(contents[1].parts[0].text).toContain("Find references");
    expect(contents[1].parts[0].text).toEndWith(" END");
    expect(JSON.stringify(contents).match(/Available MCP tools/g)).toHaveLength(1);
  });

  test("keeps server descriptions literal during macro evaluation", async () => {
    discovered[0]!.description = "Literal {{user}} {{setvar::mcpInjected::yes}}";
    const { requests } = await run({ macro: "{{mcpTools}} {{getvar::mcpInjected}}" });
    const text = JSON.stringify(requests[0].contents);
    expect(text).toContain("Literal {{user}} {{setvar::mcpInjected::yes}}");
    expect(text).toContain(" END");
    expect(text).not.toContain("yes END");
  });

  test("renders the same tool descriptions in prompt previews", async () => {
    const { preview } = await run({ macro: "{{mcpTools}}", dryRun: true });
    expect(JSON.stringify(preview)).toContain("Available MCP tools");
    expect(JSON.stringify(preview)).toContain("Find references");
    expect(callSpy).not.toHaveBeenCalled();
  });

  test("follows a chat-bound preset that enables function calling", async () => {
    const { requests } = await run({ functionCalling: false, boundFunctionCalling: true, macro: "{{mcpTools}}" });
    expect(definitions(requests[0], "google")).toHaveLength(1);
    expect(JSON.stringify(requests[0].contents)).toContain("Available MCP tools");
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  test("follows a chat-bound preset that disables function calling", async () => {
    const { requests } = await run({ boundFunctionCalling: false, macro: "{{mcpTools}}" });
    expect(definitions(requests[0], "google")).toEqual([]);
    expect(JSON.stringify(requests[0].contents)).not.toContain("Available MCP tools");
    expect(callSpy).not.toHaveBeenCalled();
  });

  test("respects an explicitly forced preset over the chat binding", async () => {
    const { requests } = await run({ boundFunctionCalling: false, forcePreset: true, macro: "{{mcpTools}}" });
    expect(definitions(requests[0], "google")).toHaveLength(1);
    expect(JSON.stringify(requests[0].contents)).toContain("Available MCP tools");
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  test("advertises and dispatches Council MCP aliases with digit-leading member IDs", async () => {
    putCouncilSettings(userId, {
      councilMode: true,
      members: [{ id: "23d97e36-member", itemId: "missing-item", itemName: "Mira", packId: "missing-pack", packName: "Test",
        role: "", chance: 100, tools: [`mcp:${serverId.slice(0, 8)}:lookup`] }],
      toolsSettings: { mode: "inline" } as never,
    });
    const { requests } = await run({ councilOnly: true });
    const available = definitions(requests[0], "google");
    expect(available).toHaveLength(2);
    for (const value of available) expect(value.name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    expect(callSpy.mock.calls).toEqual([[userId, serverId, "lookup", { query: "Query 0" }, expect.any(Number)]]);
  });
});

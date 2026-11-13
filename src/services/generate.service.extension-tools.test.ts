import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ToolRegistration } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { toolRegistry } from "../spindle/tool-registry";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "./chats.service";
import * as connections from "./connections.service";
import * as secrets from "./secrets.service";
import * as pool from "./generation-pool.service";
import * as toolRuntime from "./council/tool-runtime";
import * as assemblyWorker from "./prompt-assembly-worker-client";
import { startGeneration, stopAllGenerations, stopGenerationSweep } from "./generate.service";

const userId = "extension-tool-alias-test";
const digitId = "23d97e36-8f87-48cd-81ea-13c04ef947c5";
const letterId = "ab8b914a-e262-478e-a28f-ea86bc344f78";
const ended: Array<{ generationId: string; error?: string }> = [];
const registered: ToolRegistration[] = [];
let connectionId: string;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
let secretSpy: ReturnType<typeof spyOn<typeof secrets, "getSecret">>;
let eventSpy: ReturnType<typeof spyOn<typeof eventBus, "emit">>;
let invokeSpy: ReturnType<typeof spyOn<typeof toolRuntime, "invokeExtensionCouncilTool">>;
let assemblySpy: ReturnType<typeof spyOn<typeof assemblyWorker, "canUsePromptAssemblyWorker">>;

beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  secretSpy = spyOn(secrets, "getSecret").mockResolvedValue("test-key");
  eventSpy = spyOn(eventBus, "emit").mockImplementation((type, payload) => {
    if (type === EventType.GENERATION_ENDED) ended.push(payload);
  });
  invokeSpy = spyOn(toolRuntime, "invokeExtensionCouncilTool").mockResolvedValue("Delivered.");
  // An assembly worker cannot access the test's in-memory database.
  assemblySpy = spyOn(assemblyWorker, "canUsePromptAssemblyWorker").mockReturnValue(false);
  connectionId = (await connections.createConnection(userId, {
    name: "Gemini mock", provider: "google", model: "gemini-3-flash", api_url: "https://example.test",
  })).id;
});

afterEach(async () => {
  // Let generation cleanup finish before restoring the provider transport.
  await Bun.sleep(5);
  fetchSpy?.mockRestore();
  invokeSpy.mockClear();
  for (const registration of registered.splice(0)) {
    toolRegistry.unregister(registration.name, registration.extension_id);
  }
});

afterAll(() => {
  stopAllGenerations();
  stopGenerationSweep();
  pool.stopPoolSweep();
  pool.clearAllPoolEntries();
  secretSpy.mockRestore();
  eventSpy.mockRestore();
  invokeSpy.mockRestore();
  assemblySpy.mockRestore();
  closeDatabase();
});

function register(extensionId: string, name: string): ToolRegistration {
  const registration: ToolRegistration = {
    extension_id: extensionId,
    name,
    display_name: "Deliver phone text",
    description: "Deliver a phone text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    inline_available: true,
  };
  toolRegistry.register(registration);
  registered.push(registration);
  return registration;
}

async function run(aliases: string[]) {
  const requests: any[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    requests.push(JSON.parse(init?.body as string));
    const parts = requests.length === 1
      ? aliases.map((name, index) => ({
          functionCall: { name, args: { text: `Message ${index}` } },
          thoughtSignature: `signature-${index}`,
        }))
      : [{ text: "Sent." }];
    const response = {
      candidates: [{ content: { parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
    };
    return new Response(`data: ${JSON.stringify(response)}\n\n`);
  }) as typeof fetch);

  const chat = chats.createChat(userId, {
    character_id: null, name: "Test", metadata: { temporary: true, no_preset: true },
  });
  chats.createMessage(chat.id, { is_user: true, name: "User", content: "Send a text." }, userId);
  const generation = await startGeneration({ userId, chat_id: chat.id, connection_id: connectionId });
  const deadline = Date.now() + 3_000;
  while (!ended.some((event) => event.generationId === generation.generationId) && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const event = ended.find((value) => value.generationId === generation.generationId);
  expect(event).toBeDefined();
  expect(event?.error).toBeUndefined();
  return requests;
}

describe("extension inline tool aliases", () => {
  for (const [extensionId, toolName, alias] of [
    [digitId, "deliver_phone_text", `_${digitId}__deliver_phone_text`],
    [letterId, "deliver_phone_text", `${letterId}__deliver_phone_text`],
    ["_extension", "deliver_phone_text", "_extension__deliver_phone_text"],
    [letterId, "deliver__phone_text", `${letterId}__deliver__phone_text`],
  ]) {
    test(`advertises and dispatches ${alias}`, async () => {
      const registration = register(extensionId, toolName);
      const requests = await run([alias]);

      expect(requests).toHaveLength(2);
      expect(requests[0].tools[0].functionDeclarations[0].name).toBe(alias);
      expect(alias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
      expect(invokeSpy).toHaveBeenCalledTimes(1);
      expect(invokeSpy.mock.calls[0]).toMatchObject([
        extensionId, toolName, { text: "Message 0", context: expect.any(String), __deadlineMs: expect.any(Number) },
        expect.any(Number), userId, undefined, expect.any(Array),
      ]);
      expect(toolRegistry.getToolQualified(`${extensionId}:${toolName}`)).toBe(registration);

      const parts = requests[1].contents.flatMap((content: any) => content.parts);
      expect(parts).toContainEqual({
        functionCall: { name: alias, args: { text: "Message 0" } }, thoughtSignature: "signature-0",
      });
      expect(parts).toContainEqual({ functionResponse: { name: alias, response: { output: "Delivered." } } });
      expect(requests[1].tools[0].functionDeclarations[0].name).toBe(alias);
    });
  }

  test("routes identically named tools to their owning installations", async () => {
    register(letterId, "deliver_phone_text");
    register(digitId, "deliver_phone_text");
    await run([`_${digitId}__deliver_phone_text`, `${letterId}__deliver_phone_text`]);

    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(invokeSpy.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [digitId, "deliver_phone_text"],
      [letterId, "deliver_phone_text"],
    ]);
  });
});

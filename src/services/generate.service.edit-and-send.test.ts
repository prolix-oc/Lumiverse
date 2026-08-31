import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Message } from "../types/message";
import type { Chat } from "../types/chat";
import type { ConnectionProfile } from "../types/connection-profile";
import type { LlmProvider } from "../llm/provider";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import * as settingsSvc from "./settings.service";
import * as personasSvc from "./personas.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import * as chatBackground from "./chat-background.service";
import * as llmRegistry from "../llm/registry";
import * as pool from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import {
  startGeneration,
  stopAllGenerations,
  stopGenerationSweep,
} from "./generate.service";

const USER = "u1";
const CHAT = "chat-1";
const GENERATION_ID = "gen-deterministic-1";
const ASSISTANT_ID = "asst-1";
const USER_MSG_ID = "user-1";
const resolveCouncilProfile = councilProfilesSvc.resolveProfile;

const connection: ConnectionProfile = {
  id: "conn-1",
  name: "Mock",
  provider: "openai",
  api_url: "https://example.test/v1",
  model: "gpt-test",
  preset_id: null,
  is_default: true,
  has_api_key: true,
  review_required: false,
  review_code: null,
  metadata: {},
  created_at: 1,
  updated_at: 1,
};

const chat: Chat = {
  id: CHAT,
  character_id: null,
  name: "Chat",
  metadata: { temporary: true, no_preset: true },
  created_at: 1,
  updated_at: 1,
};

const mockProvider = {
  name: "openai",
  displayName: "OpenAI",
  defaultUrl: "https://example.test/v1",
  capabilities: {
    apiKeyRequired: true,
    supportsStreaming: true,
    supportsSystemRole: true,
    requiresMaxTokens: false,
    parameters: {},
    modelListStyle: "openai",
  },
  generate: async () => ({ content: "" }),
  generateStream: async function* () {},
  validateKey: async () => true,
  listModels: async () => [],
} as unknown as LlmProvider;



function initRuntimeDecisionDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0,
    user_id TEXT,
    review_required INTEGER NOT NULL DEFAULT 0,
    review_code TEXT
  )`);
  db.run(`CREATE TABLE secrets (
    key TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  db.query(`INSERT INTO connection_profiles
    (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id, review_required, review_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    connection.id,
    connection.name,
    connection.provider,
    connection.api_url,
    connection.model,
    connection.preset_id,
    connection.is_default ? 1 : 0,
    JSON.stringify(connection.metadata),
    connection.created_at,
    connection.updated_at,
    connection.has_api_key ? 1 : 0,
    USER,
    connection.review_required ? 1 : 0,
    connection.review_code,
  );
}
function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: USER_MSG_ID,
    chat_id: CHAT,
    index_in_chat: 1,
    is_user: true,
    name: "User",
    content: "hello",
    send_date: 1,
    swipe_id: 0,
    swipes: ["hello"],
    swipe_dates: [1],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 1,
    ...overrides,
  };
}

describe("startGeneration edit-and-send", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  let assistant: Message;
  let addSwipe: ReturnType<typeof spyOn>;
  let createMessage: ReturnType<typeof spyOn>;

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  beforeEach(() => {
    initRuntimeDecisionDb();
    assistant = baseMessage({
      id: ASSISTANT_ID,
      index_in_chat: 2,
      is_user: false,
      name: "Assistant",
      content: "reply",
      swipes: ["reply"],
      swipe_dates: [1],
    });

    track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
    track(spyOn(connectionsSvc, "resolveConnection").mockReturnValue(connection));
    track(spyOn(secretsSvc, "getSecret").mockResolvedValue("sk-test"));
    track(spyOn(settingsSvc, "getSetting").mockReturnValue(null));
    track(spyOn(personasSvc, "resolvePersonaOrDefault").mockReturnValue(null));
    track(spyOn(llmRegistry, "getProvider").mockReturnValue(mockProvider));
    track(spyOn(eventBus, "emit").mockImplementation(() => true));
    let councilProfileCallCount = 0;
    track(spyOn(councilProfilesSvc, "resolveProfile").mockImplementation((...args) => {
      councilProfileCallCount += 1;
      if (councilProfileCallCount % 2 === 1) return resolveCouncilProfile(...args);
      throw new Error("skip-assembly");
    }));
    track(spyOn(chatsSvc, "getChat").mockReturnValue(chat));
    track(spyOn(chatsSvc, "getTrailingVisibleUserMessageIds").mockReturnValue([USER_MSG_ID]));
    track(spyOn(chatsSvc, "getLastMessage").mockImplementation(() =>
      assistant.swipes.length > 1 ? assistant : baseMessage(),
    ));
    track(spyOn(chatsSvc, "getLastAssistantMessage").mockImplementation(() => assistant));
    track(spyOn(chatsSvc, "getMessage").mockImplementation((_userId, messageId) => {
      if (messageId === ASSISTANT_ID) return assistant;
      if (messageId === USER_MSG_ID) return baseMessage();
      return null;
    }));
    track(spyOn(chatsSvc, "deleteMessage").mockImplementation(() => true));
    track(spyOn(chatsSvc, "deleteSwipe").mockImplementation(() => assistant));
    track(spyOn(chatsSvc, "patchMessageExtra").mockImplementation(() => assistant));

    addSwipe = track(spyOn(chatsSvc, "addSwipe").mockImplementation((_userId, messageId) => {
      expect(messageId).toBe(ASSISTANT_ID);
      assistant = {
        ...assistant,
        swipes: [...assistant.swipes, ""],
        swipe_dates: [...assistant.swipe_dates, 2],
        swipe_id: assistant.swipes.length,
        content: "",
      };
      return assistant;
    }));
    createMessage = track(spyOn(chatsSvc, "createMessage").mockImplementation(() => {
      throw new Error("normal generation must not pre-create a placeholder");
    }));
  });

  afterEach(async () => {
    await stopAllGenerations();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    pool.clearAllPoolEntries();
    stopGenerationSweep();
    await chatsSvc.waitForChatChunkMaintenance();
    for (const spy of spies.splice(0)) spy.mockRestore();
    closeDatabase();
  });

  test("passes the branched swipe target exactly once", async () => {
    const started = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });

    expect(started).toEqual({ generationId: GENERATION_ID, status: "streaming" });
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(addSwipe.mock.calls[0]?.[1]).toBe(ASSISTANT_ID);
    expect(createMessage).not.toHaveBeenCalled();
    expect(pool.getPoolEntry(GENERATION_ID)?.targetMessageId).toBe(ASSISTANT_ID);
    expect(pool.getPoolEntry(GENERATION_ID)?.targetSwipeId).toBe(1);
  });

  test("uses normal generation exactly once without a precreated placeholder", async () => {
    const started = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "normal",
    });

    expect(started).toEqual({ generationId: GENERATION_ID, status: "streaming" });
    expect(createMessage).not.toHaveBeenCalled();
    expect(addSwipe).not.toHaveBeenCalled();
    expect(pool.getPoolEntry(GENERATION_ID)?.generationId).toBe(GENERATION_ID);
    expect(pool.getPoolEntry(GENERATION_ID)?.targetMessageId).toBeUndefined();
  });

  test("returns the same persisted target for generationId replay", async () => {
    const first = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });
    const second = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });

    expect(first.generationId).toBe(GENERATION_ID);
    expect(second).toEqual(first);
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
    expect(pool.getPoolEntry(GENERATION_ID)?.targetMessageId).toBe(ASSISTANT_ID);
    expect(pool.getPoolEntry(GENERATION_ID)?.targetSwipeId).toBe(1);
  });

  test("recovers crash after target staging before outbox update", async () => {
    const first = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });
    expect(first.generationId).toBe(GENERATION_ID);
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(assistant.swipes).toEqual(["reply", ""]);

    await stopAllGenerations();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    pool.removePoolEntry(GENERATION_ID);

    const recovered = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });

    expect(recovered).toEqual({ generationId: GENERATION_ID, status: "streaming" });
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
    expect(assistant.swipes).toEqual(["reply", ""]);
    expect(pool.getPoolEntry(GENERATION_ID)?.targetMessageId).toBe(ASSISTANT_ID);
    expect(pool.getPoolEntry(GENERATION_ID)?.targetSwipeId).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Message } from "../types/message";
import type { Chat } from "../types/chat";
import type { ConnectionProfile } from "../types/connection-profile";
import type { LlmProvider } from "../llm/provider";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { EventType } from "../ws/events";
import { contextHandlerChain } from "../spindle/context-handler";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import * as settingsSvc from "./settings.service";
import * as personasSvc from "./personas.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import * as chatBackground from "./chat-background.service";
import * as llmRegistry from "../llm/registry";
import * as pool from "./generation-pool.service";
import * as embeddingsSvc from "./embeddings.service";
import * as assemblyWorker from "./prompt-assembly-worker-client";
import { eventBus } from "../ws/bus";
import { getActiveGeneration } from "./generation/active-generation-registry";
import { readMessageRevision } from "../utils/message-revision";
import {
  getActiveChatGeneration,
  startGeneration,
  stopAllGenerations,
  stopGenerationSweep,
} from "./generate.service";

const USER = "u1";
const CHAT = "chat-1";
const GENERATION_ID = "gen-deterministic-1";
const ASSISTANT_ID = "asst-1";
const USER_MSG_ID = "user-1";

const connection: ConnectionProfile = {
  id: "conn-1",
  name: "Mock",
  provider: "openai",
  api_url: "https://example.test/v1",
  model: "gpt-test",
  preset_id: null,
  is_default: true,
  has_api_key: true,
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
  let editedUserMessage: Message & { revision?: number };
  let addSwipe: ReturnType<typeof spyOn>;
  let createMessage: ReturnType<typeof spyOn>;
  let getMessageSpy: ReturnType<typeof spyOn>;

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  beforeEach(() => {
    assistant = baseMessage({
      id: ASSISTANT_ID,
      index_in_chat: 2,
      is_user: false,
      name: "Assistant",
      content: "reply",
      swipes: ["reply"],
      swipe_dates: [1],
    });
    // The Edit-and-Send edited user message: commit revision 5, owned by CHAT.
    // Tests may reconfigure it (advance revision, move chat) to exercise the
    // stale/foreign-target guards.
    editedUserMessage = { ...baseMessage(), revision: 5 };

    track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
    track(spyOn(connectionsSvc, "resolveConnection").mockReturnValue(connection));
    track(spyOn(secretsSvc, "getSecret").mockResolvedValue("sk-test"));
    track(spyOn(settingsSvc, "getSetting").mockReturnValue(null));
    track(spyOn(settingsSvc, "getSettingAsync").mockResolvedValue(null));
    track(spyOn(personasSvc, "resolvePersonaOrDefault").mockReturnValue(null));
    track(spyOn(personasSvc, "resolvePersonaOrDefaultAsync").mockResolvedValue(null));
    track(spyOn(llmRegistry, "getProvider").mockReturnValue(mockProvider));
    track(spyOn(eventBus, "emit").mockImplementation(() => {}));
    track(
      spyOn(councilProfilesSvc, "resolveProfile").mockImplementation(() => {
        throw new Error("skip-assembly");
      }),
    );
    track(spyOn(chatsSvc, "getChat").mockReturnValue(chat));
    track(spyOn(chatsSvc, "getChatAsync").mockResolvedValue(chat));
    track(spyOn(chatsSvc, "getTrailingVisibleUserMessageIds").mockReturnValue([USER_MSG_ID]));
    track(spyOn(chatsSvc, "getLastMessage").mockImplementation(() =>
      assistant.swipes.length > 1 ? assistant : baseMessage(),
    ));
    track(spyOn(chatsSvc, "getLastAssistantMessage").mockImplementation(() => assistant));
    getMessageSpy = track(spyOn(chatsSvc, "getMessage").mockImplementation((_userId, messageId) => {
      if (messageId === ASSISTANT_ID) return assistant;
      if (messageId === USER_MSG_ID) return editedUserMessage;
      return null;
    }));
    track(spyOn(chatsSvc, "deleteMessage").mockImplementation(() => true));
    track(spyOn(chatsSvc, "deleteSwipe").mockImplementation(() => assistant));
    track(spyOn(chatsSvc, "patchMessageExtra").mockImplementation(() => assistant));
    track(spyOn(chatsSvc, "prepareNativeSwipeVariables").mockReturnValue(undefined));

    addSwipe = track(spyOn(chatsSvc, "addSwipe").mockImplementation((_userId, messageId, _content, options) => {
      expect(messageId).toBe(ASSISTANT_ID);
      assistant = {
        ...assistant,
        swipes: [...assistant.swipes, ""],
        swipe_dates: [...assistant.swipe_dates, 2],
        swipe_id: options?.select === false ? assistant.swipe_id : assistant.swipes.length,
        content: options?.select === false ? assistant.content : "",
      };
      return assistant;
    }));
    createMessage = track(spyOn(chatsSvc, "createMessage").mockImplementation(() => {
      throw new Error("normal generation must not pre-create a placeholder");
    }));
  });

  afterEach(() => {
    stopAllGenerations();
    pool.clearAllPoolEntries();
    stopGenerationSweep();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("background start stages a distinct target without selecting it or clearing visible metrics", async () => {
    assistant.extra = { tokenCount: 12, reasoning: "saved reasoning" };
    const started = await startGeneration({ userId: USER, chat_id: CHAT, generation_type: "swipe", message_id: ASSISTANT_ID, background_swipe: true });
    expect(assistant).toMatchObject({ swipe_id: 0, content: "reply", swipes: ["reply", ""], extra: { tokenCount: 12, reasoning: "saved reasoning" } });
    expect(chatsSvc.patchMessageExtra).not.toHaveBeenCalled();
    expect(pool.getPoolEntry(started.generationId)).toMatchObject({ targetMessageId: ASSISTANT_ID, targetSwipeId: 1, backgroundSwipe: true });
    expect(eventBus.emit).toHaveBeenCalledWith(EventType.GENERATION_STARTED, expect.objectContaining({ targetSwipeId: 1, backgroundSwipe: true }), USER);
  });

  test("background requests reject non-swipe generation before any staging", async () => {
    await expect(startGeneration({ userId: USER, chat_id: CHAT, generation_type: "normal", background_swipe: true })).rejects.toThrow("background_swipe requires");
    expect(addSwipe).not.toHaveBeenCalled();
  });

  test("background target must belong to the requested chat", async () => {
    assistant = { ...assistant, chat_id: "other-chat" };
    await expect(startGeneration({ userId: USER, chat_id: CHAT, generation_type: "swipe", message_id: ASSISTANT_ID, background_swipe: true })).rejects.toThrow("Invalid background swipe target");
    expect(addSwipe).not.toHaveBeenCalled();
  });

  test("background start cannot abort an existing generation", async () => {
    const started = await startGeneration({ userId: USER, chat_id: CHAT, generation_type: "swipe", message_id: ASSISTANT_ID, background_swipe: true });
    const active = getActiveGeneration(started.generationId)!;
    await expect(startGeneration({ userId: USER, chat_id: CHAT, generation_type: "swipe", message_id: ASSISTANT_ID, background_swipe: true })).rejects.toThrow("already running");
    expect(active.controller.signal.aborted).toBe(false);
    expect(addSwipe).toHaveBeenCalledTimes(1);
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

    stopAllGenerations();
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

  test("edit-and-send context matching the live revision proceeds and stages the swipe", async () => {
    const started = await startGeneration(
      {
        userId: USER,
        chat_id: CHAT,
        generationId: GENERATION_ID,
        generation_type: "swipe",
        message_id: ASSISTANT_ID,
      },
      {
        origin: "edit_and_send",
        editAndSendContext: { editedUserMessageId: USER_MSG_ID, committedRevision: 5 },
      },
    );

    expect(started).toEqual({ generationId: GENERATION_ID, status: "streaming" });
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(addSwipe.mock.calls[0]?.[1]).toBe(ASSISTANT_ID);
  });

  test("rejects a stale edit-and-send revision before staging any swipe", async () => {
    // The user edited the message again after this request was queued: the live
    // revision (6) no longer matches the committed one (5).
    editedUserMessage = { ...baseMessage(), revision: 6 };

    await expect(
      startGeneration(
        {
          userId: USER,
          chat_id: CHAT,
          generationId: GENERATION_ID,
          generation_type: "swipe",
          message_id: ASSISTANT_ID,
        },
        {
          origin: "edit_and_send",
          editAndSendContext: { editedUserMessageId: USER_MSG_ID, committedRevision: 5 },
        },
      ),
    ).rejects.toThrow("Edit-and-Send message revision has changed since it was committed");

    expect(addSwipe).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(assistant.swipes).toEqual(["reply"]);
  });

  test("rejects an edit-and-send target that is not part of this chat before staging", async () => {
    editedUserMessage = { ...baseMessage(), chat_id: "some-other-chat", revision: 5 };

    await expect(
      startGeneration(
        {
          userId: USER,
          chat_id: CHAT,
          generationId: GENERATION_ID,
          generation_type: "normal",
        },
        {
          origin: "edit_and_send",
          editAndSendContext: { editedUserMessageId: USER_MSG_ID, committedRevision: 5 },
        },
      ),
    ).rejects.toThrow("Edit-and-Send target message is not part of this chat");

    expect(addSwipe).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("rejects a missing edit-and-send target before staging", async () => {
    editedUserMessage = { ...baseMessage(), revision: 5 };

    await expect(
      startGeneration(
        {
          userId: USER,
          chat_id: CHAT,
          generationId: GENERATION_ID,
          generation_type: "normal",
        },
        {
          origin: "edit_and_send",
          editAndSendContext: { editedUserMessageId: "gone-message", committedRevision: 5 },
        },
      ),
    ).rejects.toThrow("Edit-and-Send target message is not part of this chat");

    expect(addSwipe).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("rejects an assistant target from another chat before addSwipe", async () => {
    // The edited user message is valid, but the swipe target id belongs to a
    // different chat; the guard must reject before addSwipe runs.
    const foreignAssistant = { ...assistant, chat_id: "another-chat" };
    getMessageSpy.mockImplementation((_userId: string, messageId: string) => {
      if (messageId === ASSISTANT_ID) return foreignAssistant as Message;
      if (messageId === USER_MSG_ID) return editedUserMessage;
      return null;
    });

    await expect(
      startGeneration(
        {
          userId: USER,
          chat_id: CHAT,
          generationId: GENERATION_ID,
          generation_type: "swipe",
          message_id: ASSISTANT_ID,
        },
        {
          origin: "edit_and_send",
          editAndSendContext: { editedUserMessageId: USER_MSG_ID, committedRevision: 5 },
        },
      ),
    ).rejects.toThrow("Edit-and-Send assistant target is not part of this chat");

    expect(addSwipe).not.toHaveBeenCalled();
  });

  test("ordinary generation without edit-and-send context is unchanged", async () => {
    const started = await startGeneration({
      userId: USER,
      chat_id: CHAT,
      generationId: GENERATION_ID,
      generation_type: "swipe",
      message_id: ASSISTANT_ID,
    });

    expect(started).toEqual({ generationId: GENERATION_ID, status: "streaming" });
    expect(addSwipe).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
  });
});

// ── Async guard regressions (real service, real DB, deferred gates) ───────
//
// These drive the REAL `startGeneration` against an in-memory baseline DB and
// hold the async gaps open with a deferred interceptor, so the assertions
// observe registry/provider side effects rather than a helper return value.

describe("startGeneration edit-and-send async guards", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  const unregisters: Array<() => void> = [];
  const endedEvents: any[] = [];

  const committedRevision = 3;

  function track<T extends { mockRestore: () => void }>(spy: T): T {
    spies.push(spy);
    return spy;
  }

  async function seed(): Promise<{ chatId: string; userMessageId: string; connectionId: string }> {
    const connection = await connectionsSvc.createConnection(USER, {
      name: "Mock",
      provider: "openai",
      model: "test-model",
      api_url: "https://example.test",
    });
    const chat = chatsSvc.createChat(USER, {
      character_id: null,
      name: "Async guard chat",
      metadata: { temporary: true, no_preset: true },
    });
    const userMessage = chatsSvc.createMessage(
      chat.id,
      { is_user: true, name: "User", content: "original" },
      USER,
    );
    getDb().query("UPDATE messages SET revision = ? WHERE id = ?").run(committedRevision, userMessage.id);
    return { chatId: chat.id, userMessageId: userMessage.id, connectionId: connection.id };
  }

  function rejectFetch(): void {
    fetchSpy = track(
      spyOn(globalThis, "fetch").mockImplementation((async () => {
        throw new Error("provider call reached while context was stale");
      }) as unknown as typeof fetch),
    );
  }

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
    track(spyOn(assemblyWorker, "canUsePromptAssemblyWorker").mockReturnValue(false));
    track(spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined));
    track(spyOn(secretsSvc, "getSecret").mockResolvedValue("test-key"));
    track(
      spyOn(eventBus, "emit").mockImplementation((type, payload) => {
        if (type === EventType.GENERATION_ENDED) endedEvents.push(payload);
      }),
    );
    unregisters.length = 0;
    endedEvents.length = 0;
  });

  afterEach(() => {
    // Release any parked deferred gates first so a still-running continuation can
    // unblock and be torn down before the DB closes (no orphaned async work).
    for (const un of unregisters.splice(0)) un();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    for (const spy of spies.splice(0)) spy.mockRestore();
    stopAllGenerations();
    stopGenerationSweep();
    pool.clearAllPoolEntries();
    closeDatabase();
  });

  test("stale context at entry rejects before aborting an existing ordinary generation and leaves no registration", async () => {
    const { chatId, userMessageId, connectionId } = await seed();
    rejectFetch();

    // An ORDINARY generation is already live on the same chat.
    const ordinary = await startGeneration({
      userId: USER,
      chat_id: chatId,
      connection_id: connectionId,
      generation_type: "normal",
    });
    const ordinaryEntry = getActiveGeneration(ordinary.generationId);
    expect(ordinaryEntry).toBeDefined();
    expect(getActiveChatGeneration(USER, chatId)).toBe(ordinary.generationId);
    const abortSpy = track(spyOn(ordinaryEntry!.controller, "abort"));

    // The user edited again after this request was queued: revision now 4.
    getDb().query("UPDATE messages SET revision = ? WHERE id = ?").run(committedRevision + 1, userMessageId);

    await expect(
      startGeneration(
        {
          userId: USER,
          chat_id: chatId,
          generationId: "gen-stale-entry",
          generation_type: "normal",
        },
        {
          origin: "edit_and_send",
          editAndSendContext: { editedUserMessageId: userMessageId, committedRevision },
        },
      ),
    ).rejects.toThrow("Edit-and-Send message revision has changed since it was committed");

    // The existing ordinary generation was NOT aborted, still owns the chat,
    // and the rejected request never registered its own generation.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(getActiveChatGeneration(USER, chatId)).toBe(ordinary.generationId);
    expect(getActiveGeneration("gen-stale-entry")).toBeUndefined();
  });

  test("an edit committed while the context handler is parked rejects and clears the new registration", async () => {
    const { chatId, userMessageId, connectionId } = await seed();
    rejectFetch();

    // Hold the entry-gap open with a deferred context handler. The handler runs
    // inside the generation continuation (well after the pre-register guard),
    // so the window it creates is exactly where a competing edit can land
    // between registration and the final pre-runGeneration checkpoint.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    unregisters.push(
      contextHandlerChain.register({
        extensionId: "eas-async-guard",
        priority: 100,
        handler: async (context: any) => {
          enter();
          await gate;
          return context;
        },
      }),
    );

    const started = await startGeneration(
      {
        userId: USER,
        chat_id: chatId,
        generationId: "gen-late-stale",
        generation_type: "normal",
      },
      {
        origin: "edit_and_send",
        editAndSendContext: { editedUserMessageId: userMessageId, committedRevision },
      },
    );
    // startGeneration returns the streaming handle BEFORE the detached
    // continuation runs; the failure surfaces through the tracked completion.
    expect(started).toEqual({ generationId: "gen-late-stale", status: "streaming" });
    const entry = getActiveGeneration("gen-late-stale");
    expect(entry).toBeDefined();

    // The competing edit lands while the handler is parked.
    await entered;
    getDb().query("UPDATE messages SET revision = ? WHERE id = ?").run(committedRevision + 1, userMessageId);
    release();
    await entry!.completion;

    // The failed request cleaned up its own tracking, never reached the
    // provider, and reported through the correlated terminal event.
    expect(getActiveGeneration("gen-late-stale")).toBeUndefined();
    expect(getActiveChatGeneration(USER, chatId)).toBeUndefined();
    expect(fetchSpy!.mock.calls).toHaveLength(0);
    expect(endedEvents).toEqual([
      expect.objectContaining({
        generationId: "gen-late-stale",
        chatId,
        error: "Edit-and-Send message revision has changed since it was committed",
      }),
    ]);
  });

  test("an edit committed during a deferred interceptor rejects before any provider request", async () => {
    const { chatId, userMessageId, connectionId } = await seed();
    rejectFetch();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    unregisters.push(
      interceptorPipeline.register({
        extensionId: "eas-async-guard",
        priority: 100,
        handler: async (messages: any, context: any) => {
          enter();
          await gate;
          return { messages };
        },
      }),
    );

    const started = await startGeneration(
      {
        userId: USER,
        chat_id: chatId,
        connection_id: connectionId,
        generationId: "gen-interceptor-stale",
        generation_type: "normal",
      },
      {
        origin: "edit_and_send",
        editAndSendContext: { editedUserMessageId: userMessageId, committedRevision },
      },
    );
    expect(started).toEqual({ generationId: "gen-interceptor-stale", status: "streaming" });
    const entry = getActiveGeneration("gen-interceptor-stale");
    expect(entry).toBeDefined();

    // Let the continuation reach the deferred interceptor, then edit the
    // message while it is parked; the final pre-runGeneration checkpoint sees
    // the new revision.
    await entered;
    getDb().query("UPDATE messages SET revision = ? WHERE id = ?").run(committedRevision + 1, userMessageId);
    release();
    await entry!.completion;

    // No provider request was issued because the final checkpoint rejected
    // before runGeneration.
    expect(fetchSpy!.mock.calls).toHaveLength(0);
    expect(getActiveGeneration("gen-interceptor-stale")).toBeUndefined();
    expect(getActiveChatGeneration(USER, chatId)).toBeUndefined();
    // The detached continuation surfaces the domain rejection through its one
    // terminal channel, correlated to this generation id.
    expect(endedEvents).toEqual([
      expect.objectContaining({
        generationId: "gen-interceptor-stale",
        chatId,
        error: "Edit-and-Send message revision has changed since it was committed",
        errorCode: "generation_failed",
      }),
    ]);
  });

  test.each([
    ["context", "restore"],
    ["interceptor", "restore"],
    ["interceptor", "navigate"],
    ["interceptor", "fill"],
  ] as const)("late rejection during %s handles the staged swipe after %s", async (phase, action) => {
    const { chatId, userMessageId, connectionId } = await seed();
    rejectFetch();
    const assistant = chatsSvc.createMessage(chatId, {
      is_user: false, name: "Assistant", content: "Original reply",
    }, USER);
    chatsSvc.addSwipe(USER, assistant.id, "Alternative reply");
    const original = chatsSvc.cycleSwipe(USER, assistant.id, "left")!;
    const committed = chatsSvc.editAndSend(USER, chatId, {
      messageId: userMessageId,
      content: "Committed user text",
      expectedVersion: committedRevision,
      requestId: crypto.randomUUID(),
      branchChatOnEditAndSend: false,
    });
    if (committed.status !== "ok") throw new Error(committed.error);

    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    unregisters.push(release);
    if (phase === "context") {
      unregisters.push(contextHandlerChain.register({
        extensionId: "eas-stale-swipe", priority: 100,
        handler: async context => { enter(); await gate; return context; },
      }));
    } else {
      unregisters.push(interceptorPipeline.register({
        extensionId: "eas-stale-swipe", priority: 100,
        handler: async messages => { enter(); await gate; return { messages }; },
      }));
    }

    const started = await startGeneration({
      userId: USER, chat_id: chatId, connection_id: connectionId,
      generationId: committed.payload.generationCursor.generationId,
      generation_type: "swipe", message_id: assistant.id,
    }, {
      origin: "edit_and_send",
      editAndSendContext: committed.payload.generationCursor.editAndSendContext,
    });
    const entry = getActiveGeneration(started.generationId)!;
    await entered;
    const staged = chatsSvc.getMessage(USER, assistant.id)!;
    expect(readMessageRevision(staged)).toBe(readMessageRevision(original));
    if (action === "navigate") chatsSvc.cycleSwipe(USER, assistant.id, "left");
    if (action === "fill") chatsSvc.updateSwipe(USER, assistant.id, staged.swipe_id, "User-saved reply");
    chatsSvc.updateSwipe(USER, userMessageId, 0, "Replacement after commit");
    release();
    await entry.completion;

    expect(fetchSpy!.mock.calls).toHaveLength(0);
    expect(getActiveGeneration(started.generationId)).toBeUndefined();
    expect(getActiveChatGeneration(USER, chatId)).toBeUndefined();
    expect(endedEvents).toEqual([expect.objectContaining({
      generationId: started.generationId,
      error: "Edit-and-Send message revision has changed since it was committed",
    })]);
    const saved = chatsSvc.getMessage(USER, assistant.id)!;
    expect(saved.swipes).toEqual(action === "fill"
      ? ["Original reply", "Alternative reply", "User-saved reply"]
      : ["Original reply", "Alternative reply"]);
    expect(saved.content).toBe(action === "fill" ? "User-saved reply"
      : action === "navigate" ? "Alternative reply" : "Original reply");
    expect(saved.swipe_id).toBe(action === "fill" ? 2 : action === "navigate" ? 1 : 0);
    expect(readMessageRevision(saved)).toBe(readMessageRevision(original));
  });

  test("a deleted edited target after the detached yield rejects before council/provider side effects", async () => {
    const { chatId, userMessageId, connectionId } = await seed();
    rejectFetch();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    unregisters.push(
      interceptorPipeline.register({
        extensionId: "eas-async-guard-deleted",
        priority: 100,
        handler: async (messages: any, context: any) => {
          enter();
          await gate;
          return { messages };
        },
      }),
    );

    const started = await startGeneration(
      {
        userId: USER,
        chat_id: chatId,
        connection_id: connectionId,
        generationId: "gen-deleted-stale",
        generation_type: "normal",
      },
      {
        origin: "edit_and_send",
        editAndSendContext: { editedUserMessageId: userMessageId, committedRevision },
      },
    );
    expect(started).toEqual({ generationId: "gen-deleted-stale", status: "streaming" });
    const entry = getActiveGeneration("gen-deleted-stale");
    expect(entry).toBeDefined();

    await entered;
    getDb().query("DELETE FROM messages WHERE id = ?").run(userMessageId);
    release();
    await entry!.completion;

    expect(fetchSpy!.mock.calls).toHaveLength(0);
    expect(getActiveGeneration("gen-deleted-stale")).toBeUndefined();
    expect(getActiveChatGeneration(USER, chatId)).toBeUndefined();
    expect(endedEvents).toEqual([
      {
        generationId: "gen-deleted-stale",
        chatId,
        error: "Edit-and-Send target message is not part of this chat",
        errorCode: "generation_failed",
        errorMessage: "Edit-and-Send target message is not part of this chat",
        generationType: "normal",
        connectionName: "Mock",
        frontendSessionId: undefined,
      },
    ]);
  });
});

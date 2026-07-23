import { describe, expect, spyOn, test } from "bun:test";

import type { AssemblyContext, AssemblyResult } from "../llm/types";
import {
  attachParentRetrievalCapture,
  detachParentRetrievalCapture,
} from "../llm/types";
import type { EmbeddingConfigWithStatus } from "./embeddings.service";
import type {
  ParentGenerationSnapshot,
  MainDispatchSnapshotInput,
  ParentGenerationSnapshotInput,
  ParentRetrievalSnapshot,
  ParentRetrievalSnapshotInput,
} from "../spindle/bound-generation-types";
import {
  BOUND_MAX_RETRIEVAL_BYTES,
  brandHostGenerationId,
} from "../spindle/bound-generation-types";
import {
  captureMainDispatchSnapshot,
  captureParentGenerationSnapshot,
  captureParentRetrievalSnapshot,
} from "../spindle/bound-generation";
import {
  assembleBoundParentPrompt,
  assemblePrompt,
  type BoundParentAssemblyInput,
} from "./prompt-assembly.service";
import type { Chat } from "../types/chat";
import type { Character } from "../types/character";
import * as chatMemoryCacheSvc from "./chat-memory-cache.service";
import { normalizeCortexConfig } from "./memory-cortex/config";
import type { Message } from "../types/message";
import type { Preset } from "../types/preset";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import * as databankSvc from "./databank";
import * as embeddingsSvc from "./embeddings.service";
import * as memoryCortex from "./memory-cortex";
import * as packsSvc from "./packs.service";
import * as personasSvc from "./personas.service";
import * as presetsSvc from "./presets.service";
import * as settingsSvc from "./settings.service";

const hostGeneration = brandHostGenerationId("bound-assembly-test-host");
const userId = "bound-assembly-test-user";
const chatId = "bound-assembly-test-chat";
const generationId = "bound-assembly-generation";

const chat: Chat = {
  id: chatId,
  character_id: "bound-character",
  name: "Frozen chat",
  metadata: {},
  created_at: 1,
  updated_at: 1,
};

const character: Character = {
  id: "bound-character",
  name: "Frozen character",
  avatar_path: null,
  image_id: null,
  description: "Frozen description",
  personality: "Frozen personality",
  scenario: "Frozen scenario",
  first_mes: "",
  mes_example: "",
  creator: "",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  tags: [],
  alternate_greetings: [],
  extensions: {},
  created_at: 1,
  updated_at: 1,
};

const message: Message = {
  id: "bound-message",
  chat_id: chatId,
  index_in_chat: 0,
  is_user: true,
  name: "User",
  content: "Frozen parent message",
  send_date: 1,
  swipe_id: 0,
  swipes: [],
  swipe_dates: [],
  extra: {},
  parent_message_id: null,
  branch_id: null,
  created_at: 1,
};

const blocks = [
  {
    id: "bound-system",
    name: "Bound system",
    content: "Frozen system block",
    role: "system" as const,
    enabled: true,
    position: "pre_history" as const,
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    characterTagTrigger: [],
    group: null,
  },
  {
    id: "bound-history",
    name: "Chat history",
    content: "",
    role: "system" as const,
    enabled: true,
    position: "in_history" as const,
    depth: 0,
    marker: "chat_history",
    isLocked: true,
    color: null,
    injectionTrigger: [],
    characterTagTrigger: [],
    group: null,
  },
];

const preset: Preset = {
  id: "bound-preset",
  name: "Frozen preset",
  provider: "openai-compatible",
  engine: "classic",
  parameters: { max_tokens: 64 },
  prompt_order: blocks,
  prompts: {},
  metadata: {},
  created_at: 1,
  updated_at: 1,
};

function makeSnapshot(options: Readonly<{ chat?: Chat; character?: Character; groupCharacters?: Map<string, Character> }> = {}): ParentGenerationSnapshot {
  const capturedAt = Date.now();
  const mainInput: MainDispatchSnapshotInput = {
    hostGeneration,
    generationId,
    userId,
    descriptor: {
      connectionId: "bound-connection",
      connectionName: "Frozen connection",
      provider: "openai-compatible",
      model: "frozen-model",
      endpointOrigin: "http://127.0.0.1:1",
      dispatchKind: "concrete",
      connectionDispatchRevision: "opaque-revision",
    },
    parameters: { temperature: 0.1, max_tokens: 64 },
    reasoning: { effort: "low" },
    authoritativeContext: { source: "frozen-parent" },
    capturedAt,
  };
  const retrievalInput: ParentRetrievalSnapshotInput = {
    hostGeneration,
    generationId,
    userId,
    chatId,
    capturedAt,
    expiresAt: capturedAt + 60_000,
    vectorWorldInfo: {
      entries: [],
      sources: { entries: [], worldBookIds: [], bookSourceMap: {}, bookNameMap: {} },
      settings: {},
      queryPreview: "Frozen vector query",
      activated: [],
      cache: {},
      retrieval: null,
      activatedWorldInfo: [],
      stats: {},
      state: {},
    },
    chatMemory: {
      settings: {},
      perChatOverrides: null,
      result: { chunks: [], formatted: "", count: 0, enabled: false },
      linkedFormatted: "",
      messages: [message],
    },
    cortex: {
      config: { enabled: false, contextTokenBudget: 128, formatterMode: "compact" },
      result: null,
      linkedResult: null,
    },
    databank: {
      activeIds: [],
      queryPreview: "Frozen databank query",
      settings: {},
      embeddingConfig: { enabled: false },
      embeddingsEnabled: false,
      retrievalState: "skipped_no_active_banks",
      result: { chunks: [], formatted: "", count: 0 },
      mentionAppendix: "",
    },
    settings: {
      reasoningSettings: { prefix: "", suffix: "" },
      selectedDefinition: null,
      selectedBehaviors: [],
      selectedPersonalities: [],
      chimeraMode: false,
      lumiaQuirks: {},
      lumiaQuirksEnabled: false,
      oocEnabled: false,
      lumiaOOCInterval: 0,
      lumiaOOCStyle: "",
      sovereignHand: {},
      selectedLoomStyles: [],
      selectedLoomUtils: [],
      selectedLoomRetrofits: [],
      guidedGenerations: [],
      promptBias: "",
      theme: { mode: "dark" },
      contextFilters: {},
      summarization: {},
      imageGeneration: {},
      chatMemorySettings: {},
      databankSettings: {},
      council_settings: { councilMode: false, members: [], toolsSettings: {} },
      globalWorldBooks: [],
      worldInfoSettings: {},
    },
    results: {
      messages: [message],
      chat: options.chat ?? chat,
      character: options.character ?? character,
      persona: null,
      connection: null,
      preset,
      ...(options.groupCharacters ? { groupCharacters: options.groupCharacters } : {}),
    },
    multiplayerMacroContext: null,
    multiplayerPersona: null,
  };
  return captureParentGenerationSnapshot({
    hostGeneration,
    generationId,
    userId,
    chatId,
    main: captureMainDispatchSnapshot(mainInput),
    retrieval: captureParentRetrievalSnapshot(retrievalInput),
    parentIdentities: { personaId: null, targetCharacterId: null },
    options: { generationType: "normal" },
    parentPrefill: { id: "bound-prefill", state: "absent" },
    interceptorDeadlineAt: capturedAt + 60_000,
    boundWorkDeadlineAt: capturedAt + 50_000,
  } satisfies ParentGenerationSnapshotInput);
}

function request(
  snapshot: ParentGenerationSnapshot,
  overrides: Partial<BoundParentAssemblyInput> = {},
): BoundParentAssemblyInput {
  return {
    snapshot,
    blocks,
    signal: new AbortController().signal,
    hookFailureMode: "degrade",
    macroFailureMode: "degrade",
    ...overrides,
  };
}

const legacyEmptyPreset: Preset = {
  ...preset,
  id: "legacy-empty-preset",
  name: "Legacy empty preset",
  prompt_order: [],
};
const legacyChatMemorySettings = {
  retrievalTopK: 9,
  queryContextSize: 3,
  injectionStrategy: "fallback" as const,
};
const legacyChatOverrides = {
  enabled: true,
  retrievalTopK: 2,
  exclusionWindow: 7,
};
const legacyChat: Chat = {
  ...chat,
  metadata: { memory_settings: legacyChatOverrides },
};


const legacyEmbeddingConfig: EmbeddingConfigWithStatus = {
  enabled: false,
  provider: "openai-compatible",
  api_url: "http://127.0.0.1",
  model: "test-embedding-model",
  dimensions: null,
  send_dimensions: false,
  retrieval_top_k: 4,
  hybrid_weight_mode: "balanced",
  preferred_context_size: 6,
  batch_size: 50,
  similarity_threshold: 0,
  rerank_cutoff: 0,
  vectorize_world_books: false,
  vectorize_chat_messages: false,
  vectorize_chat_documents: false,
  chat_memory_mode: "balanced",
  request_timeout: 120,
  has_api_key: false,
};

const legacyPrefetched = {
  chat: legacyChat,
  messages: [message],
  character,
  persona: null,
  connection: null,
  preset: legacyEmptyPreset,
  allSettings: new Map<string, unknown>([
    ["chatMemorySettings", legacyChatMemorySettings],
    ["databankSettings", {}],
    ["worldInfoSettings", {}],
  ]),
  embeddingConfig: legacyEmbeddingConfig,
  worldInfoSources: {
    entries: [],
    worldBookIds: [],
    bookSourceMap: new Map<string, "character" | "persona" | "chat" | "global" | "peer">(),
    bookNameMap: new Map<string, string>(),
  },
  cortexConfig: normalizeCortexConfig({ enabled: false }),
} as NonNullable<AssemblyContext["prefetched"]>;

function makeLegacyContext(): AssemblyContext {
  return {
    userId,
    chatId,
    presetId: legacyEmptyPreset.id,
    generationType: "normal",
    macroCommit: false,
    signal: new AbortController().signal,
    prefetched: legacyPrefetched,
  };
}

describe("assembleBoundParentPrompt", () => {
  test("assembles cloned parent facts without live retrieval or database effects", async () => {
    const snapshot = makeSnapshot();
    const spies = [
      spyOn(chatsSvc, "getChat"),
      spyOn(chatsSvc, "getMessages"),
      spyOn(charactersSvc, "getCharacter"),
      spyOn(connectionsSvc, "resolveConnection"),
      spyOn(databankSvc, "getCachedDatabankResult"),
      spyOn(databankSvc, "searchDatabanks"),
      spyOn(embeddingsSvc, "getEmbeddingConfig"),
      spyOn(embeddingsSvc, "cachedEmbedTexts"),
      spyOn(embeddingsSvc, "getCachedQueryVector"),
      spyOn(embeddingsSvc, "cacheQueryVector"),
      spyOn(memoryCortex, "getCachedCortexResult"),
      spyOn(memoryCortex, "getCachedLinkedCortexResult"),
      spyOn(memoryCortex, "queryCortex"),
      spyOn(personasSvc, "resolvePersonaOrDefault"),
      spyOn(presetsSvc, "getPreset"),
      spyOn(settingsSvc, "getSettingsByKeys"),
      spyOn(settingsSvc, "getSetting"),
      spyOn(packsSvc, "getAllLumiaItems"),
    ];
    try {
      const result = await assembleBoundParentPrompt(request(snapshot));
      const output = result.messages
        .map((entry) => (typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)))
        .join("\n");
      expect(output).toContain("Frozen system block");
      expect(output).toContain("Frozen parent message");
      expect(result.breakdown.length).toBeGreaterThan(0);
      expect(result.messages.every((message) =>
        Object.keys(message).every((key) => [
          "role",
          "content",
          "name",
          "cache_control",
          "reasoning_content",
          "thinking_blocks",
          "reasoning_details",
        ].includes(key))
      )).toBe(true);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(() =>
        Object.defineProperty(snapshot.retrieval.results.chat, "name", {
          value: "mutated",
        }),
      ).toThrow();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("applies the captured custom group scenario without live character lookup", async () => {
    const groupChat: Chat = {
      ...chat,
      metadata: {
        group: true,
        character_ids: [character.id],
        group_card_mode: "swap",
        group_scenario_override: {
          mode: "custom",
          content: "Frozen group scenario",
        },
      },
    };
    const scenarioBlocks = blocks.map((block, index) =>
      index === 0
        ? { ...block, id: "bound-scenario", content: "", marker: "scenario" }
        : { ...block },
    );
    const getCharacter = spyOn(charactersSvc, "getCharacter");
    try {
      const result = await assembleBoundParentPrompt(
        request(makeSnapshot({ chat: groupChat }), { blocks: scenarioBlocks }),
      );
      const output = result.messages
        .map((entry) => typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content))
        .join("\n");
      expect(output).toContain("Frozen group scenario");
      expect(output).not.toContain("Frozen scenario");
      expect(getCharacter).not.toHaveBeenCalled();
    } finally {
      getCharacter.mockRestore();
    }
  });

  test("fails closed when a bound group merge lacks captured member cards", async () => {
    const groupChat: Chat = {
      ...chat,
      metadata: {
        group: true,
        character_ids: [character.id],
        group_card_mode: "merge",
      },
    };
    await expect(
      assembleBoundParentPrompt(request(makeSnapshot({ chat: groupChat }))),
    ).rejects.toThrow(/missing group card characters/i);
  });

  test("rejects an invalid captured group card without consulting live storage", async () => {
    const groupChat: Chat = {
      ...chat,
      metadata: {
        group: true,
        character_ids: [character.id],
        group_card_mode: "merge",
      },
    };
    const invalidCards = new Map<string, Character>([
      [character.id, undefined as unknown as Character],
    ]);
    const getCharacter = spyOn(charactersSvc, "getCharacter").mockReturnValue(character);
    try {
      await expect(
        assembleBoundParentPrompt(
          request(makeSnapshot({ chat: groupChat, groupCharacters: invalidCards })),
        ),
      ).rejects.toThrow(/missing group card characters/i);
      expect(getCharacter).not.toHaveBeenCalled();
    } finally {
      getCharacter.mockRestore();
    }
  });

  test.each([
    ["absent", (snapshot: ParentGenerationSnapshot) => ({ ...snapshot, retrieval: undefined })],
    ["expired", (snapshot: ParentGenerationSnapshot) => ({
      ...snapshot,
      retrieval: { ...snapshot.retrieval, expiresAt: Date.now() - 1 },
    })],
    ["oversized", (snapshot: ParentGenerationSnapshot) => ({
      ...snapshot,
      retrieval: { ...snapshot.retrieval, bytes: BOUND_MAX_RETRIEVAL_BYTES + 1 },
    })],
    ["mismatched", (snapshot: ParentGenerationSnapshot) => ({
      ...snapshot,
      retrieval: { ...snapshot.retrieval, chatId: "other-chat" },
    })],
  ])("fails closed for %s retrieval snapshots", async (_label, mutate) => {
    const snapshot = mutate(makeSnapshot()) as ParentGenerationSnapshot;
    await expect(assembleBoundParentPrompt(request(snapshot))).rejects.toThrow();
  });
});

describe("legacy parent retrieval capture", () => {
  test("captures legacy memory once and preserves native and bound output", async () => {
    const legacyMemoryResult = {
      chunks: [
        {
          content: "Captured legacy memory",
          score: 0.9,
          metadata: { messageIds: ["older-message"] },
        },
      ],
      formatted: "Captured legacy memory",
      count: 1,
      enabled: true,
      queryPreview: "legacy query",
      settingsSource: "global" as const,
      chunksAvailable: 1,
      chunksPending: 0,
      retrievalMode: "vector" as const,
    };
    const memorySpy = spyOn(
      chatMemoryCacheSvc,
      "readCachedChatMemory",
    ).mockResolvedValue(legacyMemoryResult);
    const settingsSpy = spyOn(settingsSvc, "getSetting").mockReturnValue(null);
    const prohibitedSpies = [
      spyOn(databankSvc, "resolveActiveDatabankIds"),
      spyOn(databankSvc, "getCachedDatabankResult"),
      spyOn(databankSvc, "searchDatabanks"),
      spyOn(embeddingsSvc, "getEmbeddingConfig"),
      spyOn(embeddingsSvc, "cachedEmbedTexts"),
      spyOn(embeddingsSvc, "getCachedQueryVector"),
      spyOn(embeddingsSvc, "cacheQueryVector"),
      spyOn(memoryCortex, "getCachedCortexResult"),
      spyOn(memoryCortex, "getCachedLinkedCortexResult"),
      spyOn(memoryCortex, "queryCortex"),
      spyOn(memoryCortex, "queryLinkedCortex"),
    ];
    try {
      const nativeResult = await assemblePrompt(makeLegacyContext());
      const nativeMemoryCalls = memorySpy.mock.calls.length;
      let capturedRetrieval: ParentRetrievalSnapshot | undefined;
      const capturedAt = Date.now();
      const capturedContext = makeLegacyContext();
      attachParentRetrievalCapture(capturedContext, {
        meta: {
          hostGeneration,
          generationId,
          userId,
          chatId,
          capturedAt,
          expiresAt: capturedAt + 60_000,
        },
        onParentRetrievalReady: (input: unknown) => {
          const candidate = input as ParentRetrievalSnapshotInput;
          capturedRetrieval = captureParentRetrievalSnapshot({
            ...candidate,
            hostGeneration,
            generationId,
            userId,
            chatId,
            capturedAt,
            expiresAt: capturedAt + 60_000,
          });
        },
      });
      let capturedNativeResult: AssemblyResult;
      try {
        capturedNativeResult = await assemblePrompt(capturedContext);
      } finally {
        detachParentRetrievalCapture(capturedContext);
      }

      expect({
        messages: capturedNativeResult.messages,
        breakdown: capturedNativeResult.breakdown,
        parameters: capturedNativeResult.parameters,
      }).toEqual({
        messages: nativeResult.messages,
        breakdown: nativeResult.breakdown,
        parameters: nativeResult.parameters,
      });
      expect(memorySpy.mock.calls.length).toBe(nativeMemoryCalls + 1);
      expect(capturedRetrieval).toBeDefined();
      const retrieval = capturedRetrieval!;
      const retrievalResults = retrieval.results as Record<string, unknown>;
      const vectorWorldInfo = retrieval.vectorWorldInfo as Record<string, unknown>;
      const chatMemory = retrieval.chatMemory as Record<string, unknown>;
      const cortex = retrieval.cortex as Record<string, unknown>;
      const databank = retrieval.databank as Record<string, unknown>;
      expect(retrievalResults.chat).toEqual(legacyChat);
      expect(retrievalResults.character).toEqual(character);
      expect(retrievalResults.persona).toBeNull();
      expect(retrievalResults.connection).toBeNull();
      expect(retrievalResults.preset).toEqual(legacyEmptyPreset);
      expect(retrievalResults.messages).toEqual([
        expect.objectContaining({
          id: message.id,
          chatId,
          content: message.content,
        }),
      ]);
      expect(vectorWorldInfo.entries).toEqual([]);
      expect(vectorWorldInfo.activated).toEqual([]);
      expect(chatMemory.result).toEqual(legacyMemoryResult);
      expect(chatMemory.settings).toEqual(
        embeddingsSvc.normalizeChatMemorySettings(legacyChatMemorySettings),
      );
      expect(chatMemory.perChatOverrides).toEqual(legacyChatOverrides);
      expect(databank.result).toEqual({ chunks: [], formatted: "", count: 0 });
      expect(databank.embeddingConfig).toEqual(legacyEmbeddingConfig);
      expect(cortex.config).toEqual(legacyPrefetched.cortexConfig);
      expect(retrieval.multiplayerMacroContext).toBeNull();
      expect(retrieval.multiplayerPersona).toBeNull();
      expect(Object.isFrozen(retrieval)).toBe(true);
      expect(Object.isFrozen(retrieval.results)).toBe(true);
      expect(Object.isFrozen(retrievalResults.chat)).toBe(true);
      expect(Object.isFrozen(chatMemory.result)).toBe(true);

      const baseSnapshot = makeSnapshot();
      const parentSnapshot = captureParentGenerationSnapshot({
        hostGeneration: baseSnapshot.hostGeneration,
        generationId: baseSnapshot.generationId,
        userId: baseSnapshot.userId,
        chatId: baseSnapshot.chatId,
        main: baseSnapshot.main,
        retrieval,
        parentIdentities: baseSnapshot.parentIdentities,
        options: baseSnapshot.options,
        parentPrefill: baseSnapshot.parentPrefill,
        interceptorDeadlineAt: retrieval.expiresAt,
        boundWorkDeadlineAt: retrieval.expiresAt - 1,
      });
      const memoryBlocks = blocks.map((block, index) =>
        index === 0
          ? { ...block, id: "bound-memory", content: "{{memories}}" }
          : { ...block },
      );
      const boundResult = await assembleBoundParentPrompt(
        request(parentSnapshot, { blocks: memoryBlocks }),
      );
      const boundOutput = boundResult.messages
        .map((entry) =>
          typeof entry.content === "string"
            ? entry.content
            : JSON.stringify(entry.content),
        )
        .join("\n");
      expect(boundOutput).toContain("Captured legacy memory");
      expect(boundOutput).toContain("Frozen parent message");
      expect(memorySpy.mock.calls.length).toBe(nativeMemoryCalls + 1);
      for (const spy of prohibitedSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      settingsSpy.mockRestore();
      memorySpy.mockRestore();
      for (const spy of prohibitedSpies) spy.mockRestore();
    }
  });
});

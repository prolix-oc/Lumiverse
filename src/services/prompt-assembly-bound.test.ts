import { describe, expect, spyOn, test } from "bun:test";

import type {
  ParentGenerationSnapshot,
  MainDispatchSnapshotInput,
  ParentGenerationSnapshotInput,
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
  type BoundParentAssemblyInput,
} from "./prompt-assembly.service";
import type { Chat } from "../types/chat";
import type { Character } from "../types/character";
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

function makeSnapshot(): ParentGenerationSnapshot {
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
      chat,
      character,
      persona: null,
      connection: null,
      preset,
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

/**
 * Executable zero-callback proof for the strict Agentic phases.
 *
 * Plan section 3.8 requires an inventory of every callback reachable from
 * current assembly/finalization plus fixtures proving Agentic ASSEMBLE, WORK,
 * and PREPARE_COMMIT enter none of them. Source comments and a tool-name
 * allowlist are not proof, so this file registers a live counting sentinel in
 * every ambient host callback registry (a strict superset of the generation
 * paths: message content processors and context handlers are reached by
 * persistence/display, not assembly), fires each sentinel on its real
 * Response-mode execution path, then drives each strict phase over inputs that
 * would trigger those callbacks in Response mode and asserts every counter
 * stays at zero.
 *
 * The ambient Spindle tool registry stores plain metadata and exposes no
 * executor callback, so the tool surface is proven differently: the sentinel
 * tool is registered, its liveness is asserted, and the WORK test proves the
 * phase composes no tool definition for it and refuses a provider-forged call.
 * Explicitly admitted authorities (not callbacks, therefore not sentinelled):
 * the WORK/RENDER provider dispatch supplied by the host as
 * `AgenticWorkOptions.dispatch`, the bounded same-domain child executor, and
 * the host workspace/context capabilities. Council and MCP have no ambient
 * host registry that assembly or finalization consults; they are reachable
 * only by name through the Response-mode tool dispatch table, so they are
 * proven here by their absence from the composed provider tool set and by the
 * correlated rejection of a provider-forged call.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { initMacros } from "../macros";
import { evaluate } from "../macros/MacroEvaluator";
import { registry as macroRegistry } from "../macros/MacroRegistry";
import type { MacroEnv } from "../macros/types";
import { contextHandlerChain } from "../spindle/context-handler";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import { macroInterceptorChain } from "../spindle/macro-interceptor";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { toolRegistry } from "../spindle/tool-registry";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import {
  HOST_PREPARATION_LIMITS_V1,
  type RenderPreparationInputV1,
} from "../types/agent-preprocessing";
import {
  compileAgentAssemblyPlan,
  materializeAssemblyPlan,
  type AssemblyPlanV1,
} from "./agentic-assembly-compiler";
import { prepareAgentRenderV1 } from "./agentic-render-preparation.service";
import {
  runSegmentedAgenticWorkV1,
  type AgenticWorkOptions,
  type AgenticWorkspaceCapability,
  type AgenticWorkspaceCompletionFixedPointResult,
} from "./agentic-work-phase.service";
import {
  buildGenerationAssemblySnapshot,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";

/**
 * Ambient host callback surfaces whose handlers can execute in-process. This
 * is a strict superset of the assembly/finalization paths: message content
 * processors and context handlers are reached by persistence/display flows.
 */
const CALLBACK_SURFACES = [
  "prompt_interceptor",
  "macro_interceptor",
  "world_info_interceptor",
  "context_handler",
  "message_content_processor",
  "extension_macro",
] as const;
type CallbackSurface = (typeof CALLBACK_SURFACES)[number];
const SENTINEL_EXTENSION_ID = "zero-callback-sentinel-extension";

const SENTINEL_MACRO_NAME = "zeroCallbackSentinelMacro";
const SENTINEL_TOOL_NAME = "zero_callback_sentinel_tool";
/** Any callback that runs injects this marker, so bytes prove reachability too. */
const MARKER = "ZERO_CALLBACK_SENTINEL_REACHED";
/** Response-only tool names that must never be composed for an Agentic frame. */
const RESPONSE_ONLY_TOOL_NAMES = ["council_call", "mcp_call", "spindle_tool", SENTINEL_TOOL_NAME] as const;

interface CallbackSentinels {
  readonly hits: Record<CallbackSurface, number>;
  dispose(): void;
}

function installCallbackSentinels(): CallbackSentinels {
  const hits = Object.fromEntries(
    CALLBACK_SURFACES.map((surface) => [surface, 0]),
  ) as Record<CallbackSurface, number>;
  const disposers: Array<() => void> = [];

  disposers.push(interceptorPipeline.register({
    extensionId: SENTINEL_EXTENSION_ID,
    priority: 0,
    handler: async (messages) => {
      hits.prompt_interceptor += 1;
      return { messages: [...messages, { role: "system", content: MARKER }] };
    },
  }));
  disposers.push(macroInterceptorChain.register({
    extensionId: SENTINEL_EXTENSION_ID,
    priority: 0,
    handler: async (ctx) => {
      hits.macro_interceptor += 1;
      return `${ctx.template}${MARKER}`;
    },
  }));
  disposers.push(worldInfoInterceptorChain.register({
    extensionId: SENTINEL_EXTENSION_ID,
    priority: 0,
    handler: async () => {
      hits.world_info_interceptor += 1;
      return undefined;
    },
  }));
  disposers.push(contextHandlerChain.register({
    extensionId: SENTINEL_EXTENSION_ID,
    priority: 0,
    handler: async (context) => {
      hits.context_handler += 1;
      return context;
    },
  }));
  disposers.push(messageContentProcessorChain.register({
    extensionId: SENTINEL_EXTENSION_ID,
    priority: 0,
    handler: async (ctx) => {
      hits.message_content_processor += 1;
      return { content: `${ctx.content}${MARKER}` };
    },
  }));

  const macroRegistered = macroRegistry.registerMacro({
    name: SENTINEL_MACRO_NAME,
    category: "test",
    description: "zero-callback sentinel",
    handler: () => {
      hits.extension_macro += 1;
      return MARKER;
    },
  }, { kind: "extension", extensionId: SENTINEL_EXTENSION_ID });
  if (!macroRegistered) throw new Error("sentinel macro registration failed");
  disposers.push(() => macroRegistry.unregisterByExtension(SENTINEL_EXTENSION_ID));

  toolRegistry.register({
    name: SENTINEL_TOOL_NAME,
    display_name: "Zero callback sentinel tool",
    description: "Ambient extension tool that no Agentic phase may expose or call",
    parameters: { type: "object", properties: {} },
    council_eligible: true,
    inline_available: true,
    extension_id: SENTINEL_EXTENSION_ID,
  });
  disposers.push(() => toolRegistry.unregisterByExtension(SENTINEL_EXTENSION_ID));

  return {
    hits,
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

/** Fail-closed guard: a sentinel that is not actually registered proves nothing. */
function expectSentinelsLive(): void {
  expect(interceptorPipeline.count).toBeGreaterThan(0);
  expect(macroInterceptorChain.count).toBeGreaterThan(0);
  expect(worldInfoInterceptorChain.count).toBeGreaterThan(0);
  expect(contextHandlerChain.count).toBeGreaterThan(0);
  expect(messageContentProcessorChain.count).toBeGreaterThan(0);
  expect(macroRegistry.getMacro(SENTINEL_MACRO_NAME)).not.toBeNull();
  expect(toolRegistry.getTool(SENTINEL_TOOL_NAME)).toBeDefined();
}

function expectNoCallback(sentinels: CallbackSentinels, observed: unknown): void {
  expect(sentinels.hits).toEqual(
    Object.fromEntries(CALLBACK_SURFACES.map((surface) => [surface, 0])) as Record<CallbackSurface, number>,
  );
  expect(JSON.stringify(observed)).not.toContain(MARKER);
}

function schema(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT, name TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL, swipes TEXT NOT NULL, swipe_dates TEXT NOT NULL, extra TEXT NOT NULL, parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, engine TEXT NOT NULL, parameters TEXT NOT NULL, prompt_order TEXT NOT NULL, metadata TEXT NOT NULL, prompts TEXT NOT NULL, updated_at INTEGER NOT NULL, cache_revision INTEGER NOT NULL)");
  db.run("CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, personality TEXT NOT NULL, scenario TEXT NOT NULL, first_mes TEXT NOT NULL, mes_example TEXT NOT NULL, system_prompt TEXT NOT NULL, post_history_instructions TEXT NOT NULL, extensions TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, subjective_pronoun TEXT NOT NULL, objective_pronoun TEXT NOT NULL, possessive_pronoun TEXT NOT NULL, reflexive_pronoun TEXT NOT NULL, possessive_pronoun_standalone TEXT NOT NULL, attached_world_book_id TEXT, is_narrator INTEGER NOT NULL, is_default INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id))");
  db.run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL, model TEXT NOT NULL, preset_id TEXT, is_default INTEGER NOT NULL, has_api_key INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE regex_scripts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, find_regex TEXT NOT NULL, replace_string TEXT NOT NULL, actions TEXT NOT NULL, flags TEXT NOT NULL, placement TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, target TEXT NOT NULL, trim_strings TEXT NOT NULL, disabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, world_book_id TEXT NOT NULL, key TEXT NOT NULL, keysecondary TEXT NOT NULL, content TEXT NOT NULL, comment TEXT NOT NULL, position INTEGER NOT NULL, depth INTEGER NOT NULL, role TEXT, order_value INTEGER NOT NULL, disabled INTEGER NOT NULL, constant INTEGER NOT NULL, sticky INTEGER NOT NULL, cooldown INTEGER NOT NULL, delay INTEGER NOT NULL, vector_index_status TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  return db;
}

/**
 * Authored content that Response-mode assembly would route through the macro
 * interceptor, keyword-based world-info activation, and the prompt regex
 * pipeline. The fail-closed fixture below swaps in a sentinel extension macro
 * to exercise the extension macro registry path directly.
 */
const CALLBACK_BAIT_BLOCK = `{{char}} tells {{user}} about foo`;

function seed(db: Database, blockContent = CALLBACK_BAIT_BLOCK): void {
  const blocks = [{
    id: "bait",
    name: "Bait",
    content: blockContent,
    role: "user",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
  }];
  db.query("INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "chat-1", "user-1", "char-1", "Chat",
    JSON.stringify({ chat_world_book_ids: ["book-1"], chat_variables: { mood: "calm" } }),
    1, 1, 1,
  );
  db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "message-1", "chat-1", 0, 1, "User", "tell me about one and foo", 1, 0,
    JSON.stringify(["tell me about one and foo"]), JSON.stringify([1]), "{}", null, null, 1, 1, 1,
  );
  db.query("INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "char-1", "user-1", "Aria", "desc", "personality", "scenario", "hello", "example", "", "",
    JSON.stringify({ world_book_ids: ["book-1"] }), 2,
  );
  db.query("INSERT INTO personas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "persona-1", "user-1", "Me", "", "", "I", "me", "my", "myself", "mine", null, 0, 1, 1,
  );
  db.query("INSERT INTO presets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "preset-1", "user-1", "Preset", "loom", "classic", "{}", JSON.stringify(blocks), "{}", "{}", 3, 7,
  );
  db.query("INSERT INTO connection_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "connection-1", "user-1", "Main", "openai", "http://provider", "model", "preset-1", 1, 1, "{}", 4,
  );
  db.query("INSERT INTO settings VALUES (?, ?, ?, ?)").run("globalWorldBooks", JSON.stringify(["book-1"]), "user-1", 5);
  db.query("INSERT INTO world_books VALUES (?, ?, ?, ?, ?, ?)").run("book-1", "user-1", "Lore", "", "{}", 2);
  db.query("INSERT INTO world_book_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "entry-1", "book-1", JSON.stringify(["one"]), "[]", "Lore about one", "One", 0, 4, "system", 2, 0, 0, 0, 0, 0, "not_enabled", 1, 1,
  );
  db.query("INSERT INTO regex_scripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "regex-1", "user-1", "safe", "foo", "bar", "[]", "gi", JSON.stringify(["user_input", "ai_output"]),
    "global", null, JSON.stringify(["prompt"]), "[]", 0, 0, 1, 1,
  );
}

function agentConfig(): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    connectionSlots: [],
    runtimePolicy: {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      phases: [],
    },
  };
}

async function assembledFixture(
  blockContent?: string,
): Promise<{ snapshot: GenerationAssemblySnapshotV1; plan: AssemblyPlanV1 }> {
  const db = schema();
  try {
    seed(db, blockContent);
    const snapshot = buildGenerationAssemblySnapshot({
      assemblySurface: "WORK",
      userId: "user-1",
      chatId: "chat-1",
      presetId: "preset-1",
      connectionId: "connection-1",
      agentConfig: agentConfig(),
      db,
    });
    return { snapshot, plan: await compileAgentAssemblyPlan(snapshot) };
  } finally {
    db.close();
  }
}

function macroEnv(): MacroEnv {
  return {
    commit: true,
    names: {
      user: "User", char: "Aria", group: "", groupNotMuted: "", notChar: "",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no",
      isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo",
    },
    character: {
      name: "Aria", description: "", personality: "", scenario: "", persona: "",
      personaSubjectivePronoun: "", personaObjectivePronoun: "",
      personaPossessivePronoun: "", personaReflexivePronoun: "",
      personaPossessivePronounStandalone: "", mesExamples: "", mesExamplesRaw: "",
      systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "",
      version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "chat-1", messageCount: 0, lastMessage: "", lastMessageName: "",
      lastUserMessage: "", lastCharMessage: "", lastMessageId: -1,
      firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0, rejectedSwipe: "",
    },
    system: {
      model: "frozen-model", maxPrompt: 0, maxContext: 0, maxResponse: 0,
      lastGenerationType: "normal", isMobile: false,
    },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros: {},
    extra: {},
  };
}

function renderInput(overrides: Partial<RenderPreparationInputV1> = {}): RenderPreparationInputV1 {
  return {
    version: 1,
    operation: "prepare_agent_render",
    requestId: "zero-callback-render",
    limits: HOST_PREPARATION_LIMITS_V1,
    turnId: "turn-1",
    target: { kind: "normal" },
    content: { kind: "text", text: `{{char}} answers {{${SENTINEL_MACRO_NAME}}} about foo` },
    sourceMessages: [{
      sourceMessageId: "source-1",
      revision: 4,
      role: "user",
      content: { kind: "text", text: `{{${SENTINEL_MACRO_NAME}}} foo` },
    }],
    swipes: [],
    macroSnapshot: { local: [], global: [["char", "Aria"]], chat: [], promptVariables: [] },
    regexScripts: [{
      scriptId: "regex-1",
      revision: 1,
      pattern: "foo",
      replacement: "bar",
      flags: "g",
      stage: "response",
      enabled: true,
      order: 0,
    }],
    formatting: { stripGuidedReasoning: true, healFormatting: true, preserveProviderReasoning: true },
    inputRevisions: { version: 1, revisions: [], digest: "frozen-inputs" },
    deltas: [{ kind: "source_message", sourceMessageId: "source-1", operation: "update", expectedRevision: 4 }],
    ...overrides,
  } as RenderPreparationInputV1;
}

function zeroCallbackWorkspace(): AgenticWorkspaceCapability {
  return {
    preparesCompletionBeforeAcceptance: true,
    getCompletionGates: async () => ({}),
    listTaskAcceptance: async () => [],
    freezeForCompletion: async (input) => {
      const candidate: AgenticWorkspaceCompletionFixedPointResult = {
        accepted: true,
        workspaceRevision: 4,
        workspaceContextProjection: {
          version: 1,
          sourceWorkspaceRevision: 4,
          mandatory: [],
          optional: [],
          omissions: [
            { class: "accepted_submission", omittedCount: 0, firstOmittedCursor: null },
            { class: "finding", omittedCount: 0, firstOmittedCursor: null },
            { class: "optional_task", omittedCount: 0, firstOmittedCursor: null },
            { class: "artifact", omittedCount: 0, firstOmittedCursor: null },
          ],
          literal: "",
          utf8Bytes: 0,
        },
      };
      if (!input.prepareAcceptance) return candidate;
      const acknowledged = await input.prepareAcceptance(candidate);
      return acknowledged
        ? candidate
        : {
          accepted: false,
          workspaceRevision: candidate.workspaceRevision,
          code: "completion_freeze_failed",
        };
    },
  };
}

function workOptions(
  plan: AssemblyPlanV1,
  dispatch: AgenticWorkOptions["dispatch"],
  overrides: Partial<AgenticWorkOptions> = {},
): AgenticWorkOptions {
  return {
    plan,
    trustedAssemblyLimits: HOST_PREPARATION_LIMITS_V1,
    connectionId: "concrete-connection",
    model: "frozen-model",
    dispatch,
    coreToolIds: ["chat_search_history"],
    rootFrameId: "zero-callback-root",
    signal: new AbortController().signal,
    workspace: zeroCallbackWorkspace(),
    workspaceCapabilities: [],
    budget: { maxProviderRounds: 1, maxUnsignedBoundaries: 2 },
    ...overrides,
  };
}

let sentinels: CallbackSentinels;

beforeAll(() => {
  initMacros();
});

beforeEach(() => {
  sentinels = installCallbackSentinels();
  expectSentinelsLive();
});

afterEach(() => {
  sentinels.dispose();
});

describe("Agentic strict phases enter zero host callbacks", () => {
  test("the sentinel inventory covers every host callback registry", () => {
    const registryPattern = /^export const (\w+) = new \w*(?:Chain|Pipeline|Registry)\(/gm;
    const registryExportsIn = (dir: string): readonly string[] =>
      readdirSync(dir)
        .filter((entry) => entry.endsWith(".ts") && !entry.includes(".test."))
        .flatMap((entry) => [
          ...readFileSync(join(dir, entry), "utf8").matchAll(registryPattern),
        ])
        .map((match) => match[1]!)
        .sort();
    const spindleExports = registryExportsIn(join(import.meta.dir, "..", "spindle"));
    const macroExports = registryExportsIn(join(import.meta.dir, "..", "macros"));

    // Drift guard: a new or renamed ambient callback registry must extend this
    // proof instead of silently escaping it.
    expect(spindleExports).toEqual([
      "contextHandlerChain",
      "interceptorPipeline",
      "macroInterceptorChain",
      "messageContentProcessorChain",
      "providerRegistry",
      "toolRegistry",
      "worldInfoInterceptorChain",
    ]);
    expect(macroExports).toEqual(["registry"]);
  });

  test("the sentinels really fire on the Response-mode path they guard", async () => {
    const result = await evaluate(
      `{{char}} and {{${SENTINEL_MACRO_NAME}}}`,
      macroEnv(),
      macroRegistry,
      { phase: "prompt" },
    );
    const pipelineResult = await interceptorPipeline.run(
      [{ role: "user", content: "hi" }],
      { chatId: "chat-1" },
    );
    await worldInfoInterceptorChain.run([], {
      chatId: "chat-1",
      characterId: "char-1",
      messages: [],
      chatTurn: 0,
      chatMetadata: {},
      activationSettings: { globalScanDepth: 0, maxRecursionPasses: 0 },
    });
    await contextHandlerChain.run({ chatId: "chat-1" }, "user-1");
    await messageContentProcessorChain.run({
      chatId: "chat-1",
      content: "hi",
      isUser: true,
      origin: "render",
      userId: "user-1",
    }, "user-1");

    expect(sentinels.hits.macro_interceptor).toBeGreaterThan(0);
    expect(sentinels.hits.extension_macro).toBeGreaterThan(0);
    expect(sentinels.hits.prompt_interceptor).toBeGreaterThan(0);
    expect(sentinels.hits.world_info_interceptor).toBeGreaterThan(0);
    expect(sentinels.hits.context_handler).toBeGreaterThan(0);
    expect(sentinels.hits.message_content_processor).toBeGreaterThan(0);
    expect(result.text).toContain(MARKER);
    expect(pipelineResult.messages.some((message) => message.content === MARKER)).toBe(true);
  });


  test("ASSEMBLE compiles and materializes a plan without entering any callback", async () => {
    const { snapshot, plan } = await assembledFixture();
    const materialized = materializeAssemblyPlan(plan, [], HOST_PREPARATION_LIMITS_V1);

    const literal = materialized
      .flatMap((message) => message.segments)
      .map((segment) => (segment.kind === "literal" ? segment.text : ""))
      .join("\n");

    // Pure host macros resolve from the frozen snapshot, the keyword world-info
    // entry activates through the deterministic PRNG, and the frozen prompt
    // regex applies through the pure core — none of it through a callback.
    expect(literal).toContain("Aria tells Me about bar");
    expect(literal).toContain("tell me about one and bar");
    expect(literal).toContain("Lore about one");
    expect(literal).not.toContain("foo");
    expect(snapshot.extensionData).toBeNull();
    expect(snapshot.ambientSpindleData).toBeNull();
    expectNoCallback(sentinels, { snapshot, plan, materialized });
  });

  test("ASSEMBLE leaves unknown macros unresolved without consulting callbacks", async () => {
    const unknown = "totallyUnknownAssemblyMacro";
    const { plan } = await assembledFixture(`{{${unknown}}}`);
    const literal = materializeAssemblyPlan(plan, [], HOST_PREPARATION_LIMITS_V1)
      .flatMap((message) => message.segments)
      .map((segment) => (segment.kind === "literal" ? segment.text : ""))
      .join("\n");
    expect(literal).toContain(`{{${unknown}}}`);
    expectNoCallback(sentinels, { plan });
  });

  test("WORK dispatches only its closed tool set and never reaches a Response-only executor", async () => {
    const { snapshot, plan } = await assembledFixture();
    let composedTools: readonly string[] = [];
    let round = 0;

    // One round of Response-only tools followed by a valid completion round.
    // maxToolResultBytes is lowered so the forged batch survives result-byte
    // reservation and the genuine per-call allowlist rejection surfaces
    // (tool_not_allowed) instead of batch-reservation exhaustion.
    const result = await runSegmentedAgenticWorkV1(workOptions(plan, async ({ tools, messages }) => {
      composedTools = tools.map((tool) => tool.name);
      expect(JSON.stringify(messages)).not.toContain(MARKER);
      round += 1;
      if (round === 1) {
        return {
          content: "",
          finish_reason: "tool_calls",
          tool_calls: RESPONSE_ONLY_TOOL_NAMES.map((name, index) => ({
            name,
            call_id: `forbidden-${index}`,
            args: {},
          })),
        };
      }
      return {
        content: "",
        finish_reason: "tool_calls",
        tool_calls: [{
          name: "complete_turn",
          call_id: "complete-1",
          args: { summary: "bounded work completed", unresolvedIds: [] },
        }],
      };
    }, { snapshot, budget: { maxProviderRounds: 2, maxToolResultBytes: 1024 } }));

    for (const name of RESPONSE_ONLY_TOOL_NAMES) expect(composedTools).not.toContain(name);
    expect(composedTools).toContain("complete_turn");

    // Every forged Response-only call is refused by the closed allowlist
    // (tool_not_allowed), never executed, and never routed to an executor.
    const rejected = result.observations.filter((observation) => observation.callId.startsWith("forbidden-"));
    expect(rejected).toHaveLength(RESPONSE_ONLY_TOOL_NAMES.length);
    for (let index = 0; index < RESPONSE_ONLY_TOOL_NAMES.length; index += 1) {
      expect(rejected[index]).toMatchObject({
        toolName: RESPONSE_ONLY_TOOL_NAMES[index],
        status: "rejected",
        code: "tool_not_allowed",
      });
    }
    expectNoCallback(sentinels, result);
  });

  test("PREPARE_COMMIT prepares the final render without entering any callback", () => {
    const prepared = prepareAgentRenderV1(renderInput());

    // The pure snapshot macro resolves, the registered extension macro stays
    // literal, and the authorized response regex applies in the strict path.
    expect(prepared.content).toEqual({
      kind: "text",
      text: `Aria answers {{${SENTINEL_MACRO_NAME}}} about bar`,
    });
    expectNoCallback(sentinels, prepared);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type {
  GenerationRequest,
  LlmMessage,
  StreamChunk,
} from "../llm/types";
import { yieldToEventLoop } from "../llm/stream-utils";
import type { LlmMessageDTO } from "lumiverse-spindle-types";
import type { LlmProvider } from "../llm/provider";
import { registerProvider } from "../llm/registry";
import { EventType } from "../ws/events";
import { eventBus } from "../ws/bus";
import {
  dryRunGeneration,
  startGeneration,
  stopAllGenerations,
  stopGeneration,
  __test__,
} from "./generate.service";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import { normalizeInterceptorFinalResponse } from "../spindle/interceptor-final-response";
import {
  createInterceptorTerminalLease,
  type InterceptorPipelineAuthority,
} from "../spindle/lifecycle";
import { toolRegistry } from "../spindle/tool-registry";
import * as chatsSvc from "./chats.service";
import * as regexScriptsSvc from "./regex-scripts.service";

import type {
  InterceptorBreakdownEntry,
  InterceptorResult,
} from "../spindle/interceptor-pipeline";

// Provider-specific caching behavior lives in src/services/caching/ — see the
// dedicated tests in that directory. This file covers the residual non-caching
// flags that `injectConnectionMetadataFlags` still owns.

test("bounds invalid inline tool timeouts to a finite safety window", () => {
  expect(__test__.normalizeInlineToolTimeoutMs(Number.NaN)).toBe(30_000);
  expect(__test__.normalizeInlineToolTimeoutMs(Number.POSITIVE_INFINITY)).toBe(30_000);
  expect(__test__.normalizeInlineToolTimeoutMs(-1)).toBe(15_000);
  expect(__test__.normalizeInlineToolTimeoutMs(1.4)).toBe(15_000);
  expect(__test__.normalizeInlineToolTimeoutMs(999_999)).toBe(120_000);
  expect(__test__.normalizeInlineToolTimeoutMs(30_000.6)).toBe(30_001);
});

describe("injectConnectionMetadataFlags", () => {
  test("sets use_responses_api when metadata flag is true", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: { use_responses_api: true } },
      params,
    );
    expect(params.use_responses_api).toBe(true);
  });

  test("does not set use_responses_api when metadata flag is missing", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: {} },
      params,
    );
    expect(params.use_responses_api).toBeUndefined();
  });

  test("forwards openrouter metadata into _openrouter when set", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      {
        provider: "openrouter",
        metadata: { openrouter: { provider: { sort: "throughput" } } },
      },
      params,
    );
    expect(params._openrouter).toEqual({ provider: { sort: "throughput" } });
  });

  test("does not set _openrouter for non-openrouter providers", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      {
        provider: "openai",
        metadata: { openrouter: { provider: { sort: "throughput" } } },
      },
      params,
    );
    expect(params._openrouter).toBeUndefined();
  });

  test("no-op for empty metadata", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openai", metadata: undefined },
      params,
    );
    expect(params).toEqual({});
  });
});

describe("prompt breakdown visibility", () => {
  test("omits synthetic chat history entries without changing total tokens", () => {
    const tokenCount = {
      total_tokens: 42,
      breakdown: [
        { name: "System", type: "block", tokens: 10 },
        { name: "Chat History", type: "chat_history", tokens: 30 },
        { name: "Author's Note", type: "authors_note", tokens: 2 },
      ],
      tokenizer_id: "approx",
      tokenizer_name: "Approximate",
    };

    const visible = __test__.omitChatHistoryTokenBreakdown(tokenCount);

    expect(visible?.total_tokens).toBe(42);
    expect(visible?.breakdown.map((entry) => entry.type)).toEqual([
      "block",
      "authors_note",
    ]);
  });

  test("summarizes chat history tokens separately", () => {
    expect(
      __test__.sumChatHistoryBreakdownTokens([
        { type: "block", tokens: 10 },
        { type: "chat_history", tokens: 30 },
        { type: "chat_history", tokens: 5 },
      ]),
    ).toBe(35);
  });
});

describe("Callback-active provider route matrix", () => {
  test("allows only live normal and continue generations", () => {
    expect(__test__.isCallbackActiveProviderRoute("normal", false)).toBe(true);
    expect(__test__.isCallbackActiveProviderRoute("continue", false)).toBe(true);
    expect(__test__.isCallbackActiveProviderRoute("normal", true)).toBe(false);
    expect(__test__.isCallbackActiveProviderRoute("continue", true)).toBe(false);
  });

  test("excludes direct and non-terminal generation routes", () => {
    for (const generationType of [
      "regenerate",
      "swipe",
      "impersonate",
      "quiet",
      "batch",
    ]) {
      expect(
        __test__.isCallbackActiveProviderRoute(generationType, false),
      ).toBe(false);
    }
  });
});

const FINAL_RESPONSE_USER = "final-response-user";
const FINAL_RESPONSE_CHAT = "final-response-chat";
const FINAL_RESPONSE_CHARACTER = "final-response-character";
const FINAL_RESPONSE_CONNECTION = "final-response-connection";
const FINAL_RESPONSE_PRESET = "final-response-preset";
const FINAL_RESPONSE_USER_MESSAGE = "final-response-user-message";
const FINAL_RESPONSE_ASSISTANT_MESSAGE = "final-response-assistant-message";
const FINAL_RESPONSE_PROVIDER = "final-response-provider";

const providerState: {
  calls: GenerationRequest[];
  content: string;
  reasoning?: string;
} = {
  calls: [],
  content: "provider-response",
};

const finalResponseProvider: LlmProvider = {
  name: FINAL_RESPONSE_PROVIDER,
  displayName: "Final response provider",
  defaultUrl: "http://final-response.invalid",
  capabilities: {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none",
  },
  async generate(
    _apiKey: string,
    _apiUrl: string,
    request: GenerationRequest,
  ) {
    providerState.calls.push(request);
    return {
      content: providerState.content,
      reasoning: providerState.reasoning,
      finish_reason: "stop",
    };
  },
  async *generateStream(
    _apiKey: string,
    _apiUrl: string,
    request: GenerationRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    providerState.calls.push(request);
    yield {
      token: providerState.content,
      reasoning: providerState.reasoning,
      finish_reason: "stop",
    };
  },
  async validateKey() {
    return true;
  },
  async listModels() {
    return ["final-response-model"];
  },
};

registerProvider(finalResponseProvider);

type FinalResponsePlan = {
  extensionId?: string;
  extensionName?: string;
  content?: string;
  reasoning?: string;
  fallback?: string;
  invalid?: "malformed" | "unauthorized";
  omitted?: boolean;
  permissionGranted?: boolean;
  permissionGuard?: (context: unknown) => boolean;
};

type CapturedGenerationEvent = {
  event: EventType;
  payload: Record<string, unknown>;
};

const generationInterceptors: Array<() => void> = [];
const generationSpies: Array<{ mockRestore: () => void }> = [];

function seedGenerationDb(): void {
  const db = getDb();

  // Migrations are run by the async hook before this synchronous seed helper.
  db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    FINAL_RESPONSE_USER,
    "Final response",
    "final-response@example.test",
  );
  db.query(
    `INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example,
      creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings,
      extensions, created_at, updated_at, user_id)
     VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', '{}', ?, ?, ?)`,
  ).run(FINAL_RESPONSE_CHARACTER, "Final response character", 1, 1, FINAL_RESPONSE_USER);
  db.query(
    `INSERT INTO chats (id, character_id, name, metadata, created_at, updated_at, user_id)
     VALUES (?, ?, ?, '{}', ?, ?, ?)`,
  ).run(FINAL_RESPONSE_CHAT, FINAL_RESPONSE_CHARACTER, "Final response chat", 1, 1, FINAL_RESPONSE_USER);

  const promptOrder = [
    {
      id: "final-response-system",
      name: "System",
      content: "Final response system",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      characterTagTrigger: [],
      group: null,
    },
    {
      id: "final-response-history",
      name: "Chat History",
      content: "",
      role: "system",
      enabled: true,
      position: "in_history",
      depth: 0,
      marker: "chat_history",
      isLocked: true,
      color: null,
      injectionTrigger: [],
      characterTagTrigger: [],
      group: null,
    },
  ];
  const prompts = {
    promptBehavior: {
      continueNudge: "",
      emptySendNudge: "",
      impersonationPrompt: "",
      groupNudge: "",
      newChatPrompt: "",
      newGroupChatPrompt: "",
      sendIfEmpty: "",
    },
    completionSettings: {
      assistantPrefill: "Seed ",
      assistantImpersonation: "",
      continuePrefill: false,
      continuePostfix: "",
      namesBehavior: 0,
      squashSystemMessages: false,
      useSystemPrompt: true,
      enableWebSearch: false,
      sendInlineMedia: false,
      enableFunctionCalling: true,
      includeUsage: false,
    },
  };
  db.query(
    `INSERT INTO presets
      (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'classic')`,
  ).run(
    FINAL_RESPONSE_PRESET,
    "Final response preset",
    FINAL_RESPONSE_PROVIDER,
    JSON.stringify({ max_tokens: 64 }),
    JSON.stringify(promptOrder),
    1,
    1,
    JSON.stringify(prompts),
    FINAL_RESPONSE_USER,
  );
  db.query(
    `INSERT INTO connection_profiles
      (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, ?, 'http://127.0.0.1:9876/v1', ?, ?, 1, '{}', ?, ?, 0, ?)`,
  ).run(
    FINAL_RESPONSE_CONNECTION,
    "Final response connection",
    FINAL_RESPONSE_PROVIDER,
    "final-response-model",
    FINAL_RESPONSE_PRESET,
    1,
    1,
    FINAL_RESPONSE_USER,
  );
  setGenerationSetting("reasoningSettings", {
    autoParse: false,
    prefix: "<think>",
    suffix: "</think>",
  });

  seedMessage(FINAL_RESPONSE_USER_MESSAGE, FINAL_RESPONSE_CHAT, 0, true, "hello");
}

function seedMessage(
  id: string,
  chatId: string,
  index: number,
  isUser: boolean,
  content: string,
): void {
  getDb()
    .query(
      `INSERT INTO messages
        (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes,
         swipe_dates, extra, parent_message_id, branch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?)`,
    )
    .run(
      id,
      chatId,
      index,
      isUser ? 1 : 0,
      isUser ? "User" : "Assistant",
      content,
      1,
      JSON.stringify([content]),
      JSON.stringify([1]),
      1,
    );
}

function setGenerationSetting(key: string, value: unknown): void {
  getDb()
    .query(
      `INSERT INTO settings (key, value, updated_at, user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), 1, FINAL_RESPONSE_USER);
}

function seedResponseRegex(
  id = "final-response-regex",
  findRegex = "answer",
  replaceString = "rewritten",
): void {
  getDb()
    .query(
      `INSERT INTO regex_scripts
        (id, user_id, name, find_regex, replace_string, actions, flags, placement, scope, scope_id,
         target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled,
         sort_order, description, metadata, created_at, updated_at, folder, script_id, pack_id,
         preset_id, character_id)
       VALUES (?, ?, ?, ?, ?, '[]', 'g', ?, 'global', NULL, '[\"response\"]', NULL, NULL, '[]',
         0, 'none', 0, 0, '', '{}', ?, ?, '', ?, NULL, NULL, NULL)`,
    )
    .run(
      id,
      FINAL_RESPONSE_USER,
      "Final response regex",
      findRegex,
      replaceString,
      '["ai_output","reasoning"]',
      1,
      1,
      id,
    );
}

function baseMessages(
  generationType: "normal" | "continue" | "regenerate" = "normal",
): LlmMessage[] {
  if (generationType === "normal") {
    return [{ role: "user", content: "hello" }];
  }
  return [
    { role: "user", content: "hello" },
    { role: "assistant", content: "before" },
  ];
}

function installFinalResponsePlan(
  planInput: readonly FinalResponsePlan[] | FinalResponsePlan,
): void {
  const plans = Array.isArray(planInput) ? planInput : [planInput];
  for (const [index, plan] of plans.entries()) {
    let callbackAuthority: InterceptorPipelineAuthority | undefined;
    generationInterceptors.push(
      interceptorPipeline.register({
        extensionId: plan.extensionId ?? `final-response-extension-${index}`,
        extensionName: plan.extensionName ?? `Final response extension ${index}`,
        userId: FINAL_RESPONSE_USER,
        matcher: (_context, authority) => {
          callbackAuthority = authority;
          return true;
        },
        priority: index,
        handler: async (
          messages: LlmMessageDTO[],
          context: unknown,
        ): Promise<InterceptorResult> => {
          if (plan.omitted) return { messages };

          const extensionId =
            plan.extensionId ?? `final-response-extension-${index}`;
          const extensionName =
            plan.extensionName ?? `Final response extension ${index}`;
          const permissionGuard =
            plan.permissionGuard ?? (() => true);

          if (plan.invalid) {
            const normalized = normalizeInterceptorFinalResponse({
              result:
                plan.invalid === "malformed"
                  ? { content: "", fallbackMessageIndex: 0 }
                  : { content: "unauthorized", fallbackMessageIndex: 0 },
              inputMessages: messages,
              outputMessages: messages,
              breakdown: [],
              permissionGranted:
                plan.invalid === "unauthorized"
                  ? false
                  : plan.permissionGranted ?? true,
              permissionGuard: () => permissionGuard(context),
              extensionId,
              extensionName,
              workerId: `${extensionId}-worker`,
              registrationId: `${extensionId}-registration`,
              callbackUserId: FINAL_RESPONSE_USER,
              hostGeneration: `${extensionId}-generation`,
            });
            return {
              messages: normalized.messages,
              ...(normalized.finalResponse
                ? { finalResponseState: normalized.finalResponse }
                : {}),
            };
          }

          const fallbackMessage = {
            role: "system" as const,
            content: plan.fallback ?? `fallback-${index}`,
          };
          const fallbackMessageIndex = messages.length;
          const outputMessages = [...messages, fallbackMessage];
          const breakdown: InterceptorBreakdownEntry[] = [
            {
              messageIndex: fallbackMessageIndex,
              name: "Final response",
              role: "system",
              content: fallbackMessage.content,
              extensionId,
              extensionName,
            },
          ];
          const normalized = normalizeInterceptorFinalResponse({
            result: {
              content: plan.content ?? `native-${index}`,
              ...(plan.reasoning === undefined
                ? {}
                : { reasoning: plan.reasoning }),
              fallbackMessageIndex,
            },
            inputMessages: messages,
            outputMessages,
            breakdown,
            permissionGranted: plan.permissionGranted ?? true,
            permissionGuard: () => permissionGuard(context),
            extensionId,
            extensionName,
            workerId: `${extensionId}-worker`,
            registrationId: `${extensionId}-registration`,
            callbackUserId: FINAL_RESPONSE_USER,
            hostGeneration: `${extensionId}-generation`,
          });
          const hostBreakdown: InterceptorBreakdownEntry[] =
            normalized.breakdown.map((entry) => {
              const source = breakdown.find(
                (candidate) => candidate.messageIndex === entry.messageIndex,
              );
              return source
                ? {
                    ...source,
                    messageIndex: entry.messageIndex,
                    name: entry.name ?? source.name,
                  }
                : {
                    messageIndex: entry.messageIndex,
                    name: entry.name ?? extensionName,
                    role: "system",
                    content: fallbackMessage.content,
                    extensionId,
                    extensionName,
                  };
            });
          const leaseAuthority = callbackAuthority;
          const terminalLease =
            normalized.finalResponse?.status === "valid"
              ? createInterceptorTerminalLease({
                  registrationId: `${extensionId}-registration`,
                  generationId:
                    leaseAuthority?.parentGenerationSnapshot?.generationId ??
                    `${extensionId}-generation`,
                  callbackUserId:
                    leaseAuthority?.parentGenerationSnapshot?.userId ??
                    FINAL_RESPONSE_USER,
                  extensionId,
                  extensionName,
                  ...(leaseAuthority?.parentGenerationSnapshot
                    ? {
                        parentGenerationSnapshot:
                          leaseAuthority.parentGenerationSnapshot,
                        parentPrefillAttestation:
                          leaseAuthority.parentPrefillAttestation,
                        currentDispatchRevision: () =>
                          leaseAuthority.mainDispatchSnapshot?.dispatchRevision,
                      }
                    : {}),
                  finalResponseState: normalized.finalResponse,
                  permissionGuard: () => permissionGuard(context),
                })
              : undefined;
          return {
            messages: normalized.messages,
            breakdown: hostBreakdown,
            ...(normalized.finalResponse
              ? { finalResponseState: normalized.finalResponse }
              : {}),
            ...(terminalLease ? { terminalLeases: [terminalLease] } : {}),
          };
        },
      }),
    );
  }
}

function generationEventsFor(
  events: readonly CapturedGenerationEvent[],
  generationId: string,
): CapturedGenerationEvent[] {
  return events.filter((entry) => entry.payload.generationId === generationId);
}

async function drainGenerationWork(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await yieldToEventLoop();
  }
}

async function waitForGeneration(
  input: Parameters<typeof startGeneration>[0],
  afterStart?: (started: { generationId: string; status: string }) => void,
): Promise<{
  started: { generationId: string; status: string };
  events: CapturedGenerationEvent[];
}> {
  const events: CapturedGenerationEvent[] = [];
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  let generationId: string | undefined;
  const eventTypes = [
    EventType.GENERATION_STARTED,
    EventType.GENERATION_IN_PROGRESS,
    EventType.STREAM_TOKEN_RECEIVED,
    EventType.GENERATION_ENDED,
    EventType.GENERATION_STOPPED,
    EventType.GENERATION_METRICS_READY,
    EventType.GENERATION_BREAKDOWN_READY,
  ];
  const unsubs = eventTypes.map((event) =>
    eventBus.on(event, (message) => {
      const captured = {
        event,
        payload: message.payload as Record<string, unknown>,
      };
      events.push(captured);
      if (
        generationId &&
        captured.payload.generationId === generationId &&
        (event === EventType.GENERATION_ENDED ||
          event === EventType.GENERATION_STOPPED)
      ) {
        resolveTerminal();
      }
    }),
  );
  try {
    const started = await startGeneration(input);
    generationId = started.generationId;
    afterStart?.(started);
    await terminal;
    await drainGenerationWork();
    return {
      started,
      events: generationEventsFor(events, started.generationId),
    };
  } finally {
    for (const unsubscribe of unsubs) unsubscribe();
  }
}
function eventPayload(
  events: readonly CapturedGenerationEvent[],
  event: EventType,
): Record<string, unknown> | undefined {
  return events.find((entry) => entry.event === event)?.payload;
}
function assistantMessages(): ReturnType<typeof chatsSvc.getMessages> {
  return chatsSvc
    .getMessages(FINAL_RESPONSE_USER, FINAL_RESPONSE_CHAT)
    .filter((message) => !message.is_user);
}


describe("Generation finalization and final-response selection", () => {
  beforeEach(async () => {
    providerState.calls = [];
    providerState.content = "provider-response";
    providerState.reasoning = undefined;
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    seedGenerationDb();
  });

  afterEach(() => {
    for (const dispose of generationInterceptors.splice(0)) dispose();
    for (const spy of generationSpies.splice(0)) spy.mockRestore();
    stopAllGenerations();
    closeDatabase();
  });

function makeGenerationInput(
  generationType: "normal" | "continue" | "regenerate" = "normal",
  messages?: LlmMessage[],
) {
  return {
    userId: FINAL_RESPONSE_USER,
    chat_id: FINAL_RESPONSE_CHAT,
    connection_id: FINAL_RESPONSE_CONNECTION,
    preset_id: FINAL_RESPONSE_PRESET,
    generation_type: generationType,
    ...(messages === undefined ? {} : { messages }),
    ...(generationType === "continue" || generationType === "regenerate"
      ? { message_id: FINAL_RESPONSE_ASSISTANT_MESSAGE }
      : {}),
  };
}

for (const scenario of [
  { generationType: "normal" as const, expected: "native-normal" },
  { generationType: "continue" as const, expected: "beforenative-continue" },
]) {
  test(`accepts native ${scenario.generationType} persistence and events`, async () => {
    if (scenario.generationType === "continue") {
      seedMessage(
        FINAL_RESPONSE_ASSISTANT_MESSAGE,
        FINAL_RESPONSE_CHAT,
        1,
        false,
        "before",
      );
    }
    installFinalResponsePlan({
      extensionId: "native-final-response",
      extensionName: "Native final response",
      content: scenario.expected.replace("before", ""),
      reasoning: "native-reasoning",
      fallback: "protected-fallback",
    });
    const result = await waitForGeneration(
      makeGenerationInput(
        scenario.generationType,
        baseMessages(scenario.generationType),
      ),
    );

    expect(providerState.calls).toHaveLength(0);
    const ended = eventPayload(result.events, EventType.GENERATION_ENDED);
    expect(ended).toMatchObject({
      content: scenario.expected,
      generationType: scenario.generationType,
    });
    expect(ended).not.toHaveProperty("usage");
    expect(
      result.events.filter(
        (entry) => entry.event === EventType.GENERATION_METRICS_READY,
      ),
    ).toHaveLength(0);

    const saved = assistantMessages()[0];
    expect(saved.content).toBe(scenario.expected);
    expect(saved.extra.reasoning).toBe("native-reasoning");
    expect(saved.extra.usage).toBeUndefined();
    expect(saved.extra.generationMetrics).toBeUndefined();
    expect(saved.extra.tokenCount).toBeUndefined();
    expect(
      result.events.some(
        (entry) =>
          entry.event === EventType.STREAM_TOKEN_RECEIVED &&
          entry.payload.token === "native-reasoning",
      ),
    ).toBe(true);
  });
}

test("keeps nonempty assistant prefill exactly once", async () => {
  providerState.content = "reply";
  const result = await waitForGeneration(makeGenerationInput("normal"));

  expect(providerState.calls).toHaveLength(1);
  const requestMessages = providerState.calls[0]!.messages;
  expect(
    requestMessages.filter(
      (message) => message.role === "assistant" && message.content === "Seed ",
    ),
  ).toHaveLength(1);
  expect(assistantMessages()[0]?.content).toBe("Seed reply");
  expect(assistantMessages()[0]?.content).not.toContain("Seed Seed");
  expect(eventPayload(result.events, EventType.GENERATION_ENDED)).toMatchObject({
    content: "Seed reply",
  });
});

test("applies response regex and guided CoT while attributing host breakdown", async () => {
  setGenerationSetting("reasoningSettings", {
    autoParse: true,
    prefix: "<think>",
    suffix: "</think>",
  });
  seedResponseRegex();
  installFinalResponsePlan({
    extensionId: "response-breakdown",
    extensionName: "Response breakdown",
    content: "<think>plan</think>answer",
    fallback: "protected-fallback",
  });

  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
  );
  const saved = assistantMessages()[0]!;
  expect(saved.content).toBe("rewritten");
  expect(saved.extra.reasoning).toBe("plan");
  expect(providerState.calls).toHaveLength(0);

  const progress = result.events
    .filter((entry) => entry.event === EventType.GENERATION_IN_PROGRESS)
    .map((entry) => entry.payload);
  expect(
    progress.some((payload) =>
      Array.isArray(payload.breakdown) &&
      payload.breakdown.some(
        (entry: Record<string, unknown>) =>
          entry.extensionId === "response-breakdown" &&
          entry.extensionName === "Response breakdown",
      ),
    ),
  ).toBe(true);
});

test("late permission revoke uses provider with the exact protected fallback", async () => {
  let permissionLive = true;
  installFinalResponsePlan({
    extensionId: "revoked-final-response",
    extensionName: "Revoked final response",
    content: "native-candidate",
    fallback: "current-protected-fallback",
    permissionGuard: () => permissionLive,
  });
  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
    () => {
      permissionLive = false;
    },
  );

  expect(providerState.calls).toHaveLength(1);
  expect(providerState.calls[0]!.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))).toEqual([
    { role: "user", content: "hello" },
    { role: "system", content: "current-protected-fallback" },
  ]);
  expect(assistantMessages()[0]?.content).toBe("provider-response");
  expect(eventPayload(result.events, EventType.GENERATION_ENDED)).toMatchObject({
    content: "provider-response",
  });
});

for (const secondState of [
  { label: "valid", invalid: undefined, expected: "native-second" },
  { label: "malformed", invalid: "malformed" as const, expected: "native-first" },
  { label: "unauthorized", invalid: "unauthorized" as const, expected: "native-first" },
]) {
  test(`later ${secondState.label} response preserves the current winner`, async () => {
    installFinalResponsePlan([
      {
        extensionId: "first-final-response",
        extensionName: "First final response",
        content: "native-first",
        fallback: "first-fallback",
      },
      {
        extensionId: "second-final-response",
        extensionName: "Second final response",
        content: "native-second",
        fallback: "second-fallback",
        ...(secondState.invalid ? { invalid: secondState.invalid } : {}),
      },
    ]);
    const result = await waitForGeneration(
      makeGenerationInput("normal", baseMessages("normal")),
    );

    if (secondState.label === "valid") {
      expect(providerState.calls).toHaveLength(0);
      expect(assistantMessages()[0]?.content).toBe("native-second");
    } else {
      expect(providerState.calls).toHaveLength(0);
      expect(assistantMessages()[0]?.content).toBe("native-first");
    }
    expect(eventPayload(result.events, EventType.GENERATION_ENDED)).toMatchObject({
      content: secondState.expected,
    });
  });
}

test("tool-active final responses use the provider without a warning", async () => {
  const toolExtensionId = "final-response-tool-extension";
  toolRegistry.register({
    extension_id: toolExtensionId,
    name: "final_response_tool",
    display_name: "Final-response tool",
    description: "A deterministic final-response tool",
    parameters: { type: "object", properties: {}, required: [] },
    inline_available: true,
  });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  generationSpies.push(warnSpy);
  try {
    installFinalResponsePlan({
      extensionId: "final-response-tool-final",
      extensionName: "Final-response tool final",
      content: "native-not-used",
      fallback: "tool-protected-fallback",
    });
    const result = await waitForGeneration(
      makeGenerationInput("normal", baseMessages("normal")),
    );
    expect(providerState.calls).toHaveLength(1);
    expect(providerState.calls[0]!.tools).toHaveLength(1);
    expect(assistantMessages()[0]?.content).toBe("provider-response");
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("Final response"),
      ),
    ).toBe(false);
    expect(eventPayload(result.events, EventType.GENERATION_ENDED)).toMatchObject({
      content: "provider-response",
    });
  } finally {
    toolRegistry.unregister("final_response_tool", toolExtensionId);
  }
});

test("ineligible regenerate route uses the provider without a warning", async () => {
  seedMessage(
    FINAL_RESPONSE_ASSISTANT_MESSAGE,
    FINAL_RESPONSE_CHAT,
    1,
    false,
    "before",
  );
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  generationSpies.push(warnSpy);
  installFinalResponsePlan({
    extensionId: "regenerate-final-response",
    extensionName: "Regenerate final response",
    content: "native-not-used",
    fallback: "regenerate-protected-fallback",
  });
  const result = await waitForGeneration(
    makeGenerationInput("regenerate", baseMessages("regenerate")),
  );

  expect(providerState.calls).toHaveLength(1);
  expect(assistantMessages()[0]?.content).toBe("provider-response");
  expect(
    warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("Final response"),
    ),
  ).toBe(false);
  expect(eventPayload(result.events, EventType.GENERATION_ENDED)).toMatchObject({
    content: "provider-response",
    generationType: "regenerate",
  });
});

test("dry-run route restores the fallback without warning or provider use", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  generationSpies.push(warnSpy);
  installFinalResponsePlan({
    extensionId: "dry-run-final-response",
    extensionName: "Dry-run final response",
    content: "native-not-used",
    fallback: "dry-run-protected-fallback",
  });

  const result = await dryRunGeneration({
    userId: FINAL_RESPONSE_USER,
    chat_id: FINAL_RESPONSE_CHAT,
    connection_id: FINAL_RESPONSE_CONNECTION,
    preset_id: FINAL_RESPONSE_PRESET,
    generation_type: "normal",
    messages: baseMessages("normal"),
  });

  expect(providerState.calls).toHaveLength(0);
  expect(result.messages.map((message) => message.content)).toContain(
    "dry-run-protected-fallback",
  );
  expect(
    warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("Final response"),
    ),
  ).toBe(false);
});

test("post-transform blank native output emits an error without saving or retrying", async () => {
  seedResponseRegex("blank-final-response", "candidate", "");
  installFinalResponsePlan({
    extensionId: "blank-final-response",
    extensionName: "Blank final response",
    content: "candidate",
    fallback: "blank-protected-fallback",
  });
  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
  );

  const ended = eventPayload(result.events, EventType.GENERATION_ENDED);
  expect(ended?.error).toContain(
    "Interceptor final response became empty after response processing",
  );
  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_STOPPED,
  )).toHaveLength(0);
  expect(providerState.calls).toHaveLength(0);
  expect(assistantMessages()).toHaveLength(0);
});

test("stop at final-response selection emits one STOPPED with no candidate save", async () => {
  installFinalResponsePlan({
    extensionId: "stop-final-response-selection",
    extensionName: "Stop at final-response selection",
    content: "candidate",
    permissionGuard: (context) => {
      const generationId = (context as { generationId: string }).generationId;
      stopGeneration(FINAL_RESPONSE_USER, generationId);
      return true;
    },
  });
  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
  );

  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_STOPPED,
  )).toHaveLength(1);
  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_ENDED,
  )).toHaveLength(0);
  expect(providerState.calls).toHaveLength(0);
  expect(assistantMessages()).toHaveLength(0);
});

test("stop during response transform emits one STOPPED with no candidate save", async () => {
  seedResponseRegex("response-transform", "candidate", "candidate");
  let generationId: string | undefined;
  const originalApply = regexScriptsSvc.applyRegexScripts;
  const regexSpy = spyOn(
    regexScriptsSvc,
    "applyRegexScripts",
  ).mockImplementation(async (...args: Parameters<typeof regexScriptsSvc.applyRegexScripts>) => {
    if (
      args[6]?.source === "response_backend" &&
      generationId
    ) {
      stopGeneration(FINAL_RESPONSE_USER, generationId);
    }
    return originalApply(...args);
  });
  generationSpies.push(regexSpy);
  installFinalResponsePlan({
    extensionId: "stop-response-transform",
    extensionName: "Stop during response transform",
    content: "candidate",
  });
  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
    (started) => {
      generationId = started.generationId;
    },
  );

  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_STOPPED,
  )).toHaveLength(1);
  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_ENDED,
  )).toHaveLength(0);
  expect(providerState.calls).toHaveLength(0);
  expect(assistantMessages()).toHaveLength(0);
});
test("stop at persistence leaves no candidate message and emits one STOPPED", async () => {
  let generationId: string | undefined;
  const originalCreate = chatsSvc.createMessage;
  const createSpy = spyOn(
    chatsSvc,
    "createMessage",
  ).mockImplementation((...args: Parameters<typeof chatsSvc.createMessage>) => {
    if (generationId) {
      stopGeneration(FINAL_RESPONSE_USER, generationId);
      throw new DOMException("Aborted before save", "AbortError");
    }
    return originalCreate(...args);
  });
  generationSpies.push(createSpy);
  installFinalResponsePlan({
    extensionId: "stop-final-response-persistence",
    extensionName: "Stop during final-response persistence",
    content: "candidate",
  });
  const result = await waitForGeneration(
    makeGenerationInput("normal", baseMessages("normal")),
    (started) => {
      generationId = started.generationId;
    },
  );

  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_STOPPED,
  )).toHaveLength(1);
  expect(result.events.filter(
    (entry) => entry.event === EventType.GENERATION_ENDED,
  )).toHaveLength(0);
  expect(providerState.calls).toHaveLength(0);
  expect(assistantMessages()).toHaveLength(0);
});

});

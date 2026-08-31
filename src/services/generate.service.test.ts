import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type { LlmProvider } from "../llm/provider";
import type { ProviderCapabilities } from "../llm/param-schema";
import { OpenAIProvider } from "../llm/providers/openai";
import { registerProvider } from "../llm/registry";
import { ProviderProtocolError } from "../llm/stream-utils";
import type {
  ContextClipStats,
  GenerationRequest,
  GenerationResponse,
  LlmMessage,
  ProviderTransientCarrier,
  StreamChunk,
} from "../llm/types";
import { closeDatabase, closeDatabaseAsync, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type { AgentConfigV2 } from "../types/agents";
import type { LoomPromptInspectionV1 } from "../types/agent-cognition";
import type { ResolvedConcreteConnectionV1 } from "./connections.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { AgentSealRegistry } from "./agent-seals.service";
import { AGENT_RUNTIME_ADMISSION_MANAGER } from "./agent-runtime-admission";
import { AgentRuntimeFailure, AgentRuntimeOwner } from "./agent-runtime.service";
import * as breakdownSvc from "./breakdown.service";
import * as chatMacroRenderSvc from "./chat-macro-render.service";
import * as chatsSvc from "./chats.service";
import { getChatPipelineStatus } from "./chat-pipeline-coordinator.service";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import {
  __test__,
  configureAgenticGenerationDependencies,
  dryRunGeneration,
  getActiveGenerationCount,
  rawGenerate,
  startGeneration,
  stopGeneration,
  stopGenerationRequestAuthority,
} from "./generate.service";
import * as pool from "./generation-pool.service";
import { buildInlineToolContinuation } from "./inline-tool-continuation";
import * as presetsSvc from "./presets.service";
import * as regexScriptsSvc from "./regex-scripts.service";
import { writePresetAgentConfig } from "./agent-config-portability.service";
import * as worldBooksSvc from "./world-books.service";
import { assemblePrompt, projectNativeContextForChat } from "./prompt-assembly.service";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import * as databankSvc from "./databank";
import * as embeddingsSvc from "./embeddings.service";
import * as runtimeDecisionSvc from "./agent-runtime-decision.service";
import {
  AgentRuntimeDecisionService,
  RuntimeDecisionTokenStore,
  type RuntimeDecisionDependencies,
} from "./agent-runtime-decision.service";
import {
  AgenticGenerationError,
  waitForAgenticGeneration,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticRuntimeDecision,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import type {
  AgenticReadinessVectorV1,
  EffectiveRuntimeDecisionV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  InputRevisionSetV1,
} from "../types/agent-runtime-decision";
import type { CreateMessageInput, Message } from "../types/message";
const TEST_CONNECTION: ResolvedConcreteConnectionV1 = {
  logicalId: "child-connection",
  concreteId: "child-connection",
  label: "Test child connection",
  provider: "test",
  model: "test-model",
  endpoint: "https://example.test/v1",
  effectiveEndpoint: "https://example.test/v1",
  endpointRevision: "endpoint-revision",
  credentialSecretRef: "secret-ref",
  credentialRevision: "credential-revision",
  candidateRevision: "candidate-revision",
  fingerprint: "trust-domain-fingerprint",
  capabilities: {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none",
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native",
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
  },
};


function makeContextClipStats(
  overrides: Partial<ContextClipStats> = {},
): ContextClipStats {
  return {
    enabled: true,
    maxContext: 4096,
    maxResponseTokens: 512,
    safetyMargin: 64,
    inputBudget: 3520,
    fixedTokens: 1024,
    remainingHistoryBudget: 2496,
    chatHistoryTokensBefore: 128,
    chatHistoryTokensAfter: 128,
    messagesDropped: 0,
    tokensDropped: 0,
    tokenizerUsed: "approximate",
    ...overrides,
  };
}

const TEST_OWNER_ID = "root-usage-owner";

// These fixtures replace the process-global in-memory database between cases.
// Insert synchronously so createMessage cannot leave detached chunk work behind.
function insertFixtureMessage(
  userId: string,
  chatId: string,
  input: Pick<CreateMessageInput, "is_user" | "name" | "content">,
): Message {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const maxIndex = db.query(
    "SELECT COALESCE(MAX(index_in_chat), -1) AS max_idx FROM messages WHERE chat_id = ?",
  ).get(chatId) as { max_idx: number };

  db.transaction(() => {
    db.query(
      "INSERT INTO messages " +
        "(id, chat_id, index_in_chat, is_user, name, content, send_date, " +
        "swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?)",
    ).run(
      id,
      chatId,
      maxIndex.max_idx + 1,
      input.is_user ? 1 : 0,
      input.name,
      input.content,
      now,
      JSON.stringify([input.content]),
      JSON.stringify([now]),
      now,
    );
    db.query(
      "UPDATE chats SET updated_at = ?, generation_revision = generation_revision + 1 WHERE id = ? AND user_id = ?",
    ).run(now, chatId, userId);
  })();

  const message = chatsSvc.getMessage(userId, id);
  if (!message) throw new Error("Expected fixture message to be inserted");
  return message;
}

// Provider-specific caching behavior lives in src/services/caching/ — see the
// dedicated tests in that directory. This file covers the residual non-caching
// flags that `injectConnectionMetadataFlags` still owns.

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

  test("uses the chat id as OpenRouter's documented sticky-routing session key", () => {
    const params: Record<string, unknown> = {};
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      params,
      "chat-123",
    );
    expect(params.session_id).toBe("lumiverse:chat-123");
  });

  test("does not replace a caller-provided OpenRouter session or cache key", () => {
    const sessionParams: Record<string, unknown> = { session_id: "custom-session" };
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      sessionParams,
      "chat-123",
    );
    expect(sessionParams.session_id).toBe("custom-session");

    const cacheKeyParams: Record<string, unknown> = { prompt_cache_key: "custom-cache-key" };
    __test__.injectConnectionMetadataFlags(
      { provider: "openrouter", metadata: {} },
      cacheKeyParams,
      "chat-123",
    );
    expect(cacheKeyParams.session_id).toBeUndefined();
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

describe("agent generation accounting and dispatch recognition", () => {
  test("preserves ordered Responses call/result and host-guidance chronology", () => {
    const first: ProviderTransientCarrier = {
      kind: "openai_responses",
      items: [{
        type: "function_call",
        id: "call-item-a",
        call_id: "call-a",
        name: "lookup",
        arguments: "{}",
      }],
    };
    const afterFirst = __test__.mergeProviderTransientCarrier(undefined, first, [
      {
        type: "function_call_output",
        call_id: "call-a",
        output: "{\"ok\":true}",
      },
      {
        type: "message",
        role: "assistant",
        content: "unsigned boundary",
      },
      {
        type: "message",
        role: "system",
        content: "completion guidance",
      },
      {
        type: "message",
        role: "user",
        content: "host guidance",
      },
    ]);
    const second: ProviderTransientCarrier = {
      kind: "openai_responses",
      items: [{
        type: "function_call",
        id: "call-item-b",
        call_id: "call-b",
        name: "lookup",
        arguments: "{\"again\":true}",
      }],
    };
    const merged = __test__.mergeProviderTransientCarrier(afterFirst, second, [
      {
        type: "function_call_output",
        call_id: "call-b",
        output: "{\"ok\":true}",
      },
    ]);

    expect(merged.items.map((item) => {
      if (item.type === "function_call") return `call:${item.call_id}`;
      if (item.type === "function_call_output") return `result:${item.call_id}`;
      if (item.type === "message") {
        const content = typeof item.content === "string" ? item.content : "[output]";
        return `message:${item.role}:${content}`;
      }
      return `other:${item.type}`;
    })).toEqual([
      "call:call-a",
      "result:call-a",
      "message:assistant:unsigned boundary",
      "message:system:completion guidance",
      "message:user:host guidance",
      "call:call-b",
      "result:call-b",
    ]);
  });

  test("starts each Deepseek-compatible continuation with an empty carrier", () => {
    const firstGeneration = __test__.mergeProviderTransientCarrier(
      undefined,
      {
        kind: "openai_responses",
        items: [{
          type: "function_call",
          id: "historical-call-item",
          call_id: "historical-call",
          name: "lookup",
          arguments: "{}",
        }],
      },
      [{
        type: "function_call_output",
        call_id: "historical-call",
        output: "historical result",
      }],
    );
    const nextGeneration = __test__.mergeProviderTransientCarrier(
      undefined,
      {
        kind: "openai_responses",
        items: [{
          type: "function_call",
          id: "current-call-item",
          call_id: "current-call",
          name: "lookup",
          arguments: "{}",
        }],
      },
      [],
    );

    expect(firstGeneration.items).toHaveLength(2);
    expect(nextGeneration.items).toEqual([
      expect.objectContaining({ call_id: "current-call" }),
    ]);
  });
  test("rejects malformed Responses carrier discriminants", () => {
    expect(() => __test__.mergeProviderTransientCarrier(
      undefined,
      {
        kind: "openai_responses",
        items: [{ type: "message", role: "user", content: "forged host item" }],
      } as unknown as ProviderTransientCarrier,
      [],
    )).toThrow("malformed");
  });
  test("counts agent provider reasoning with a concrete tokenizer counter", async () => {
    let selectedModel: string | undefined;
    const observed = await __test__.observeAgentProviderOutput(
      "selected-model",
      {
        content: "",
        reasoning: "r".repeat(397),
        finish_reason: "stop",
      } satisfies GenerationResponse,
      new AbortController().signal,
      async (modelId) => {
        selectedModel = modelId;
        return {
          count: (text: string) => Math.ceil(text.length / 4),
          name: "selected",
        };
      },
    );

    expect(selectedModel).toBe("selected-model");
    expect(observed).toBe(100);
  });
  test("uses UTF-8 bytes when unavailable and rejects invalid concrete counts", async () => {
    const response = {
      content: "",
      reasoning: "reasoning",
      finish_reason: "stop",
    } satisfies GenerationResponse;
    const signal = new AbortController().signal;
    expect(await __test__.observeAgentProviderOutput(
      "missing-counter",
      response,
      signal,
      async () => null,
    )).toBe(Buffer.byteLength("reasoning", "utf8"));
    await expect(__test__.observeAgentProviderOutput(
      "broken-counter",
      response,
      signal,
      async () => ({
        count: () => -1,
        name: "broken",
      }),
    )).rejects.toThrow("provider_protocol_error");
  });

  test("adds child usage to root usage exactly once", () => {
    const root = {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      provider_raw: { request: 1 },
    };
    const child = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

    expect(__test__.addAgentUsageToGenerationUsage(root, child)).toEqual({
      prompt_tokens: 13,
      completion_tokens: 6,
      total_tokens: 19,
      provider_raw: { request: 1 },
    });
    expect(__test__.addAgentUsageToGenerationUsage(root, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })).toEqual(root);
  });

  test("accumulates provider rounds before adding child usage", () => {
    const first = {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    };
    const second = {
      prompt_tokens: 4,
      completion_tokens: 3,
      total_tokens: 7,
    };
    const providerUsage = __test__.settleGenerationRoundUsage(
      __test__.settleGenerationRoundUsage(undefined, first, true),
      second,
      true,
    );
    expect(__test__.addAgentUsageToGenerationUsage(providerUsage, {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    })).toEqual({
      prompt_tokens: 15,
      completion_tokens: 7,
      total_tokens: 22,
    });
  });

  test("preserves feature-inactive latest-round usage", () => {
    const first = {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    };
    const second = {
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
    };
    expect(__test__.settleGenerationRoundUsage(
      __test__.settleGenerationRoundUsage(undefined, first, false),
      second,
      false,
    )).toEqual(second);

    const malformed = __test__.settleGenerationRoundUsage(undefined, {
      prompt_tokens: Number.NaN,
      completion_tokens: 1,
      total_tokens: 1,
    }, false);
    expect(Number.isNaN(malformed?.prompt_tokens)).toBe(true);
  });

  test("reconciles absent and under-reported root usage to observed output", () => {
    expect(__test__.reconcileObservedGenerationUsage(undefined, 6)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 6,
      total_tokens: 6,
    });
    expect(__test__.reconcileObservedGenerationUsage({
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
      provider_raw: { request: "retained" },
    }, 4)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      provider_raw: { request: "retained" },
    });
  });

  test("rejects every explicit malformed active-provider usage value", () => {
    for (const malformed of [
      null,
      false,
      "invalid",
      [],
      {
        prompt_tokens: Number.NaN,
        completion_tokens: 1,
        total_tokens: 1,
      },
    ]) {
      let error: unknown;
      try {
        __test__.addCheckedGenerationUsage(undefined, malformed as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "provider_protocol_error" });
    }
  });

  test("rejects unsafe root-plus-child usage without publishing an imprecise sum", () => {
    const root = {
      prompt_tokens: Number.MAX_SAFE_INTEGER,
      completion_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER,
    };
    let error: unknown;
    try {
      __test__.addAgentUsageToGenerationUsage(root, {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "provider_protocol_error" });
  });

  test("carries the exact fatal child code through the terminal reason", () => {
    const owner = {
      ledger: { failure: null },
    } as unknown as AgentRuntimeOwner;
    const fatal = new AgentRuntimeFailure("provider_failed");
    expect(__test__.terminalReasonForError(fatal, undefined)).toBe("failed");
    const reason = __test__.terminalReasonForError(fatal, owner);
    expect(reason).toBe("provider_request_error");
    expect(__test__.terminalAgentError(owner, reason)).toMatchObject({
      code: "provider_request_error",
      category: "provider",
    });
    expect(__test__.terminalAgentError(owner, "failed")).toMatchObject({
      code: "internal_error",
      category: "internal",
    });
    expect(__test__.terminalAgentError(owner, "completed")).toBeUndefined();
    expect(__test__.terminalAgentError(undefined, "failed")).toBeUndefined();
  });

  test("recognizes the closed feature catalog before Council dispatch", () => {
    expect(__test__.recognizedAgentToolNames.has("lore_search_entries")).toBe(true);
    expect(__test__.recognizedAgentToolNames.has("chat_search_history")).toBe(true);
    expect(__test__.recognizedAgentToolNames.has("agent_delegate")).toBe(true);
    expect(__test__.recognizedAgentToolNames.has("council_tool")).toBe(false);
  });

  test("rejects empty or duplicate provider call IDs before dispatch", () => {
    expect(() =>
      __test__.validateInlineToolCallIds([
        { name: "lore_list_books", args: {}, call_id: "duplicate" },
        { name: "chat_search_history", args: {}, call_id: "duplicate" },
      ]),
    ).toThrow("Provider returned invalid tool call identifiers");
    expect(() =>
      __test__.validateInlineToolCallIds([
        { name: "lore_list_books", args: {}, call_id: " " },
      ]),
    ).toThrow("Provider returned invalid tool call identifiers");
  });

  test("uses a bijective safe name for extension registrations", () => {
    const first = __test__.encodeExtensionToolName("extension__:tool");
    const second = __test__.encodeExtensionToolName("extension:__tool");
    expect(first).not.toBe(second);
    expect(first).not.toContain(":");
    expect(second).not.toContain(":");
  });

  test("rejects incomplete terminal provider tool batches", () => {
    expect(() =>
      __test__.validateTerminalProviderToolBatch("tool_calls", undefined),
    ).toThrow("without a complete batch");
    expect(() =>
      __test__.validateTerminalProviderToolBatch("tool_calls", []),
    ).toThrow("without a complete batch");
    expect(() =>
      __test__.validateTerminalProviderToolBatch("tool_calls", [
        { name: "tool", call_id: "call-1", args: {} },
        { name: "tool", call_id: "call-1", args: {} },
      ]),
    ).toThrow("malformed tool call");
    expect(
      __test__.validateTerminalProviderToolBatch("stop", undefined),
    ).toBeUndefined();
  });

  test("retains positional results and closes unmatched calls", () => {
    const calls = [
      { name: "hallucinated", args: {}, call_id: "unknown-call" },
      { name: "lore_list_books", args: {}, call_id: "known-call" },
    ];
    const knownResult = {
      callId: "known-call",
      qualifiedName: "lore_list_books",
      toolName: "lore_list_books",
      toolDisplayName: "List Lore Books",
      result: '{"status":"success"}',
    };

    const results = __test__.completeInlineToolResults(calls, [
      undefined,
      knownResult,
    ]);

    expect(results.map((result) => result.callId)).toEqual([
      "unknown-call",
      "known-call",
    ]);
    expect(results[0]?.result).toContain('"errorCode":"invalid_arguments"');
    expect(results[1]).toBe(knownResult);
  });

  test("keeps agent definitions provider-neutral and uses legacy untrusted continuation", () => {
    const request = {
      connection: TEST_CONNECTION,
      messages: [{ role: "user", content: "Find it" }],
      tools: [{
        name: "lore_list_books",
        description: "List books",
        parameters: { type: "object", additionalProperties: false },
      }],
      maxOutputTokens: 64,
      signal: new AbortController().signal,
    } satisfies Parameters<typeof __test__.prepareAgentProviderRequest>[1];
    const prepared = __test__.prepareAgentProviderRequest(
      {
        provider: { name: "unsupported-provider" },
        connection: { model: "model", metadata: {} },
      },
      request,
      {},
    );

    expect(prepared.tools).toEqual(request.tools);

    const continuation = buildInlineToolContinuation({
      structured: false,
      legacyResultRole: "user",
      legacyAssistantOutput: "partial",
      roundContent: "partial",
      roundReasoning: "",
      toolCalls: [{
        name: "lore_list_books",
        args: {},
        call_id: "call-0",
      }],
      results: [{
        callId: "call-0",
        qualifiedName: "lore_list_books",
        toolName: "lore_list_books",
        toolDisplayName: "lore_list_books",
        result: '{"status":"success"}',
      }],
    });
    expect(continuation).toHaveLength(2);
    expect(continuation[0]).toMatchObject({
      role: "assistant",
      content: "partial",
    });
    expect(continuation[1]?.role).toBe("user");
    expect(String(continuation[1]?.content)).toContain(
      "untrusted advisory user data",
    );
  });
  test("keeps Council-only OpenAI native-only rounds on legacy system continuation", () => {
    const provider = new OpenAIProvider();
    expect(provider.capabilities.toolContinuationMode).toBe("native");
    expect(provider.capabilities.supportsToolFinalization).toBe(true);
    expect(provider.capabilities.interleavedThinking).not.toBe(true);

    const councilPolicy = __test__.resolveInlineToolContinuationPolicy(
      true,
      false,
      provider.capabilities,
    );
    expect(councilPolicy).toEqual({
      structured: false,
      legacyResultRole: "system",
    });

    const agentPolicy = __test__.resolveInlineToolContinuationPolicy(
      true,
      true,
      provider.capabilities,
    );
    expect(agentPolicy).toEqual({
      structured: true,
      legacyResultRole: "user",
    });

    expect(__test__.resolveInlineToolContinuationPolicy(
      true,
      true,
      { ...provider.capabilities, nativeToolContinuation: false },
    )).toEqual({
      structured: false,
      legacyResultRole: "user",
    });
  });



  test("forced and no-preset resolution bypass profile bindings", () => {
    const safePreset = { id: "safe", metadata: {} } as any;
    const unsafePreset = {
      id: "unsafe",
      agent_config: {
        version: 2,
        agentsEnabled: true,
        allowedModes: ["response"],
        defaultMode: "response",
        maxInvocations: 64,
        maxToolCalls: 64,
        mainToolIds: ["lore_list_books"],
        mainLoreScope: "active",
        profiles: [],
        connectionSlots: [],
      },
    } as any;
    let profileCalls = 0;
    const resolvers = {
      resolveProfile: () => {
        profileCalls++;
        return { preset_id: "safe", binding: null };
      },
      getPreset: (_userId: string, presetId: string) =>
        presetId === "unsafe" ? unsafePreset : safePreset,
    };
    const baseArgs = {
      userId: "user",
      chat: { id: "chat", metadata: {}, character_id: null },
      connection: { id: "connection", preset_id: "unsafe" } as any,
    };

    const forced = __test__.resolveEffectiveAgentPreset(
      { ...baseArgs, presetId: "unsafe", forcePresetId: true },
      resolvers,
    );
    expect(forced.preset?.id).toBe("unsafe");
    expect(profileCalls).toBe(0);

    const noPreset = __test__.resolveEffectiveAgentPreset(
      {
        ...baseArgs,
        chat: {
          ...baseArgs.chat,
          metadata: { temporary: true, no_preset: true },
        },
      },
      resolvers,
    );
    expect(noPreset).toEqual({ preset: null, binding: null });
    expect(profileCalls).toBe(0);
  });

  test("clones the admitted effective preset snapshot before sidecar work", () => {
    const source = {
      preset: {
        agent_config: {
          version: 2,
          agentsEnabled: true,
          allowedModes: ["response"],
          defaultMode: "response",
          maxInvocations: 64,
          maxToolCalls: 64,
          mainToolIds: [],
          mainLoreScope: "active",
          profiles: [],
          connectionSlots: [],
        },
        prompt_order: [{ id: "block", enabled: true }],
      },
      binding: {
        preset_id: "admitted-safe",
        block_states: { block: true },
        captured_at: 1,
      },
    } as any;
    const admitted = __test__.cloneEffectiveAgentPresetResolution(source);

    source.preset.agent_config.agentsEnabled = false;
    source.preset.prompt_order[0].enabled = false;
    source.binding.block_states.block = false;

    const admittedConfig = admitted.preset?.agent_config;
    if (!admitted.preset || !admittedConfig || !admitted.binding) {
      throw new Error("Expected an admitted preset and binding snapshot");
    }
    expect(admittedConfig.agentsEnabled).toBe(true);
    expect(admitted.preset.prompt_order[0].enabled).toBe(true);
    expect(admitted.binding.block_states.block).toBe(true);
  });

  test("rejects only active executable room intrinsics before Council", () => {
    const config: AgentConfigV2 = {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response"],
      defaultMode: "response",
      maxInvocations: 64,
      maxToolCalls: 64,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [{
        id: "writer",
        name: "Writer",
        systemPrompt: "",
        connectionRef: { kind: "inherit_main" },
        toolIds: [],
        loreScope: "active",
        allowMainDelegation: false,
        failurePolicy: "optional",
        streamActivity: false,
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }],
      connectionSlots: [],
    };
    const makePreset = (block: Record<string, unknown>, agentsEnabled = true) => ({
      id: "room-preset",
      agent_config: { ...config, agentsEnabled },
      prompt_order: [{
        id: "agent-block",
        name: "Agent",
        content: "{{agent::writer}}Do work{{/agent}}",
        role: "user",
        enabled: true,
        position: "in_history",
        depth: 0,
        marker: null,
        isLocked: false,
        color: null,
        injectionTrigger: [],
        group: null,
        ...block,
      }],
    }) as any;
    const baseArgs = {
      userId: "user",
      chat: { id: "room-chat", metadata: { multiplayer_room_id: "room" } },
      preset: undefined,
      binding: null,
      generationType: "normal",
      targetCharacterId: undefined,
    } satisfies Parameters<typeof __test__.assertRoomAgentIntrinsicsBeforeCouncil>[0];

    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: makePreset({}),
      }),
    ).toThrow(/Agent intrinsics are unavailable in active multiplayer rooms/);

    const reorderedPreset = makePreset({});
    const templateBlock = reorderedPreset.prompt_order[0];
    reorderedPreset.prompt_order = [
      {
        ...templateBlock,
        id: "consumer",
        content: "{{agentResult::answer}}",
        position: "post_history",
      },
      {
        ...templateBlock,
        id: "history",
        content: "",
        marker: "chat_history",
        position: "in_history",
      },
      {
        ...templateBlock,
        id: "producer",
        content: "{{agent::writer::as=answer}}Do work{{/agent}}",
        position: "pre_history",
      },
    ];
    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: reorderedPreset,
      }),
    ).toThrow(/Agent intrinsics are unavailable in active multiplayer rooms/);
    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: makePreset({}, false),
      }),
    ).not.toThrow();
    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: makePreset({ enabled: false }),
      }),
    ).not.toThrow();
    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: makePreset({ characterTagTrigger: ["unmatched"] }),
      }),
    ).not.toThrow();
    expect(() =>
      __test__.assertRoomAgentIntrinsicsBeforeCouncil({
        ...baseArgs,
        preset: makePreset({ injectionTrigger: ["regenerate"] }),
      }),
    ).not.toThrow();
  });

  test("captures child custom-body and prompt-caching parameters with host max_tokens", () => {
    const request = {
      connection: TEST_CONNECTION,
      messages: [{ role: "system", content: "system" }],
      tools: [{
        name: "lore_list_books",
        description: "List books",
        parameters: { type: "object", additionalProperties: false },
      }],
      maxOutputTokens: 64,
      signal: new AbortController().signal,
    } satisfies Parameters<typeof __test__.prepareAgentProviderRequest>[1];
    const prepared = __test__.prepareAgentProviderRequest(
      {
        provider: { name: "anthropic" },
        connection: {
          model: "claude-test",
          metadata: { prompt_caching: true },
        },
      },
      request,
      { max_tokens: 4096, custom_body_value: "preserved" },
    );

    expect(prepared.parameters?.max_tokens).toBe(64);
    expect(prepared.parameters?.custom_body_value).toBe("preserved");
    expect(prepared.parameters?.prompt_caching).toBe(true);
    expect(prepared.messages[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("only retries main-process assembly errors", () => {
    expect(
      __test__.isMainProcessAssemblyRetryError({
        name: "AgentAssemblyRequiresMainProcessError",
      }),
    ).toBe(true);
    expect(
      __test__.isMainProcessAssemblyRetryError({
        name: "AgentDryRunUnsupportedError",
      }),
    ).toBe(false);
    expect(
      __test__.isMainProcessAssemblyRetryError({
        name: "AgentMultiplayerUnsupportedError",
      }),
    ).toBe(false);
  });

  test("rejects impersonated and wrong-swipe agent summary targets", () => {
    expect(__test__.isAgentSummaryPersistenceTarget(
      { generationType: "impersonate" },
      "user-message",
      0,
    )).toBe(false);
    expect(__test__.isAgentSummaryPersistenceTarget(
      {
        generationType: "regenerate",
        targetMessageId: "assistant-message",
        targetSwipeIdx: 1,
      },
      "assistant-message",
      0,
    )).toBe(false);
  });

  test("allows a staged assistant summary at swipe zero without a regenerate swipe index", () => {
    const stagedLifecycle = {
      generationType: "normal" as const,
      targetMessageId: "staged-assistant",
      stagedMessageId: "staged-assistant",
    };

    expect(__test__.isAgentSummaryPersistenceTarget(
      stagedLifecycle,
      "staged-assistant",
      0,
    )).toBe(true);
    expect(__test__.isAgentSummaryPersistenceTarget(
      stagedLifecycle,
      "different-message",
      0,
    )).toBe(false);
  });
});


describe("production agent seal diagnostics", () => {
  test("reports a prompt-regex seal mutation with safe user and log text", () => {
    const registry = new AgentSealRegistry();
    const seal = registry.createDirectSeal({
      producerLabel: "Writer",
      status: "succeeded",
      content: "opaque agent output",
    });
    const messages: LlmMessage[] = [{
      role: "user",
      content: `Before ${seal} after`,
    }];
    registry.captureBeforePromptTransforms(messages);
    messages[0]!.content = "Before transformed content after";

    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      let thrown: unknown;
      try {
        __test__.validateAgentSealBoundary("prompt_regex", registry, messages);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      const userText = __test__.errorMessage(thrown);
      expect(userText).toBe(
        "Protected agent output was modified during prompt regex processing. Retry the request. (stage=prompt_regex, reason=seal_missing)",
      );
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]).toEqual([
        "[agents] Agent result integrity failure",
        { reason: "seal_missing", stage: "prompt_regex" },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("production agent final context fit", () => {
  function expectFinalContextFitRejection(
    stats: ContextClipStats,
  ): void {
    let thrown: unknown;
    try {
      __test__.assertAgentFinalContextFit(stats);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      reasonCode: "context_limit_exceeded",
      stage: "final_context_fit",
    });
  }

  test("rejects budget-invalid final context", () => {
    expectFinalContextFitRejection(
      makeContextClipStats({ budgetInvalid: true }),
    );
  });

  test("rejects fixed-over-budget final context", () => {
    expectFinalContextFitRejection(
      makeContextClipStats({ fixedOverBudget: true }),
    );
  });

  test("rejects anchor-overflow final context", () => {
    expectFinalContextFitRejection(
      makeContextClipStats({ anchorOverflow: true }),
    );
  });

  test("accepts a valid final context", () => {
    expect(() =>
      __test__.assertAgentFinalContextFit(makeContextClipStats()),
    ).not.toThrow();
  });
});

describe("raw generation tool mode", () => {
  beforeAll(async () => {
    initDatabase(":memory:");
    await runMigrations(getDb());
  });

  afterAll(async () => {
    await closeDatabaseAsync();
  });

  const toolDefinitions: NonNullable<GenerationRequest["tools"]> = [{
    name: "record_result",
    description: "Record the result",
    parameters: { type: "object", additionalProperties: false },
  }];

  class RawToolModeProvider implements LlmProvider {
    readonly displayName = "Raw tool mode test provider";
    readonly defaultUrl = "https://raw-tool-mode.invalid/v1";
    readonly capabilities: ProviderCapabilities;
    readonly requests: GenerationRequest[] = [];

    constructor(
      readonly name: string,
      requiredToolChoice: boolean,
    ) {
      this.capabilities = {
        parameters: {},
        requiresMaxTokens: false,
        supportsSystemRole: true,
        supportsStreaming: true,
        apiKeyRequired: false,
        modelListStyle: "none",
        toolCalling: true,
        requiredToolChoice,
        nativeToolContinuation: true,
        toolContinuationMode: "native",
        toolsDisabledFinalization: true,
        supportsToolFinalization: true,
      };
    }

    async generate(
      _apiKey: string,
      _apiUrl: string,
      request: GenerationRequest,
    ): Promise<GenerationResponse> {
      this.requests.push(request);
      return { content: "ok", finish_reason: "stop" };
    }

    async *generateStream(
      _apiKey: string,
      _apiUrl: string,
      request: GenerationRequest,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      this.requests.push(request);
      yield { token: "ok", finish_reason: "stop" };
    }

    async validateKey(): Promise<boolean> {
      return true;
    }

    async listModels(): Promise<string[]> {
      return ["raw-tool-mode-model"];
    }
  }

  function inputFor(
    provider: RawToolModeProvider,
    toolMode: GenerationRequest["toolMode"],
  ): Parameters<typeof rawGenerate>[1] {
    return {
      provider: provider.name,
      model: "raw-tool-mode-model",
      messages: [{ role: "user", content: "Use the admitted tool." }],
      api_key: "test-key",
      reasoning: { source: "off" },
      toolMode,
    };
  }

  test("forwards ordinary and required modes to a capable provider request", async () => {
    const provider = new RawToolModeProvider(
      "raw-tool-mode-capable-forwarding",
      true,
    );
    registerProvider(provider);

    await rawGenerate("raw-tool-mode-user", {
      ...inputFor(provider, "ordinary"),
      tools: toolDefinitions,
    });
    await rawGenerate("raw-tool-mode-user", {
      ...inputFor(provider, "required"),
      tools: toolDefinitions,
    });

    expect(provider.requests.map((request) => request.toolMode)).toEqual([
      "ordinary",
      "required",
    ]);
    expect(provider.requests.map((request) => request.tools)).toEqual([
      toolDefinitions,
      toolDefinitions,
    ]);
  });

  test("fails required mode closed without an admitted tool", async () => {
    const provider = new RawToolModeProvider(
      "raw-tool-mode-capable-no-tools",
      true,
    );
    registerProvider(provider);

    await expect(
      rawGenerate(
        "raw-tool-mode-user",
        inputFor(provider, "required"),
      ),
    ).rejects.toThrow("Required tool mode needs at least one admitted host tool");
    expect(provider.requests).toHaveLength(0);
  });

  test("uses runtime capability for required mode without blocking ordinary mode", async () => {
    const provider = new RawToolModeProvider(
      "raw-tool-mode-incapable",
      false,
    );
    registerProvider(provider);

    await rawGenerate("raw-tool-mode-user", {
      ...inputFor(provider, "ordinary"),
      tools: toolDefinitions,
    });
    await expect(
      rawGenerate("raw-tool-mode-user", {
        ...inputFor(provider, "required"),
        tools: toolDefinitions,
      }),
    ).rejects.toThrow(
      'Provider "raw-tool-mode-incapable" does not support required tool choice',
    );

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.toolMode).toBe("ordinary");
  });
});
describe.serial("root generation usage accounting", () => {
  const previousPromptAssemblyWorker =
    process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
  type UsageScenario =
    | "finalization"
    | "provider_failure"
    | "root_overflow"
    | "sparse_usage"
    | "stuck_teardown"
    | "inactive_success"
    | "inactive_failure"
    | "response_loom"
    | "response_phase_loom"
    | "response_mentions";

  class ProductionUsageProvider implements LlmProvider {
    readonly name = "root-usage-test";
    readonly displayName = "Root Usage Test";
    readonly defaultUrl = "http://unused.test";
    readonly capabilities: ProviderCapabilities = {
      parameters: {},
      requiresMaxTokens: false,
      supportsSystemRole: true,
      supportsStreaming: true,
      apiKeyRequired: false,
      modelListStyle: "openai",
      toolCalling: true,
      requiredToolChoice: true,
      nativeToolContinuation: true,
      toolContinuationMode: "native",
      toolsDisabledFinalization: true,
      supportsToolFinalization: true,
    };
    readonly rootRequests: GenerationRequest[] = [];
    readonly childRequests: GenerationRequest[] = [];
    readonly blockedPull = Promise.withResolvers<void>();
    readonly blockedPullEntered = Promise.withResolvers<void>();
    streamClosed = false;

    constructor(readonly scenario: UsageScenario) {}

    async generate(
      _apiKey: string,
      _apiUrl: string,
      request: GenerationRequest,
    ): Promise<GenerationResponse> {
      this.childRequests.push(request);
      return {
        content: "delegated answer",
        finish_reason: "stop",
        usage: {
          prompt_tokens: 3,
          completion_tokens: 5,
          total_tokens: 8,
        },
      };
    }

    async *generateStream(
      _apiKey: string,
      _apiUrl: string,
      request: GenerationRequest,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      this.rootRequests.push(request);
      if (
        this.scenario === "response_loom" ||
        this.scenario === "response_phase_loom" ||
        this.scenario === "response_mentions"
      ) {
        try {
          yield {
            token: "ordinary answer",
            finish_reason: "stop",
            usage: {
              prompt_tokens: 7,
              completion_tokens: 2,
              total_tokens: 9,
            },
          };
        } finally {
          this.streamClosed = true;
        }
        return;
      }
      if (this.scenario === "inactive_success") {
        try {
          yield {
            token: "ordinary answer",
            finish_reason: "stop",
          };
          yield {
            token: "",
            usage: {
              prompt_tokens: 7,
              completion_tokens: 2,
              total_tokens: 9,
            },
          };
        } finally {
          this.streamClosed = true;
        }
        return;
      }
      if (this.scenario === "stuck_teardown") {
        yield { token: "partial" };
        this.blockedPullEntered.resolve();
        await this.blockedPull.promise;
        return;
      }
      if (
        this.scenario === "provider_failure" ||
        this.scenario === "inactive_failure"
      ) {
        yield {
          token: "partial",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        };
        throw new ProviderProtocolError("Provider stream failed after usage");
      }

      if (this.rootRequests.length === 1) {
        yield {
          token: "",
          finish_reason: "tool_calls",
          tool_calls: [{
            name: "agent_delegate",
            args: {
              profile_id: "writer",
              task: "Return the delegated answer.",
            },
            call_id: "delegate-1",
          }],
          usage: this.scenario === "sparse_usage"
            ? undefined
            : this.scenario === "root_overflow"
              ? {
                  prompt_tokens: Number.MAX_SAFE_INTEGER - 2_048,
                  completion_tokens: 0,
                  total_tokens: Number.MAX_SAFE_INTEGER - 2_048,
                }
              : {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  total_tokens: 12,
                },
        };
        return;
      }
      if (this.rootRequests.length === 2) {
        yield {
          token: "done",
          finish_reason: "stop",
          usage: this.scenario === "root_overflow"
            ? {
                prompt_tokens: 2_048,
                completion_tokens: 0,
                total_tokens: 2_048,
              }
            : this.scenario === "sparse_usage"
              ? {
                  prompt_tokens: 15,
                  completion_tokens: 0,
                  total_tokens: 15,
                }
              : {
                  prompt_tokens: 15,
                  completion_tokens: 3,
                  total_tokens: 18,
                },
        };
        return;
      }
      throw new Error("Unexpected root provider round");
    }

    async validateKey(): Promise<boolean> {
      return true;
    }

    async listModels(): Promise<string[]> {
      return ["usage-model"];
    }
  }

  type TerminalObservation = {
    event: EventType;
    payload: Record<string, any>;
  };

  function waitForGenerationTerminal(
    generationId: string,
  ): Promise<TerminalObservation> {
    const { promise, resolve } =
      Promise.withResolvers<TerminalObservation>();
    let settled = false;
    const unsubscribers: Array<() => void> = [];
    const observe = (eventType: EventType) => (event: {
      payload: Record<string, any>;
    }) => {
      if (settled || event.payload?.generationId !== generationId) return;
      settled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve({ event: eventType, payload: event.payload });
    };
    unsubscribers.push(
      eventBus.on(
        EventType.GENERATION_ENDED,
        observe(EventType.GENERATION_ENDED),
      ),
      eventBus.on(
        EventType.GENERATION_STOPPED,
        observe(EventType.GENERATION_STOPPED),
      ),
    );
    return promise.then(async observation => {
      await chatsSvc.waitForChatChunkMaintenance(observation.payload.chatId);
      return observation;
    });
  }

  function waitForGenerationEvent(
    eventType: EventType,
    generationId: string,
  ): Promise<Record<string, any>> {
    const { promise, resolve } =
      Promise.withResolvers<Record<string, any>>();
    const unsubscribe = eventBus.on(eventType, (event) => {
      if (event.payload?.generationId !== generationId) return;
      unsubscribe();
      resolve(event.payload);
    });
    return promise;
  }

  async function createFixture(scenario: UsageScenario) {
    process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = "false";
    await chatsSvc.waitForChatChunkMaintenance();
    pool.clearAllPoolEntries();
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());

    // The owner lookup is process-cached while this fixture replaces the in-memory DB.
    // Re-seed the same owner identity after every reset so inherited settings retain
    // a valid foreign-key principal across all reset fixtures in this file.
    const userId = TEST_OWNER_ID;
    const hasResponseWorkPolicy =
      scenario === "response_loom" || scenario === "response_mentions";
    const hasResponsePhasePolicy =
      scenario === "response_phase_loom" || scenario === "response_mentions";
    const isResponseLoomScenario =
      hasResponseWorkPolicy || hasResponsePhasePolicy;
    getDb().query(
      'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
    ).run(userId, "Usage Owner", `${userId}@example.test`);
    const provider = new ProductionUsageProvider(scenario);
    registerProvider(provider);
    const connection = await connectionsSvc.createConnection(userId, {
      name: "Usage connection",
      provider: provider.name,
      model: "usage-model",
      is_default: true,
    });
    const agentConfig: AgentConfigV2 = {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response"],
      defaultMode: "response",
      maxInvocations: 4,
      maxToolCalls: 1,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [{
        id: "writer",
        name: "Writer",
        systemPrompt: "Return a concise answer.",
        connectionRef: { kind: "slot", slotId: "profile/writer" },
        toolIds: [],
        loreScope: "active",
        allowMainDelegation: true,
        failurePolicy: "required",
        streamActivity: false,
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }],
      connectionSlots: [{
        id: "profile/writer",
        label: "Writer",
        requiredCapabilities: ["generation"],
      }],
    };
    const preset = presetsSvc.createPreset(userId, {
      name: "Usage preset",
      provider: "loom",
      parameters: { max_tokens: 64 },
      prompt_order: [
        {
          id: "system",
          name: "System",
          content: isResponseLoomScenario ? "Answer {{user}}." : "Answer the user.",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
        },
        ...(hasResponseWorkPolicy ? [] : [{
          id: "history",
          name: "Chat History",
          content: "",
          role: "user" as const,
          enabled: true,
          position: "in_history" as const,
          depth: 0,
          marker: "chat_history",
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
        }]),
        ...(hasResponseWorkPolicy ? [{
          id: "work-policy",
          name: "Work policy",
          content: "Internal work-only policy.",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
        }] : []),
        ...(hasResponsePhasePolicy ? [{
          id: "phase-policy",
          name: "Phase policy",
          content: "Internal phase-only policy.",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
        }] : []),
      ],
      ...(scenarioIsAgentActive(scenario) && !isResponseLoomScenario
        ? { agent_config: agentConfig }
        : {}),
    });
    const configForPreset: AgentConfigV2 =
      isResponseLoomScenario
        ? {
            ...agentConfig,
            runtimePolicy: {
              version: 1,
              authority: "loom",
              scope: "preset",
              defaultMode: "response",
              loomPolicy: hasResponseWorkPolicy
                ? {
                    version: 1,
                    workPolicy: Array.from({ length: 5 }, (_, index) => ({
                      version: 1 as const,
                      id: `work-only-entry-${index + 1}`,
                      source: {
                        kind: "loom_block" as const,
                        blockId: "work-policy",
                        presetRevision: preset.cache_revision ?? 1,
                        blockRevision: 1,
                        promptOrder: preset.prompt_order.findIndex(
                          (block) => block?.id === "work-policy",
                        ),
                      },
                      destination: "root_work" as const,
                      checkpoint: "WORK" as const,
                      required: false,
                      visibility: "work_only" as const,
                    })),
                    workspaceUsage: [],
                    completionCriteria: [],
                    renderPolicy: [],
                  }
                : {
                    version: 1,
                    workPolicy: [],
                    workspaceUsage: [],
                    completionCriteria: [],
                    renderPolicy: [],
                  },
              phases: hasResponsePhasePolicy
                ? Array.from({ length: 6 }, (_, index) => ({
                    version: 1 as const,
                    id: `phase_only_${index + 1}`,
                    label: `Phase only ${index + 1}`,
                    instructionRefs: [{
                      kind: "loom_block" as const,
                      blockId: "phase-policy",
                      presetRevision: preset.cache_revision ?? 1,
                      blockRevision: 1,
                      promptOrder: preset.prompt_order.findIndex(
                        (block) => block?.id === "phase-policy",
                      ),
                    }],
                    childInstructionSubsets: [],
                    required: false,
                    enter: { kind: "generation_type" as const, value: "normal" },
                    exit: { kind: "phase" as const, value: "WORK" },
                    capabilityRequests: [],
                    repeatLimit: 0,
                    nextPhaseIds: [],
                  }))
                : [],
            },
          }
        : agentConfig;
    if (scenarioIsAgentActive(scenario)) {
      writePresetAgentConfig(userId, preset.id, {
        config: configForPreset,
        bindings: [{ slotId: "profile/writer", connectionId: connection.id }],
      });
    }
    const chat = chatsSvc.createChat(userId, {
      character_id: null,
      name: "Usage accounting",
      metadata: { temporary: true },
    });
    if (isResponseLoomScenario) {
      const worldBook = worldBooksSvc.createWorldBook(userId, {
        name: "Response lore",
      });
      const worldEntry = worldBooksSvc.createEntry(userId, worldBook.id, {
        key: ["blue lantern"],
        content: "World context for {{user}}: blue lantern.",
        comment: "Response context",
        constant: true,
        disabled: false,
        role: "system",
      });
      if (!worldEntry) {
        throw new Error("Expected the response world-book entry to be created");
      }
      chatsSvc.updateChat(userId, chat.id, {
        metadata: {
          temporary: true,
          chat_world_book_ids: [worldBook.id],
          active_world_info_entry_ids: [worldEntry.id],
          authors_note: {
            content: "NATIVE-WI-RESPONSE: preserve the exact current request.",
            role: "system",
            position: 1,
            depth: 0,
          },
        },
      });
    }
    if (hasResponseWorkPolicy) {
      insertFixtureMessage(userId, chat.id, {
        is_user: true,
        name: "User",
        content: "Prior public request.",
      });
      insertFixtureMessage(userId, chat.id, {
        is_user: false,
        name: "Assistant",
        content: "Prior public reply.",
      });
    }
    insertFixtureMessage(userId, chat.id, {
      is_user: true,
      name: "User",
      content: scenario === "response_mentions"
        ? "RESPONSE-MENTION-SOURCE: use #global-response-source and #cross-reference-chat-source."
        : hasResponseWorkPolicy
          ? "RESPONSE-SOURCE-ROW: answer this exact request."
          : "Delegate this.",
    });
    return { userId, userName: "Usage Owner", provider, preset, connection, chat };
  }
  test("uses one combined native authority for sealed structural and intercepted WI provider context", async () => {
    const fixture = await createFixture("finalization");
    const character = charactersSvc.createCharacter(fixture.userId, {
      name: "Projection Character",
      description: "SEALED-DESCRIPTION-{{calc::1+1}}",
      extensions: {},
    });
    const worldBook = worldBooksSvc.createWorldBook(fixture.userId, { name: "Projection lore" });
    const worldEntry = worldBooksSvc.createEntry(fixture.userId, worldBook.id, {
      key: ["Delegate"],
      content: "ORIGINAL-RUNTIME",
      comment: "Projection runtime",
      constant: true,
      disabled: false,
      role: "system",
    });
    if (!worldEntry) throw new Error("Expected projection World Info entry");
    const fixedEntry = worldBooksSvc.createEntry(fixture.userId, worldBook.id, {
      key: ["Delegate"],
      content: "SEALED-WI-BLOCK",
      comment: "Projection fixed",
      constant: true,
      disabled: false,
      role: "system",
    });
    if (!fixedEntry) throw new Error("Expected fixed projection World Info entry");
    getDb().query("UPDATE chats SET character_id = ? WHERE id = ?").run(character.id, fixture.chat.id);
    chatsSvc.updateChat(fixture.userId, fixture.chat.id, {
      metadata: {
        temporary: false,
        chat_world_book_ids: [worldBook.id],
        active_world_info_entry_ids: [worldEntry.id, fixedEntry.id],
      },
    });
    const projectedBlocks = [
      { id: "sealed-description", name: "Description", content: "raw placeholder", role: "system" as const, enabled: true, position: "pre_history" as const, depth: 0, marker: "char_description" as const, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "sealed-world-before", name: "World before", content: "raw world placeholder", role: "user" as const, enabled: true, position: "pre_history" as const, depth: 0, marker: "world_info_before" as const, isLocked: false, color: null, injectionTrigger: [], group: null },
      { id: "excluded-generation-description", name: "Excluded generation description", content: "LEAKED-GENERATION-STRUCTURAL", role: "system" as const, enabled: true, position: "pre_history" as const, depth: 0, marker: "char_description" as const, isLocked: false, color: null, injectionTrigger: ["continue"], group: null },
      { id: "excluded-tag-world-before", name: "Excluded tag world before", content: "LEAKED-TAG-WORLD-MARKER", role: "system" as const, enabled: true, position: "pre_history" as const, depth: 0, marker: "world_info_before" as const, isLocked: false, color: null, injectionTrigger: [], characterTagTrigger: ["missing-character-tag"], group: null },
      ...fixture.preset.prompt_order,
      { id: "projection-post", name: "Projection post", content: "PROJECTION-POST", role: "system" as const, enabled: true, position: "post_history" as const, depth: 0, marker: null, isLocked: false, color: null, injectionTrigger: [], group: null },
    ];
    const updatedPreset = presetsSvc.updatePreset(fixture.userId, fixture.preset.id, { prompt_order: projectedBlocks });
    if (!updatedPreset) throw new Error("Expected projection preset update");
    const structuralProjection = await projectNativeContextForChat(fixture.userId, fixture.chat.id, {
      generationType: "normal",
      presetId: updatedPreset.id,
      connectionId: fixture.connection.id,
      forcePresetId: true,
      targetCharacterId: character.id,
      userInput: "Delegate this.",
    });
    expect(structuralProjection.structuralBlockValues["sealed-description"]).toBe("SEALED-DESCRIPTION-2");
    expect(structuralProjection.structuralBlockValues["sealed-world-before"]).toContain("SEALED-WI-BLOCK");
    expect(Object.hasOwn(structuralProjection.structuralBlockValues, "excluded-generation-description")).toBe(false);
    expect(Object.hasOwn(structuralProjection.structuralBlockValues, "excluded-tag-world-before")).toBe(false);
    let interceptorCalls = 0;
    const unregister = worldInfoInterceptorChain.register({
      extensionId: "projection-test",
      userId: fixture.userId,
      priority: -100,
      handler: async (ctx) => {
        interceptorCalls += 1;
        const target = ctx.entries.find((entry) => entry.id === worldEntry.id);
        if (!target) throw new Error("Expected attached projection World Info entry");
        return {
          mutated: [{
            id: target.id,
            content: "MUTATED-RUNTIME",
            selectionContent: "SELECTED-AUTHORITY",
            placement: { type: "chat_depth", role: "system", direction: "from_start", depth: 0 },
          }],
          captured: [target.id],
          activationOverrides: { disableRecursion: true },
        };
      },
    });
    try {
      const started = await startGeneration({
        userId: fixture.userId,
        userName: fixture.userName,
        chat_id: fixture.chat.id,
        connection_id: fixture.connection.id,
        preset_id: updatedPreset.id,
        force_preset_id: true,
        target_character_id: character.id,
        generation_type: "normal",
      });
      const terminal = await waitForGenerationTerminal(started.generationId);
      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(interceptorCalls).toBe(1);
      const requestTexts = fixture.provider.rootRequests[0]?.messages.map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      ) ?? [];
      const runtimeIndex = requestTexts.findIndex((text) => text.includes("MUTATED-RUNTIME"));
      const fixedIndex = requestTexts.findIndex((text) => text.includes("SEALED-WI-BLOCK"));
      const historyIndex = requestTexts.findIndex((text) => text.includes("Delegate this."));
      const postIndex = requestTexts.findIndex((text) => text.includes("PROJECTION-POST"));
      expect(runtimeIndex).toBeGreaterThanOrEqual(0);
      expect(fixedIndex).toBeGreaterThanOrEqual(0);
      expect(runtimeIndex).toBeGreaterThan(fixedIndex);
      expect(historyIndex).toBeGreaterThan(runtimeIndex);
      expect(postIndex).toBeGreaterThan(historyIndex);
      expect(requestTexts.join("\n")).toContain("SEALED-DESCRIPTION-2");
      expect(requestTexts.join("\n")).not.toContain("raw placeholder");
      expect(requestTexts.join("\n")).not.toContain("LEAKED-GENERATION-STRUCTURAL");
      expect(requestTexts.join("\n")).not.toContain("LEAKED-TAG-WORLD-MARKER");
      expect(requestTexts.join("\n")).not.toContain("ORIGINAL-RUNTIME");
      expect(requestTexts.join("\n")).not.toContain("SELECTED-AUTHORITY");
    } finally {
      unregister();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
  function scenarioIsAgentActive(scenario: UsageScenario): boolean {
    return scenario !== "inactive_success" && scenario !== "inactive_failure";
  }

  async function startFixture(
    fixture: Awaited<ReturnType<typeof createFixture>>,
  ) {
    return startGeneration({
      userId: fixture.userId,
      userName: fixture.userName,
      chat_id: fixture.chat.id,
      connection_id: fixture.connection.id,
      preset_id: fixture.preset.id,
      force_preset_id: true,
      generation_type: "normal",
    });
  }
  test("correlated id-less Stop retires a request suspended before generation registration", async () => {
    const fixture = await createFixture("inactive_success");
    const authorityId = crypto.randomUUID();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalResolve = runtimeDecisionSvc.resolveEffectiveRuntime;
    const resolveSpy = spyOn(runtimeDecisionSvc, "resolveEffectiveRuntime").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return originalResolve(...args);
    });
    try {
      const starting = startGeneration({
        userId: fixture.userId,
        userName: fixture.userName,
        chat_id: fixture.chat.id,
        connection_id: fixture.connection.id,
        preset_id: fixture.preset.id,
        force_preset_id: true,
        generation_type: "swipe",
        request_authority_id: authorityId,
      });
      const outcome = starting.then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      );
      await entered.promise;
      expect(getActiveGenerationCount()).toBe(0);
      expect(await stopGenerationRequestAuthority(fixture.userId, fixture.chat.id, authorityId)).toBe(true);
      release.resolve();
      const settled = await outcome;
      expect(settled.result).toBeNull();
      expect(settled.error).toMatchObject({ name: "AbortError" });
      expect(getActiveGenerationCount()).toBe(0);
      expect(pool.getPoolForChat(fixture.userId, fixture.chat.id)).toBeUndefined();
      expect(fixture.provider.rootRequests).toHaveLength(0);
    } finally {
      release.resolve();
      resolveSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  });
  test("keeps exact ordinary provider identity from pool creation through lifecycle events", async () => {
    const fixture = await createFixture("inactive_success");
    const started = Promise.withResolvers<Record<string, any>>();
    const inProgress = Promise.withResolvers<Record<string, any>>();
    const terminal = Promise.withResolvers<Record<string, any>>();
    const unsubscribers = [
      eventBus.on(EventType.GENERATION_STARTED, (event) => {
        if (event.payload?.chatId === fixture.chat.id) started.resolve(event.payload);
      }),
      eventBus.on(EventType.GENERATION_IN_PROGRESS, (event) => {
        if (event.payload?.chatId === fixture.chat.id) inProgress.resolve(event.payload);
      }),
      eventBus.on(EventType.GENERATION_ENDED, (event) => {
        if (event.payload?.chatId === fixture.chat.id) terminal.resolve(event.payload);
      }),
    ];

    try {
      const response = await startFixture(fixture);

      expect(fixture.provider.rootRequests).toHaveLength(0);
      expect(pool.getPoolEntry(response.generationId)).toMatchObject({
        generationId: response.generationId,
        chatId: fixture.chat.id,
        status: "assembling",
        provider: fixture.connection.provider,
        model: fixture.connection.model,
      });

      const [startedPayload, inProgressPayload, terminalPayload] =
        await Promise.all([started.promise, inProgress.promise, terminal.promise]);

      expect(startedPayload).toMatchObject({
        generationId: response.generationId,
        chatId: fixture.chat.id,
        provider: fixture.connection.provider,
        model: fixture.connection.model,
      });
      expect(inProgressPayload).toMatchObject({
        generationId: response.generationId,
        chatId: fixture.chat.id,
        provider: fixture.connection.provider,
        model: fixture.connection.model,
      });
      expect(terminalPayload.generationId).toBe(response.generationId);
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      await cleanupFixture(fixture.chat.id);
    }
  });

  function installResponseSettlementScript(
    userId: string,
    findRegex = "ordinary",
    replacement = "{{user}} * settled *",
  ): void {
    const created = regexScriptsSvc.createRegexScript(userId, {
      name: "Response settlement transform",
      find_regex: findRegex,
      replace_string: replacement,
      flags: "g",
      placement: ["ai_output"],
      scope: "global",
      target: ["response"],
      substitute_macros: "none",
    });
    if (typeof created === "string") throw new Error(created);
  }

  test("emits exact durable transformed content on ordinary completion", async () => {
    const fixture = await createFixture("inactive_success");
    installResponseSettlementScript(fixture.userId);
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);
      const message = chatsSvc.getMessage(
        fixture.userId,
        terminal.payload.messageId,
      );
      const settledContent = "Usage Owner *settled* answer";

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(message?.content).toBe(settledContent);
      expect(message?.swipes[0]).toBe(settledContent);
      expect(terminal.payload.content).toBe(message?.swipes[0]);
      expect(pool.getPoolEntry(started.generationId)?.content).toBe(
        "ordinary answer",
      );
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("emits the exact transformed continued swipe including its durable prefix", async () => {
    const fixture = await createFixture("inactive_success");
    installResponseSettlementScript(fixture.userId);
    const original = insertFixtureMessage(fixture.userId, fixture.chat.id, {
      is_user: false,
      name: "Assistant",
      content: "Settled prefix",
    });
    const continuePostfix = "\n--continue--\n";
    const preset = presetsSvc.updatePreset(fixture.userId, fixture.preset.id, {
      prompts: {
        ...fixture.preset.prompts,
        completionSettings: {
          ...fixture.preset.prompts.completionSettings,
          continuePostfix,
        },
      },
    });
    if (!preset) throw new Error("Expected continue preset update");

    try {
      const started = await startGeneration({
        userId: fixture.userId,
        userName: fixture.userName,
        chat_id: fixture.chat.id,
        connection_id: fixture.connection.id,
        preset_id: preset.id,
        force_preset_id: true,
        generation_type: "continue",
        message_id: original.id,
        swipe_id: original.swipe_id,
      });
      const terminal = await waitForGenerationTerminal(started.generationId);
      const message = chatsSvc.getMessage(fixture.userId, original.id);
      const settledContent =
        "Settled prefix\n--continue--\nUsage Owner *settled* answer";

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.messageId).toBe(original.id);
      expect(message?.swipes[original.swipe_id]).toBe(settledContent);
      expect(message?.content).toBe(settledContent);
      expect(terminal.payload.content).toBe(
        message?.swipes[original.swipe_id],
      );
      expect(pool.getPoolEntry(started.generationId)?.content).toBe(
        "ordinary answer",
      );
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
  test("keeps ordinary Response context and emits typed Loom omission evidence", async () => {
    const fixture = await createFixture("response_loom");
    const omittedEntryIds = Array.from(
      { length: 5 },
      (_, index) => `work-only-entry-${index + 1}`,
    );
    const workPolicySource = {
      kind: "loom_block" as const,
      blockId: "work-policy",
      presetRevision: fixture.preset.cache_revision ?? 1,
      blockRevision: 1,
      promptOrder: fixture.preset.prompt_order.findIndex(
        (block) => block?.id === "work-policy",
      ),
    };
    const expectedLoomInspection: LoomPromptInspectionV1 = {
      version: 1,
      surface: "RESPONSE",
      checkpoint: "ASSEMBLE",
      items: omittedEntryIds.map((entryId) => ({
        entryId,
        bucket: "workPolicy",
        destination: "root_work",
        checkpoint: "WORK",
        source: workPolicySource,
        conditionResult: "not_applicable",
        effectiveText: null,
        required: false,
        ordinaryPromptSuppressed: true,
        outcome: {
          status: "omitted",
          reason: "response_mode",
        },
      })),
      effectiveEntryIds: [],
      responseOmission: {
        version: 1,
        surface: "RESPONSE",
        visibility: "work_only",
        reason: "work_only",
        reviewReason: "response_surface",
        omittedEntryIds,
        source: omittedEntryIds.map(() => workPolicySource),
        omittedPhaseInstructions: [],
      },
    };
    const globalDatabank = databankSvc.createDatabank(fixture.userId, {
      name: "Response global",
      scope: "global",
    });
    const chatDatabank = databankSvc.createDatabank(fixture.userId, {
      name: "Response chat",
      scope: "chat",
      scopeId: fixture.chat.id,
    });
    let searchedDatabankIds: string[] = [];
    const embeddingSpy = spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue({
      enabled: true,
      provider: "openai",
      api_url: "https://unused.test",
      model: "unused",
      dimensions: null,
      send_dimensions: false,
      retrieval_top_k: 4,
      hybrid_weight_mode: "balanced",
      preferred_context_size: 512,
      batch_size: 8,
      similarity_threshold: 0,
      rerank_cutoff: 0,
      vectorize_world_books: false,
      vectorize_chat_messages: false,
      vectorize_chat_documents: false,
      chat_memory_mode: "balanced",
      request_timeout: 1,
      has_api_key: true,
      connectionProfiles: [],
      primaryProfileId: null,
      fallbackProfileIds: [],
    });
    const searchSpy = spyOn(databankSvc, "searchDatabanks").mockImplementation(
      async (_userId, _chatId, databankIds) => {
        searchedDatabankIds = [...databankIds];
        return {
          chunks: [],
          formatted: "AUTOMATIC-GLOBAL-DATABANK\nAUTOMATIC-CHAT-DATABANK",
          count: 2,
        };
      },
    );
    try {
      const dryRun = await dryRunGeneration({
        userId: fixture.userId,
        userName: fixture.userName,
        chat_id: fixture.chat.id,
        connection_id: fixture.connection.id,
        preset_id: fixture.preset.id,
        force_preset_id: true,
        generation_type: "normal",
      });
      expect(dryRun.assemblySurface).toBe("RESPONSE");
      expect(dryRun.loomPromptInspection).toEqual(expectedLoomInspection);

      const started = await startFixture(fixture);
      const emittedBreakdownPromise = waitForGenerationEvent(
        EventType.GENERATION_BREAKDOWN_READY,
        started.generationId,
      );
      const terminal = await waitForGenerationTerminal(started.generationId);
      const emittedBreakdown = await emittedBreakdownPromise;
      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(emittedBreakdown.breakdown).toMatchObject({
        assemblySurface: "RESPONSE",
        loomPromptInspection: expectedLoomInspection,
      });

      const requestText = fixture.provider.rootRequests[0]?.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n") ?? "";
      expect(requestText).toContain("Answer Usage Owner.");
      expect(requestText).toContain(
        "World context for Usage Owner: blue lantern.",
      );
      expect(requestText.match(/Prior public request\./g)).toHaveLength(1);
      expect(requestText.match(/Prior public reply\./g)).toHaveLength(1);
      expect(requestText.match(/RESPONSE-SOURCE-ROW: answer this exact request\./g)).toHaveLength(1);
      expect(requestText).toContain(
        "NATIVE-WI-RESPONSE: preserve the exact current request.",
      );
      expect(requestText).toContain("AUTOMATIC-GLOBAL-DATABANK");
      expect(requestText).toContain("AUTOMATIC-CHAT-DATABANK");
      expect(searchedDatabankIds).toEqual(
        expect.arrayContaining([globalDatabank.id, chatDatabank.id]),
      );
      expect(requestText).not.toContain("Write the next reply only as");
      expect(
        fixture.preset.prompt_order.some(
          (block) => block.marker === "chat_history",
        ),
      ).toBe(false);
      expect(requestText).not.toContain("Internal work-only policy.");
      expect(
        fixture.provider.rootRequests[0]?.tools?.map((tool) => tool.name),
      ).toContain("agent_delegate");
    } finally {
      embeddingSpy.mockRestore();
      searchSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
  test("resolves READY global and chat-cross-referenced mentions in ordinary Response", async () => {
    const fixture = await createFixture("response_mentions");
    const detachedChat = chatsSvc.createChat(fixture.userId, {
      character_id: null,
      name: "Detached databank owner",
      metadata: { temporary: true },
    });
    const globalBank = databankSvc.createDatabank(fixture.userId, {
      name: "Global Response Bank",
      scope: "global",
    });
    const crossReferenceBank = databankSvc.createDatabank(fixture.userId, {
      name: "Cross Reference Chat Bank",
      scope: "chat",
      scopeId: detachedChat.id,
    });
    const createReadyDocument = (
      databankId: string,
      name: string,
      fileStem: string,
      content: string,
    ) => {
      const document = databankSvc.createDocument(
        fixture.userId,
        databankId,
        name,
        fileStem + ".txt",
        "text/plain",
        content.length,
        "hash-" + fileStem,
      );
      databankSvc.insertChunks([{
        id: crypto.randomUUID(),
        documentId: document.id,
        databankId,
        userId: fixture.userId,
        chunkIndex: 0,
        content,
        tokenCount: content.split(/\s+/).length,
      }]);
      databankSvc.updateDocumentStatus(document.id, "ready", { totalChunks: 1 });
      return databankSvc.getDocument(fixture.userId, document.id);
    };
    const globalMarker =
      "GLOBAL-RESPONSE-SOURCE-MARKER: exact global source text.";
    const crossReferenceMarker =
      "CROSS-REFERENCE-CHAT-SOURCE-MARKER: exact attached chat source text.";
    const globalDocument = createReadyDocument(
      globalBank.id,
      "Global Response Source",
      "global-response-source",
      globalMarker,
    );
    const crossReferenceDocument = createReadyDocument(
      crossReferenceBank.id,
      "Cross Reference Chat Source",
      "cross-reference-chat-source",
      crossReferenceMarker,
    );
    const currentChat = chatsSvc.getChat(fixture.userId, fixture.chat.id);
    if (!currentChat) throw new Error("Expected the Response chat to exist");
    const updatedChat = chatsSvc.updateChat(fixture.userId, fixture.chat.id, {
      metadata: {
        ...currentChat.metadata,
        chat_databank_ids: [crossReferenceBank.id],
      },
    });
    if (!updatedChat) throw new Error("Expected the Response chat to update");

    const embeddingSpy = spyOn(
      embeddingsSvc,
      "getEmbeddingConfig",
    ).mockResolvedValue({
      enabled: false,
      provider: "openai",
      api_url: "https://unused.test",
      model: "unused",
      dimensions: null,
      send_dimensions: false,
      retrieval_top_k: 4,
      hybrid_weight_mode: "balanced",
      preferred_context_size: 512,
      batch_size: 8,
      similarity_threshold: 0,
      rerank_cutoff: 0,
      vectorize_world_books: false,
      vectorize_chat_messages: false,
      vectorize_chat_documents: false,
      chat_memory_mode: "balanced",
      request_timeout: 1,
      has_api_key: false,
      connectionProfiles: [],
      primaryProfileId: null,
      fallbackProfileIds: [],
    });

    try {
      expect(globalDocument).toMatchObject({
        slug: "global-response-source",
        status: "ready",
        totalChunks: 1,
      });
      expect(crossReferenceDocument).toMatchObject({
        slug: "cross-reference-chat-source",
        status: "ready",
        totalChunks: 1,
      });
      expect(crossReferenceBank.scopeId).not.toBe(fixture.chat.id);
      expect(updatedChat.metadata.chat_databank_ids).toEqual([
        crossReferenceBank.id,
      ]);

      const started = await startFixture(fixture);
      const emittedBreakdownPromise = waitForGenerationEvent(
        EventType.GENERATION_BREAKDOWN_READY,
        started.generationId,
      );
      const terminal = await waitForGenerationTerminal(started.generationId);
      const emittedBreakdown = await emittedBreakdownPromise;
      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(fixture.provider.rootRequests).toHaveLength(1);

      const requestText = fixture.provider.rootRequests[0]!.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n");
      const globalSource = "## Global Response Source\n" + globalMarker;
      const crossReferenceSource =
        "## Cross Reference Chat Source\n" + crossReferenceMarker;
      expect(requestText).not.toContain("#global-response-source");
      expect(requestText).not.toContain("#cross-reference-chat-source");
      expect(requestText).toContain(globalSource);
      expect(requestText).toContain(crossReferenceSource);
      expect(requestText).toContain(
        "NATIVE-WI-RESPONSE: preserve the exact current request.",
      );
      expect(requestText).not.toContain("Internal work-only policy.");
      expect(requestText).not.toContain("Internal phase-only policy.");

      const mentionEntry = emittedBreakdown.breakdown.entries.find(
        (entry: Record<string, any>) => entry.type === "databank_mention",
      );
      expect(mentionEntry).toMatchObject({
        name: "Databank Reference",
        role: "user",
      });
      expect(mentionEntry.content).toContain(globalSource);
      expect(mentionEntry.content).toContain(crossReferenceSource);

      const responseOmission =
        emittedBreakdown.breakdown.loomPromptInspection.responseOmission;
      expect(responseOmission.omittedEntryIds).toEqual(
        Array.from(
          { length: 5 },
          (_, index) => "work-only-entry-" + (index + 1),
        ),
      );
      expect(
        responseOmission.omittedPhaseInstructions.map(
          (item: { phaseId: string }) => item.phaseId,
        ),
      ).toEqual(
        Array.from({ length: 6 }, (_, index) => "phase_only_" + (index + 1)),
      );
    } finally {
      embeddingSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
  test("fails closed before provider dispatch when a Response source row is missing", async () => {
    const fixture = await createFixture("response_loom");
    try {
      await expect(
        assemblePrompt({
          userId: fixture.userId,
          userName: fixture.userName,
          generationId: crypto.randomUUID(),
          dryRun: true,
          chatId: fixture.chat.id,
          assemblySurface: "RESPONSE",
          presetId: fixture.preset.id,
          forcePresetId: true,
          generationType: "normal",
          sourceUserMessageIds: ["missing-source-user-row"],
        }),
      ).rejects.toThrow(
        "The persisted user turn changed before Response prompt assembly",
      );
      expect(fixture.provider.rootRequests).toHaveLength(0);
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  });
  test("omits phase-only Loom instructions while retaining ordinary Response context", async () => {
    const fixture = await createFixture("response_phase_loom");
    try {
      const phaseSource = {
        kind: "loom_block",
        blockId: "phase-policy",
        presetRevision: fixture.preset.cache_revision ?? 1,
        blockRevision: 1,
        promptOrder: fixture.preset.prompt_order.findIndex(
          (block) => block?.id === "phase-policy",
        ),
      };
      const dryRun = await dryRunGeneration({
        userId: fixture.userId,
        userName: fixture.userName,
        chat_id: fixture.chat.id,
        connection_id: fixture.connection.id,
        preset_id: fixture.preset.id,
        force_preset_id: true,
        generation_type: "normal",
      });
      expect(dryRun.assemblySurface).toBe("RESPONSE");
      expect(dryRun.loomPromptInspection).toMatchObject({
        version: 1,
        surface: "RESPONSE",
        checkpoint: "ASSEMBLE",
        items: [],
        effectiveEntryIds: [],
        responseOmission: {
          version: 1,
          surface: "RESPONSE",
          visibility: "work_only",
          reason: "work_only",
          omittedEntryIds: [],
          source: [],
          omittedPhaseInstructions: Array.from({ length: 6 }, (_, index) => ({
            phaseId: `phase_only_${index + 1}`,
            source: phaseSource,
          })),
        },
      });

      const started = await startFixture(fixture);
      const emittedBreakdownPromise = waitForGenerationEvent(
        EventType.GENERATION_BREAKDOWN_READY,
        started.generationId,
      );
      const terminal = await waitForGenerationTerminal(started.generationId);
      const emittedBreakdown = await emittedBreakdownPromise;
      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(emittedBreakdown.breakdown).toMatchObject({
        assemblySurface: "RESPONSE",
        loomPromptInspection: {
          surface: "RESPONSE",
          items: [],
          effectiveEntryIds: [],
          responseOmission: {
            surface: "RESPONSE",
            visibility: "work_only",
            reason: "work_only",
            omittedEntryIds: [],
            source: [],
            omittedPhaseInstructions: Array.from({ length: 6 }, (_, index) => ({
              phaseId: `phase_only_${index + 1}`,
              source: phaseSource,
            })),
          },
        },
      });

      const requestText = fixture.provider.rootRequests[0]?.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n") ?? "";
      expect(requestText).toContain("Answer Usage Owner.");
      expect(requestText).toContain(
        "World context for Usage Owner: blue lantern.",
      );
      expect(requestText).not.toContain("Internal phase-only policy.");
      expect(requestText.match(/Delegate this\./g)).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  function getPersistedActivity(generationId: string): Record<string, any> {
    const row = getDb().query(
      "SELECT snapshot_json FROM agent_activity_runs WHERE generation_id = ?",
    ).get(generationId) as { snapshot_json: string } | null;
    if (!row) throw new Error("Expected a persisted activity run");
    const retained = JSON.parse(row.snapshot_json) as {
      snapshot?: Record<string, any>;
    };
    if (!retained.snapshot) throw new Error("Expected a retained snapshot");
    return retained.snapshot;
  }

  function hasPersistedActivity(generationId: string): boolean {
    return getDb().query(
      "SELECT 1 FROM agent_activity_runs WHERE generation_id = ?",
    ).get(generationId) !== null;
  }

  async function cleanupFixture(chatId: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < 100 && getActiveGenerationCount() > 0;
      attempt += 1
    ) {
      await Bun.sleep(1);
    }
    await chatsSvc.waitForChatChunkMaintenance(chatId);
    for (
      let attempt = 0;
      attempt < 1_000 && getChatPipelineStatus(chatId)?.running;
      attempt += 1
    ) {
      await Bun.sleep(1);
    }
    await chatsSvc.waitForChatChunkMaintenance(chatId);
    if (previousPromptAssemblyWorker === undefined) {
      delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
    } else {
      process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER =
        previousPromptAssemblyWorker;
    }
    pool.clearAllPoolEntries();
    closeDatabase();
  }

  test("keeps feature-inactive success free of agent terminal artifacts", async () => {
    const fixture = await createFixture("inactive_success");
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.error).toBeUndefined();
      expect(terminal.payload).not.toHaveProperty("agentActivity");
      expect(terminal.payload).not.toHaveProperty("agentError");
      expect(hasPersistedActivity(started.generationId)).toBe(false);
      expect(fixture.provider.streamClosed).toBe(true);
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("completed");
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("keeps feature-inactive failures on the ordinary error path", async () => {
    const fixture = await createFixture("inactive_failure");
    installResponseSettlementScript(
      fixture.userId,
      "partial",
      "durable transformed partial",
    );
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.error).toEqual(
        expect.stringContaining("Provider stream failed after usage"),
      );
      const message = chatsSvc.getLastAssistantMessage(
        fixture.userId,
        fixture.chat.id,
      );
      expect(terminal.payload.content).toBe("partial");
      expect(message?.content).toBe("durable transformed partial");
      expect(pool.getPoolEntry(started.generationId)?.content).toBe("partial");
      expect(terminal.payload).not.toHaveProperty("agentActivity");
      expect(terminal.payload).not.toHaveProperty("agentError");
      expect(hasPersistedActivity(started.generationId)).toBe(false);
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("error");
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("counts absent and under-reported usage across native root rounds", async () => {
    const fixture = await createFixture("sparse_usage");
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.error).toBeUndefined();
      expect(fixture.provider.rootRequests).toHaveLength(2);
      const message = chatsSvc.getMessage(
        fixture.userId,
        terminal.payload.messageId,
      );
      const persisted = getPersistedActivity(started.generationId);
      const rootRounds = (persisted.nodes as Array<Record<string, any>>)
        .filter((node) =>
          node.kind === "provider_round" &&
          node.parentId === started.generationId &&
          node.phase === "completed"
        );
      expect(rootRounds).toHaveLength(2);
      expect(rootRounds.map((node) => node.usage.outputTokens))
        .toEqual([expect.any(Number), expect.any(Number)]);
      expect(rootRounds.every((node) => node.usage.outputTokens > 0)).toBe(true);
      expect(message?.extra?.usage.completion_tokens).toBeGreaterThan(5);
      expect(persisted.usage).toMatchObject({
        inputTokens: message?.extra?.usage.prompt_tokens,
        outputTokens: message?.extra?.usage.completion_tokens,
        totalTokens: message?.extra?.usage.total_tokens,
        toolCalls: 1,
        childInvocations: 1,
      });
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
  test("retains an exact root admission failure before owner attachment", async () => {
    const fixture = await createFixture("finalization");
    const heldPermits = [];
    try {
      expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsProcess).toBe(0);
      const limits = AGENT_RUNTIME_ADMISSION_MANAGER.limits;
      const heldCount = Math.min(
        limits.activeRootsPerUser,
        limits.activeRootsProcess,
      );
      for (let index = 0; index < heldCount; index += 1) {
        heldPermits.push(
          AGENT_RUNTIME_ADMISSION_MANAGER.acquireRoot(fixture.userId),
        );
      }

      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);
      const expectedBudgetId =
        limits.activeRootsPerUser <= limits.activeRootsProcess
          ? "active_roots_per_user"
          : "active_roots_process";
      const expectedLimit =
        expectedBudgetId === "active_roots_per_user"
          ? limits.activeRootsPerUser
          : limits.activeRootsProcess;

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.agentError).toEqual({
        version: 1,
        code: "capacity_exceeded",
        category: "capacity",
        budget: {
          id: expectedBudgetId,
          limit: expectedLimit,
          observed: expectedLimit,
        },
        retryable: false,
      });
      expect(terminal.payload.agentActivity).toMatchObject({
        status: "failed",
        terminalErrorCode: "capacity_exceeded",
        errorCounts: { capacity_exceeded: 1 },
      });
      expect(fixture.provider.rootRequests).toHaveLength(0);
      expect(fixture.provider.childRequests).toHaveLength(0);
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("error");
      expect(getPersistedActivity(started.generationId)).toMatchObject({
        status: "failed",
        terminalErrorCode: "capacity_exceeded",
        errorCounts: { capacity_exceeded: 1 },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolCalls: 0,
          childInvocations: 0,
        },
      });
    } finally {
      for (const permit of heldPermits) permit.release();
      expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsProcess).toBe(0);
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);


  test("persists finalization, child, and root usage exactly once", async () => {
    const fixture = await createFixture("finalization");
    try {
      const started = await startFixture(fixture);
      const terminalReady = waitForGenerationTerminal(started.generationId);
      const metricsReady = waitForGenerationEvent(
        EventType.GENERATION_METRICS_READY,
        started.generationId,
      );
      const breakdownReady = waitForGenerationEvent(
        EventType.GENERATION_BREAKDOWN_READY,
        started.generationId,
      );
      const [terminal, metrics, breakdownEvent] = await Promise.all([
        terminalReady,
        metricsReady,
        breakdownReady,
      ]);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.error).toBeUndefined();
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("completed");
      expect(fixture.provider.rootRequests).toHaveLength(2);
      expect(fixture.provider.childRequests).toHaveLength(1);
      expect(fixture.provider.rootRequests.map((request) => request.toolMode))
        .toEqual(["ordinary", "finalization"]);
      expect(fixture.provider.rootRequests[1]?.tools).toEqual([]);

      const messageId = terminal.payload.messageId;
      expect(metrics.messageId).toBe(messageId);
      expect(breakdownEvent.messageId).toBe(messageId);
      const message = chatsSvc.getMessage(fixture.userId, messageId);
      const usage = message?.extra?.usage;
      if (!usage) throw new Error("Expected persisted generation usage");
      expect(usage.prompt_tokens).toBe(28);
      expect(usage.completion_tokens).toBeGreaterThanOrEqual(10);
      expect(usage.total_tokens).toBe(
        usage.prompt_tokens + usage.completion_tokens,
      );
      expect(
        breakdownSvc.getBreakdown(fixture.userId, messageId)?.usage,
      ).toEqual(usage);
      expect(getPersistedActivity(started.generationId)).toMatchObject({
        status: "completed",
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          toolCalls: 1,
          childInvocations: 1,
        },
      });
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("persists reconciled usage once when the provider fails mid-stream", async () => {
    const fixture = await createFixture("provider_failure");
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.agentError).toMatchObject({
        code: "provider_protocol_error",
        category: "provider",
      });
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("error");
      expect(fixture.provider.rootRequests).toHaveLength(1);
      expect(fixture.provider.childRequests).toHaveLength(0);
      const message = chatsSvc.getLastAssistantMessage(
        fixture.userId,
        fixture.chat.id,
      );
      expect(message?.content).toBe("partial");
      expect(message?.extra?.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 7,
        total_tokens: 17,
      });
      expect(getPersistedActivity(started.generationId)).toMatchObject({
        status: "failed",
        terminalErrorCode: "provider_protocol_error",
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          totalTokens: 17,
          toolCalls: 0,
          childInvocations: 0,
        },
      });
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("rejects aggregate overflow without publishing imprecise activity usage", async () => {
    const fixture = await createFixture("root_overflow");
    try {
      const started = await startFixture(fixture);
      const terminal = await waitForGenerationTerminal(started.generationId);
      const message = chatsSvc.getLastAssistantMessage(
        fixture.userId,
        fixture.chat.id,
      );
      const usage = message?.extra?.usage;
      if (!usage) throw new Error("Expected bounded persisted usage");

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.agentError).toMatchObject({
        code: "provider_protocol_error",
        category: "provider",
      });
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("error");
      expect(fixture.provider.rootRequests).toHaveLength(2);
      expect(fixture.provider.childRequests).toHaveLength(1);
      expect(message?.content).toBe("done");
      expect(Number.isSafeInteger(usage.prompt_tokens)).toBe(true);
      expect(Number.isSafeInteger(usage.completion_tokens)).toBe(true);
      expect(Number.isSafeInteger(usage.total_tokens)).toBe(true);
      expect(usage.total_tokens).toBe(
        usage.prompt_tokens + usage.completion_tokens,
      );
      expect(usage.total_tokens).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      expect(getPersistedActivity(started.generationId)).toMatchObject({
        status: "failed",
        terminalErrorCode: "provider_protocol_error",
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          toolCalls: 1,
          childInvocations: 1,
        },
      });
    } finally {
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("adopts an already-won ledger terminal during a stop race", async () => {
    const fixture = await createFixture("finalization");
    const originalInvoke = AgentRuntimeOwner.prototype.invoke;
    const {
      promise: invokeEntered,
      resolve: markInvokeEntered,
    } = Promise.withResolvers<AgentRuntimeOwner>();
    const {
      promise: invokeGate,
      resolve: releaseInvoke,
    } = Promise.withResolvers<void>();
    let intercepted = false;
    const invokeSpy = spyOn(
      AgentRuntimeOwner.prototype,
      "invoke",
    ).mockImplementation(async function (
      this: AgentRuntimeOwner,
      request: Parameters<AgentRuntimeOwner["invoke"]>[0],
    ) {
      if (!intercepted) {
        intercepted = true;
        markInvokeEntered(this);
        await invokeGate;
      }
      return originalInvoke.call(this, request);
    });

    try {
      const started = await startFixture(fixture);
      const terminalReady = waitForGenerationTerminal(started.generationId);
      const owner = await invokeEntered;

      expect(
        owner.ledger.tryTerminate("root_wall_clock_limit_exceeded"),
      ).toBe(true);
      expect(await stopGeneration(fixture.userId, started.generationId)).toBe(true);
      releaseInvoke();

      const terminal = await terminalReady;
      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.agentError).toMatchObject({
        code: "root_wall_clock_limit_exceeded",
        category: "budget",
      });
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("error");
    } finally {
      releaseInvoke();
      invokeSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("projects an inactive stale watchdog while post-processing is blocked", async () => {
    const fixture = await createFixture("inactive_success");
    const originalReconcile = chatMacroRenderSvc.reconcileChatMessageMacros;
    const {
      promise: reconcileGate,
      resolve: releaseReconcile,
    } = Promise.withResolvers<void>();
    const {
      promise: reconcileEntered,
      resolve: markReconcileEntered,
    } = Promise.withResolvers<void>();
    let intercepted = false;
    const reconcileSpy = spyOn(
      chatMacroRenderSvc,
      "reconcileChatMessageMacros",
    ).mockImplementation(
      async (...args: Parameters<typeof originalReconcile>) => {
        if (!intercepted) {
          intercepted = true;
          markReconcileEntered();
          await reconcileGate;
        }
        return originalReconcile(...args);
      },
    );

    try {
      const started = await startFixture(fixture);
      const terminalReady = waitForGenerationTerminal(started.generationId);
      await reconcileEntered;
      const entry = pool.getPoolEntry(started.generationId);
      if (!entry) throw new Error("Expected an active pool entry");
      entry.lastActivityAt = 0;

      pool.sweepPoolNow();
      const terminal = await Promise.race([
        terminalReady,
        Bun.sleep(250).then(() => {
          throw new Error("Watchdog terminal projection remained deferred");
        }),
      ]);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.error).toBe(
        "Generation timed out: no activity for 60 minutes",
      );
      expect(terminal.payload).not.toHaveProperty("agentActivity");
      expect(terminal.payload).not.toHaveProperty("agentError");
      expect(entry.status).toBe("error");
      expect(entry.error).toBe(
        "Generation timed out: no activity for 60 minutes",
      );
    } finally {
      releaseReconcile();
      reconcileSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("projects an active watchdog before blocked iterator teardown settles", async () => {
    const fixture = await createFixture("stuck_teardown");
    try {
      const started = await startFixture(fixture);
      const terminalReady = waitForGenerationTerminal(started.generationId);
      await fixture.provider.blockedPullEntered.promise;
      const entry = pool.getPoolEntry(started.generationId);
      if (!entry) throw new Error("Expected an active pool entry");
      entry.lastActivityAt = 0;

      pool.sweepPoolNow();
      const terminal = await Promise.race([
        terminalReady,
        Bun.sleep(500).then(() => {
          throw new Error("Iterator teardown blocked terminal projection");
        }),
      ]);

      expect(terminal.event).toBe(EventType.GENERATION_ENDED);
      expect(terminal.payload.agentError).toMatchObject({ code: "timeout" });
      expect(entry.status).toBe("error");
    } finally {
      fixture.provider.blockedPull.resolve();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);

  test("projects a stop that wins during completed-response post-processing", async () => {
    const fixture = await createFixture("finalization");
    installResponseSettlementScript(fixture.userId, "done", "durable stopped");
    const originalReconcile = chatMacroRenderSvc.reconcileChatMessageMacros;
    const {
      promise: reconcileGate,
      resolve: releaseReconcile,
    } = Promise.withResolvers<void>();
    const {
      promise: reconcileEntered,
      resolve: markReconcileEntered,
    } = Promise.withResolvers<void>();
    let intercepted = false;
    const reconcileSpy = spyOn(
      chatMacroRenderSvc,
      "reconcileChatMessageMacros",
    ).mockImplementation(
      async (...args: Parameters<typeof originalReconcile>) => {
        if (!intercepted) {
          intercepted = true;
          markReconcileEntered();
          await reconcileGate;
        }
        return originalReconcile(...args);
      },
    );

    try {
      const started = await startFixture(fixture);
      const terminalReady = waitForGenerationTerminal(started.generationId);
      const metricsReady = waitForGenerationEvent(
        EventType.GENERATION_METRICS_READY,
        started.generationId,
      );
      let endedEvents = 0;
      const unsubscribeEnded = eventBus.on(
        EventType.GENERATION_ENDED,
        (event) => {
          if (event.payload?.generationId === started.generationId) {
            endedEvents += 1;
          }
        },
      );

      await reconcileEntered;
      expect(await stopGeneration(fixture.userId, started.generationId)).toBe(true);
      releaseReconcile();
      const terminal = await terminalReady;
      await metricsReady;
      await Bun.sleep(0);
      unsubscribeEnded();

      expect(terminal.event).toBe(EventType.GENERATION_STOPPED);
      expect(terminal.payload.content).toBe("done");
      expect(terminal.payload.agentError).toMatchObject({
        code: "cancelled",
        category: "cancelled",
      });
      expect(endedEvents).toBe(0);
      expect(pool.getPoolEntry(started.generationId)?.status).toBe("stopped");
      expect(fixture.provider.rootRequests.map((request) => request.toolMode))
        .toEqual(["ordinary", "finalization"]);
      const message = chatsSvc.getLastAssistantMessage(
        fixture.userId,
        fixture.chat.id,
      );
      const usage = message?.extra?.usage;
      expect(message?.content).toBe("durable stopped");
      if (!usage) throw new Error("Expected persisted generation usage");
      expect(usage.prompt_tokens).toBe(28);
      expect(usage.completion_tokens).toBeGreaterThanOrEqual(10);
      expect(usage.total_tokens).toBe(
        usage.prompt_tokens + usage.completion_tokens,
      );
      expect(getPersistedActivity(started.generationId)).toMatchObject({
        status: "cancelled",
        terminalErrorCode: "cancelled",
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        },
      });
    } finally {
      releaseReconcile();
      reconcileSpy.mockRestore();
      await cleanupFixture(fixture.chat.id);
    }
  }, 15_000);
});

const ADMISSION_USER_ID = TEST_OWNER_ID;
const ADMISSION_PRESET_ID = "runtime-token-preset";

class RuntimeAdmissionProvider implements LlmProvider {
  readonly name = "authority-provider";
  readonly displayName = "Runtime admission provider";
  readonly defaultUrl = "https://authority.invalid/v1";
  readonly capabilities: ProviderCapabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none",
    toolCalling: false,
    requiredToolChoice: false,
    nativeToolContinuation: false,
    toolContinuationMode: "unsupported",
    toolsDisabledFinalization: false,
    supportsToolFinalization: false,
  };
  dispatchCount = 0;

  async generate(
    _apiKey: string,
    _apiUrl: string,
    _request: GenerationRequest,
  ): Promise<GenerationResponse> {
    this.dispatchCount += 1;
    throw new Error("Runtime decision dry run dispatched the provider");
  }

  async *generateStream(
    _apiKey: string,
    _apiUrl: string,
    _request: GenerationRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.dispatchCount += 1;
    throw new Error("Runtime decision dry run dispatched the provider");
  }

  async validateKey(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<string[]> {
    return ["authority-model"];
  }
}

const ADMISSION_INPUT_REVISIONS: InputRevisionSetV1 = {
  target: 1, chat: 2, message: 3, preset: 4, block: 5, config: 6,
  binding: 7, connection: 8, endpoint: 9, credential: 10, persona: 11,
  character: 12, group: 13, world: 14, lore: 15, settings: 16, macro: 17,
  regex: 18, cognition: 19, readiness: 20,
};

function admissionReadiness(): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: 1, runtimeEpoch: 1, reconciliationEpoch: 1, archiveRegistryVersion: 1,
    isolateHealthEpoch: 1, publicationStoreHealthEpoch: 1, providerCapabilityRevision: 1,
    configRevision: 1, bindingRevision: 1, concreteConnectionRevision: 1, targetRevision: 1,
    inputRevisionDigest: "runtime-token-snapshot", cognitionRevision: 1,
    killSwitchState: "auto", ready: true, reasons: [],
  };
}

function mapAdmissionDecision(decision: EffectiveRuntimeDecisionV1): AgenticRuntimeDecision {
  const root = decision.internal.rootConnection;
  return {
    mode: decision.effectiveMode,
    presetId: decision.internal.binding.presetId ?? undefined,
    configRevision: decision.internal.binding.configRevision ?? undefined,
    bindingRevision: decision.internal.binding.bindingRevision ?? undefined,
    readinessDigest: decision.internal.binding.readinessDigest,
    connection: root ? {
      logicalId: root.logicalId ?? undefined,
      concreteId: root.concreteId ?? undefined,
      provider: root.provider ?? undefined,
      model: root.model ?? undefined,
      endpoint: root.effectiveEndpoint ?? undefined,
      candidateRevision: root.candidateRevision ?? undefined,
      endpointRevision: root.endpointRevision ?? undefined,
      credentialRevision: root.credentialRevision ?? undefined,
      capabilities: root.capabilities,
      fingerprint: root.fingerprint ?? undefined,
    } : undefined,
    internal: decision.internal,
  };
}

async function createRuntimeAdmissionHarness(ttlMs = 60_000) {
  await chatsSvc.waitForChatChunkMaintenance();
  pool.clearAllPoolEntries();
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query('INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)')
    .run(ADMISSION_USER_ID, "Runtime Token Owner", "runtime-token@example.test");
  const provider = new RuntimeAdmissionProvider();
  registerProvider(provider);
  const responseConnection = await connectionsSvc.createConnection(ADMISSION_USER_ID, {
    name: "Runtime admission connection",
    provider: provider.name,
    model: "authority-model",
    is_default: true,
  });
  const chat = chatsSvc.createChat(ADMISSION_USER_ID, {
    character_id: null,
    name: "Runtime token admission",
    metadata: { temporary: true, no_preset: true },
  });
  insertFixtureMessage(ADMISSION_USER_ID, chat.id, {
    is_user: true, name: "User", content: "Use the reviewed runtime.",
  });

  let now = 1_000;
  let configRevision = 1;
  let bindingRevision = 1;
  let inputRevisions = { ...ADMISSION_INPUT_REVISIONS };
  let readiness = admissionReadiness();
  const connection: FrozenConcreteConnectionV1 = {
    logicalId: responseConnection.id, concreteId: responseConnection.id,
    label: "Reviewed root", provider: provider.name, model: "authority-model",
    effectiveEndpoint: "https://authority.invalid/v1", endpointRevision: "endpoint-1",
    credentialSecretRef: "secret-1", credentialRevision: "credential-1",
    candidateRevision: "candidate-1", revision: "connection-1",
    fingerprint: "authority-domain", capabilityDigest: "authority-capabilities",
    capabilities: {
      streaming: true, toolCalling: true, toolsDisabledFinalization: true,
      nativeToolContinuation: true, toolContinuationMode: "native",
    },
  };
  const agentConfig = {
    version: 2 as const, agentsEnabled: true, allowedModes: ["response", "agentic"] as const,
    defaultMode: "agentic" as const, maxInvocations: 8, maxToolCalls: 8,
    mainToolIds: [] as string[], mainLoreScope: "active" as const,
    profiles: [], connectionSlots: [],
  };
  const decisionDependencies: Partial<RuntimeDecisionDependencies> = {
    getChat: (userId, chatId) => userId === ADMISSION_USER_ID && chatId === chat.id
      ? { id: chat.id, character_id: null, metadata: { temporary: true } } : null,
    getPreset: (userId, presetId) => userId === ADMISSION_USER_ID && presetId === ADMISSION_PRESET_ID
      ? { id: ADMISSION_PRESET_ID, name: "Runtime token preset", cache_revision: 1 } : null,
    getPresetAgentConfig: (userId, presetId) => userId === ADMISSION_USER_ID && presetId === ADMISSION_PRESET_ID
      ? {
          config: agentConfig,
          review: { state: "ready", reasonCode: null, unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false },
          configRevision, bindingRevision, bindings: [],
        } : null,
    resolveProfile: () => ({ preset_id: ADMISSION_PRESET_ID, source: "chat" }),
    resolvePersona: () => null,
    resolveConcreteConnection: async (userId, logicalId) =>
      userId === ADMISSION_USER_ID && logicalId === responseConnection.id ? connection : null,
    getChatAgentModeOverride: () => null,
    setChatAgentModeOverride: (_userId, chatId, mode) => ({ chatId, mode, revision: 1, state: "ready" }),
    getInputRevisions: () => ({ ...inputRevisions }),
    getReadinessVector: () => ({ ...readiness, reasons: [...readiness.reasons] }),
  };
  const service = new AgentRuntimeDecisionService({
    now: () => now,
    tokenStore: new RuntimeDecisionTokenStore(() => now, { ttlMs }),
    dependencies: decisionDependencies,
  });
  const dispatches: Array<{ provider?: string; model?: string }> = [];

  const requestFor = (
    input: AgenticGenerationInput,
    target: AgenticTargetSnapshot,
    transientMode?: "agentic",
  ): EffectiveRuntimeRequestV1 => ({
    chatId: input.chatId, logicalConnectionId: input.connectionId ?? null,
    presetId: input.presetId ?? null, forcePresetId: input.forcePresetId === true,
    personaId: input.personaId ?? null, targetCharacterId: input.targetCharacterId ?? null,
    generationType: target.generationType,
    target: {
      generationType: target.generationType, messageId: target.messageId ?? null,
      swipeId: target.swipeId ?? null,
      targetCharacterId: target.targetCharacterId ?? input.targetCharacterId ?? null,
      ...(target.revision === undefined ? {} : { revision: target.revision }),
    },
    ...(transientMode
      ? {
        transientSelection: {
          mode: transientMode,
          turnFence: input.requestEpoch ?? 0,
          authenticated: true as const,
        },
      }
      : {}),
    requestEpoch: input.requestEpoch ?? 0,
  });
  const rejectRefresh = (): never => {
    throw new AgenticGenerationError("decision_refresh_required", "decision_refresh_required", {
      phase: "ASSEMBLE", retryable: true,
    });
  };
  const dependencies: AgenticGenerationDependencies = {
    resolveRuntime: async (input, target) => mapAdmissionDecision(
      await service.resolve(input.userId, requestFor(input, target, "agentic"), { issueToken: false }),
    ),
    claimRuntimeToken: (input, token) => {
      if (!service.claim(input.userId, token)) rejectRefresh();
    },
    consumeRuntimeToken: async (input, target, token) => {
      const consumed = await service.consume(input.userId, token, requestFor(input, target));
      return consumed.accepted && consumed.decision ? mapAdmissionDecision(consumed.decision) : rejectRefresh();
    },
    assemble: async () => ({ snapshot: {} as never, plan: {} as never }),
    runWork: async ({ decision }) => {
      dispatches.push({ provider: decision.connection?.provider, model: decision.connection?.model });
      return { status: "completed", summary: "dispatched" };
    },
    render: async () => ({ content: "rendered" }),
    prepareRender: async () => ({ content: "rendered" }),
    commit: async () => ({ receiptId: crypto.randomUUID() }),
  };
  configureAgenticGenerationDependencies(dependencies);

  const generationInput = (requestEpoch: number, token?: string) => ({
    userId: ADMISSION_USER_ID, chat_id: chat.id, connection_id: responseConnection.id,
    preset_id: ADMISSION_PRESET_ID, generation_type: "normal" as const, mode: "agentic" as const,
    request_epoch: requestEpoch, user_input: "Use the reviewed runtime.",
    provider: "caller-untrusted-provider",
    ...(token === undefined ? {} : { runtime_decision_token: token }),
  });
  const issue = (requestEpoch: number) => service.resolve(
    ADMISSION_USER_ID,
    requestFor({
      userId: ADMISSION_USER_ID, chatId: chat.id, connectionId: responseConnection.id,
      presetId: ADMISSION_PRESET_ID, generationType: "normal", requestEpoch,
    }, { generationType: "normal" }, "agentic"),
  );
  const issueDurable = (requestEpoch: number) => service.resolve(
    ADMISSION_USER_ID,
    requestFor({
      userId: ADMISSION_USER_ID, chatId: chat.id, connectionId: responseConnection.id,
      presetId: ADMISSION_PRESET_ID, generationType: "normal", requestEpoch,
    }, { generationType: "normal" }),
  );
  return {
    service, dispatches, provider, generationInput, issue, issueDurable, requestFor, chatId: chat.id,
    advance: (milliseconds: number) => { now += milliseconds; },
    bumpConfig: () => {
      configRevision += 1;
      inputRevisions = { ...inputRevisions, config: Number(inputRevisions.config) + 1 };
    },
    resetConfig: () => {
      configRevision = 1;
      inputRevisions = { ...ADMISSION_INPUT_REVISIONS };
    },
    bumpReadiness: () => { readiness = { ...readiness, runtimeEpoch: Number(readiness.runtimeEpoch) + 1 }; },
  };
}

function forbidReplacementResolution() {
  return spyOn(runtimeDecisionSvc, "resolveEffectiveRuntime").mockImplementation(async () => {
    throw new Error("caller token attempted replacement resolution");
  });
}

describe.serial("startGeneration caller runtime decision authority", () => {
  afterAll(async () => {
    await chatsSvc.waitForChatChunkMaintenance();
    pool.clearAllPoolEntries();
    closeDatabase();
  });

test("consumes durable preset Agentic authority without making it turn-scoped", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const issued = await harness.issueDurable(1);
  expect(issued.runtimePolicy).toMatchObject({
    authoredValue: "agentic",
    effectiveValue: "agentic",
    source: "reviewed_preset_default",
    scope: "preset",
    transientSelection: null,
  });
  const resolveSpy = forbidReplacementResolution();
  try {
    const started = await startGeneration(harness.generationInput(1, issued.runtimeDecisionToken!));
    expect(resolveSpy).not.toHaveBeenCalled();
    await waitForAgenticGeneration(started.generationId);
    expect(harness.dispatches).toEqual([{ provider: "authority-provider", model: "authority-model" }]);
  } finally {
    resolveSpy.mockRestore();
  }
});
test("consumes the exact token, freezes provider/model, and rejects replay", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const issued = await harness.issue(1);
  const token = issued.runtimeDecisionToken!;
  const resolveSpy = forbidReplacementResolution();
  try {
    const started = await startGeneration(harness.generationInput(1, token));
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(harness.service.tokenStore.liveCount).toBe(0);
    await waitForAgenticGeneration(started.generationId);
    expect(harness.dispatches).toEqual([{ provider: "authority-provider", model: "authority-model" }]);
    await expect(startGeneration(harness.generationInput(1, token))).rejects.toMatchObject({
      code: "decision_refresh_required",
    });
    expect(harness.dispatches).toHaveLength(1);
  } finally {
    resolveSpy.mockRestore();
  }
});

test("rejects expiry before dispatch", async () => {
  const harness = await createRuntimeAdmissionHarness(1);
  const token = (await harness.issue(2)).runtimeDecisionToken!;
  harness.advance(2);
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(startGeneration(harness.generationInput(2, token))).rejects.toMatchObject({
      code: "decision_refresh_required",
    });
    expect(harness.dispatches).toHaveLength(0);
    expect(resolveSpy).not.toHaveBeenCalled();
  } finally {
    resolveSpy.mockRestore();
  }
});

test("rejects stale revisions and readiness before dispatch", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const revisionToken = (await harness.issue(3)).runtimeDecisionToken!;
  harness.bumpConfig();
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(startGeneration(harness.generationInput(3, revisionToken))).rejects.toMatchObject({
      code: "decision_refresh_required",
    });
    harness.resetConfig();
    const readinessToken = (await harness.issue(4)).runtimeDecisionToken!;
    harness.bumpReadiness();
    await expect(startGeneration(harness.generationInput(4, readinessToken))).rejects.toMatchObject({
      code: "decision_refresh_required",
    });
    expect(harness.dispatches).toHaveLength(0);
  } finally {
    resolveSpy.mockRestore();
  }
});

test("consumes request-mismatched and cross-user tokens", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const mismatchToken = (await harness.issue(5)).runtimeDecisionToken!;
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(startGeneration(harness.generationInput(6, mismatchToken))).rejects.toMatchObject({ code: "decision_refresh_required" });
    await expect(startGeneration(harness.generationInput(5, mismatchToken))).rejects.toMatchObject({ code: "decision_refresh_required" });
    const crossUserToken = (await harness.issue(7)).runtimeDecisionToken!;
    await expect(startGeneration({
      ...harness.generationInput(7, crossUserToken), userId: "runtime-token-attacker",
    })).rejects.toMatchObject({ code: "decision_refresh_required" });
    await expect(startGeneration(harness.generationInput(7, crossUserToken))).rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(harness.dispatches).toHaveLength(0);
  } finally {
    resolveSpy.mockRestore();
  }
});

test("consumes supplied authority before requested-generation idempotency", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const token = (await harness.issue(8)).runtimeDecisionToken!;
  const generationId = "existing-runtime-token-generation";
  pool.createPoolEntry({
    generationId, userId: ADMISSION_USER_ID, chatId: harness.chatId,
    generationType: "normal", characterName: "", model: "",
  });
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(startGeneration({
      ...harness.generationInput(8, token), generationId,
    })).resolves.toEqual({ generationId, status: "streaming" });
    expect(harness.service.tokenStore.liveCount).toBe(0);
    expect(harness.dispatches).toHaveLength(0);
    await expect(startGeneration({
      ...harness.generationInput(8, token), generationId,
    })).rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(resolveSpy).not.toHaveBeenCalled();
  } finally {
    resolveSpy.mockRestore();
    pool.removePoolEntry(generationId);
  }
});

test("rejects explicit Response mode and burns the supplied Agentic token", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const token = (await harness.issue(9)).runtimeDecisionToken!;
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(startGeneration({
      ...harness.generationInput(9, token), mode: "response" as const,
    })).rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(harness.service.tokenStore.liveCount).toBe(0);
    expect(harness.dispatches).toHaveLength(0);
    await expect(startGeneration(harness.generationInput(9, token)))
      .rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(resolveSpy).not.toHaveBeenCalled();
  } finally {
    resolveSpy.mockRestore();
  }
});

test("dry-run runtime decision burns a valid token before rejecting Agentic mode", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const token = (await harness.issue(20)).runtimeDecisionToken!;
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(dryRunGeneration(harness.generationInput(20, token)))
      .rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    expect(harness.service.tokenStore.liveCount).toBe(0);
    expect(harness.dispatches).toHaveLength(0);
    expect(harness.provider.dispatchCount).toBe(0);

    await expect(startGeneration(harness.generationInput(20, token)))
      .rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(harness.dispatches).toHaveLength(0);
    expect(harness.provider.dispatchCount).toBe(0);
  } finally {
    resolveSpy.mockRestore();
  }
});

test("dry-run runtime decision consumes tokens before successful Response and omitted-mode assembly", async () => {
  for (const [requestEpoch, mode] of [[21, "response"], [22, undefined]] as const) {
    const harness = await createRuntimeAdmissionHarness();
    const token = (await harness.issue(requestEpoch)).runtimeDecisionToken!;
    const resolveSpy = forbidReplacementResolution();
    const request = (): Parameters<typeof dryRunGeneration>[0] => {
      const input: Parameters<typeof dryRunGeneration>[0] = {
        ...harness.generationInput(requestEpoch, token),
      };
      if (mode === undefined) delete input.mode;
      else input.mode = mode;
      return input;
    };
    try {
      const result = await dryRunGeneration(request());
      expect(result.assemblySurface).toBe("RESPONSE");
      expect(harness.service.tokenStore.liveCount).toBe(0);
      expect(harness.dispatches).toHaveLength(0);
      expect(harness.provider.dispatchCount).toBe(0);

      await expect(startGeneration(harness.generationInput(requestEpoch, token)))
        .rejects.toMatchObject({ code: "decision_refresh_required" });
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(harness.dispatches).toHaveLength(0);
      expect(harness.provider.dispatchCount).toBe(0);
    } finally {
      resolveSpy.mockRestore();
    }
  }
});

test("dry-run runtime decision preserves owner checks while burning cross-user attempts", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const token = (await harness.issue(23)).runtimeDecisionToken!;
  const resolveSpy = forbidReplacementResolution();
  try {
    await expect(dryRunGeneration({
      ...harness.generationInput(23, token),
      userId: "runtime-token-attacker",
      userName: "Runtime Token Attacker",
      mode: "response",
    })).rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(harness.service.tokenStore.getLiveCountForUser(ADMISSION_USER_ID)).toBe(0);

    await expect(startGeneration(harness.generationInput(23, token)))
      .rejects.toMatchObject({ code: "decision_refresh_required" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(harness.dispatches).toHaveLength(0);
    expect(harness.provider.dispatchCount).toBe(0);
  } finally {
    resolveSpy.mockRestore();
  }
});

test("burns valid tokens on unsupported surfaces with omitted and explicit Response mode", async () => {
  for (const [requestEpoch, mode] of [[10, undefined], [11, "response"]] as const) {
    const harness = await createRuntimeAdmissionHarness();
    const token = (await harness.issue(requestEpoch)).runtimeDecisionToken!;
    const resolveSpy = forbidReplacementResolution();
    try {
      const unsupported: Parameters<typeof startGeneration>[0] = {
        ...harness.generationInput(requestEpoch, token),
        generation_type: "impersonate",
      };
      if (mode === undefined) delete unsupported.mode;
      else unsupported.mode = mode;

      await expect(startGeneration(unsupported)).rejects.toMatchObject({
        code: "agentic_unsupported_surface",
      });
      expect(harness.service.tokenStore.liveCount).toBe(0);
      expect(harness.dispatches).toHaveLength(0);
      expect(getActiveGenerationCount()).toBe(0);

      await expect(startGeneration(harness.generationInput(requestEpoch, token)))
        .rejects.toMatchObject({ code: "decision_refresh_required" });
      expect(harness.dispatches).toHaveLength(0);
      expect(getActiveGenerationCount()).toBe(0);
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
    }
  }
});

test("allows only a tokenless direct caller to resolve internally", async () => {
  const harness = await createRuntimeAdmissionHarness();
  const resolveSpy = spyOn(runtimeDecisionSvc, "resolveEffectiveRuntime").mockImplementation(
    (userId, request) => harness.service.resolve(userId, request),
  );
  try {
    const started = await startGeneration(harness.generationInput(9));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.tokenStore.liveCount).toBe(0);
    await waitForAgenticGeneration(started.generationId);
    expect(harness.dispatches).toEqual([{ provider: "authority-provider", model: "authority-model" }]);
  } finally {
    resolveSpy.mockRestore();
  }
});
});

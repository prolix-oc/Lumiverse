import { beforeEach, describe, expect, test } from "bun:test";
import type { GenerationResponse, LlmMessage, ToolDefinition } from "../llm/types";
import type { ToolContinuationMode } from "../llm/param-schema";
import { AGENT_INVOCATION_DEFAULT, AGENT_TOOL_CALL_DEFAULT } from "../types/agents";
import { AGENT_HOST_DEFAULT_LIMITS } from "./agent-runtime-limits";
import {
  AGENT_RUNTIME_ADMISSION_MANAGER,
  AgentRuntimeAdmissionManager,
} from "./agent-runtime-admission";
import type {
  AgentActivityEvent,
  AgentConfigV2,
  AgentProfileConfigV2,
  AgentToolSnapshot,
} from "../types/agents";
import type { AgentPublicErrorCode } from "../types/agent-runtime";
import type { ResolvedConcreteConnectionV1 } from "./connections.service";
import {
  AGENT_CHILD_TASK_MAX_BYTES,
  AGENT_SERIALIZED_VALUE_MAX_BYTES,
  AGENT_CHILD_SYSTEM_GUIDANCE,
  AGENT_TIMER_MAX_DELAY_MS,
  AgentRuntimeOwner,
  AgentRuntimeFailure,
  scheduleCancellableAgentTimeout,
  type AgentProviderDispatchRequest,
  type AgentProviderDispatchResponse,
  type AgentTimeoutHandle,
} from "./agent-runtime.service";

function profile(overrides: Partial<AgentProfileConfigV2> = {}): AgentProfileConfigV2 {
  return {
    id: "writer",
    name: "Writer",
    systemPrompt: "Write a concise answer.",
    connectionRef: { kind: "inherit_main" },
    toolIds: [],
    loreScope: "active",
    allowMainDelegation: true,
    failurePolicy: "required",
    streamActivity: true,
    maxOutputTokens: 64,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function config(
  profiles = [profile()],
  maxInvocations = AGENT_INVOCATION_DEFAULT,
  maxToolCalls = AGENT_TOOL_CALL_DEFAULT,
): AgentConfigV2 {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response"],
    defaultMode: "response",
    maxInvocations,
    maxToolCalls,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles,
    connectionSlots: [],
  };
}
function connection(logicalId = "root-connection"): ResolvedConcreteConnectionV1 {
  return {
    logicalId,
    concreteId: logicalId,
    label: "Test connection",
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
}

function snapshot(): AgentToolSnapshot {
  return {
    rootUserId: "user-a",
    chatId: "chat-a",
    books: [],
    entries: [],
    chatMessages: [
      { id: "m1", indexInChat: 0, role: "user", name: "Alice", content: "hello" },
    ],
    names: {
      user: "Alice",
      char: "Aria",
      group: "Aria",
      groupNotMuted: "Aria",
      notChar: "",
      charGroupFocused: "Aria",
      isGroupChat: "false",
      groupOthers: "",
      groupMemberCount: "1",
    },
  };
}

function response(
  content: string,
  extra: Partial<GenerationResponse> & {
    observedOutputTokens?: number;
    toolContinuationMode?: ToolContinuationMode;
    supportsToolFinalization?: boolean;
    postResponseErrorCode?: AgentPublicErrorCode;
  } = {},
): AgentProviderDispatchResponse {
  return {
    content,
    finish_reason: "stop",
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    toolContinuationMode: "native",
    supportsToolFinalization: true,
    ...extra,
  };
}

function toolCalls(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    name: "chat_search_history",
    args: { query: "hello" },
    call_id: `call-${offset + index}`,
  }));
}

function messageText(message: LlmMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

beforeEach(() => {
  AGENT_RUNTIME_ADMISSION_MANAGER.resetForTests();
});

describe("AgentRuntimeOwner", () => {
  test("dispatches exactly the fixed system message and resolved user task", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push(request);
        return response("done");
      },
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Resolve {{literal}}",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.content).toBe("done");
    expect(requests).toHaveLength(1);
    expect(requests[0].connection.concreteId).toBe("root-connection");
    expect(requests[0].messages).toEqual([
      {
        role: "system",
        content: `${AGENT_CHILD_SYSTEM_GUIDANCE}\n\nWrite a concise answer.`,
      },
      { role: "user", content: "Resolve {{literal}}" },
    ]);
    expect(requests[0].tools).toBeUndefined();
    owner.close();
  });
  test("accepts tokenizer-observed reasoning at the allowance for deterministic children", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "observed-deterministic",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          reasoning: "r".repeat(397),
          usage: { prompt_tokens: 11, completion_tokens: 128, total_tokens: 139 },
          observedOutputTokens: 128,
        }),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "deterministic observed reasoning",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "succeeded",
      content: "",
      usage: { inputTokens: 11, outputTokens: 128, totalTokens: 139 },
    });
    expect(owner.usage).toEqual({
      inputTokens: 11,
      outputTokens: 128,
      totalTokens: 139,
    });
    expect(owner.summary?.usage).toEqual(owner.usage);
    owner.close();
  });

  test("accepts tokenizer-observed reasoning at the allowance for delegated children", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "observed-delegated",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          reasoning: "r".repeat(397),
          usage: { prompt_tokens: 13, completion_tokens: 1, total_tokens: 14 },
          observedOutputTokens: 128,
        }),
    });

    const result = await owner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer", task: "delegated observed reasoning" },
      call_id: "observed-delegated-call",
    });
    const delegated = JSON.parse(result.result) as {
      status: string;
      toolName?: string;
      errorCode?: string;
      data?: { status: string; content: string };
    };

    expect(delegated).toEqual({
      status: "success",
      toolName: "agent_delegate",
      data: { status: "succeeded", content: "" },
    });
    expect(owner.usage).toEqual({
      inputTokens: 13,
      outputTokens: 128,
      totalTokens: 141,
    });
    expect(owner.summary?.usage).toEqual(owner.usage);
    owner.close();
  });

  test("charges tokenizer-observed output when provider usage under-reports", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "observed-underreported",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("answer", {
          reasoning: "reasoning",
          usage: { prompt_tokens: 13, completion_tokens: 1, total_tokens: 14 },
          observedOutputTokens: 37,
        }),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "underreported output",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(owner.usage).toEqual({
      inputTokens: 13,
      outputTokens: 37,
      totalTokens: 50,
    });
    expect(owner.summary?.usage).toEqual(owner.usage);
    owner.close();
  });

  test("settles and charges a complete response before surfacing invalid provider usage", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "invalid-usage-after-response",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("done", {
          usage: { prompt_tokens: 11, completion_tokens: -1, total_tokens: 10 },
          observedOutputTokens: 4,
        }),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "invalid completed usage",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      errorCode: "provider_protocol_error",
      usage: { inputTokens: 0, outputTokens: 4, totalTokens: 4 },
    });
    expect(owner.usage).toEqual({
      inputTokens: 0,
      outputTokens: 4,
      totalTokens: 4,
    });
    expect(owner.ledger.counters.childOutputTokens).toBe(4);
    owner.close();
  });

  test("sums distinct child invocations in retained and public activity usage", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "aggregate-child-usage",
      config: config(),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          observedOutputTokens: 10,
        }),
    });

    for (const task of ["first", "second"]) {
      const outcome = await owner.invoke({
        profileId: "writer",
        task,
        kind: "deterministic",
      });
      expect(outcome.outcome).toBe("succeeded");
    }

    const expectedUsage = {
      inputTokens: 20,
      outputTokens: 20,
      totalTokens: 40,
    };
    expect(owner.usage).toEqual(expectedUsage);
    expect(owner.summary?.usage).toEqual(expectedUsage);
    expect(owner.ledger.activitySnapshot("completed").usage).toMatchObject({
      ...expectedUsage,
      childInvocations: 2,
    });
    owner.close();
  });

  test("rejects cumulative usage overflow before mutating the aggregate", async () => {
    let dispatchCount = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "usage-overflow",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => {
        dispatchCount += 1;
        return response("", {
          usage: dispatchCount === 1
            ? {
                prompt_tokens: Number.MAX_SAFE_INTEGER,
                completion_tokens: 0,
                total_tokens: Number.MAX_SAFE_INTEGER,
              }
            : { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
          observedOutputTokens: 0,
        });
      },
    });

    const first = await owner.invoke({
      profileId: "writer",
      task: "first",
      kind: "deterministic",
    });
    const second = await owner.invoke({
      profileId: "writer",
      task: "second",
      kind: "deterministic",
    });

    expect(first.outcome).toBe("succeeded");
    expect(second).toMatchObject({
      outcome: "failed",
      errorCode: "provider_protocol_error",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(owner.usage).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    owner.close();
  });

  test("preserves typed output accounting failures without tokenizer observation", async () => {
    const deterministicOwner = new AgentRuntimeOwner({
      generationId: "unobserved-deterministic-over-limit",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          reasoning: "r".repeat(397),
          usage: { prompt_tokens: 17, completion_tokens: 128, total_tokens: 145 },
        }),
    });

    const deterministic = await deterministicOwner.invoke({
      profileId: "writer",
      task: "unobserved deterministic over limit",
      kind: "deterministic",
    });
    const providerRound = deterministicOwner.ledger
      .activitySnapshot("failed")
      .nodes.find((node) => node.kind === "provider_round");

    expect(deterministic).toMatchObject({
      outcome: "failed",
      errorCode: "child_output_token_limit_exceeded",
    });
    expect(providerRound?.errorCode).toBe("child_output_token_limit_exceeded");
    expect(deterministicOwner.usage).toEqual({
      inputTokens: 17,
      outputTokens: 397,
      totalTokens: 414,
    });
    expect(deterministicOwner.ledger.counters.childOutputTokens).toBe(397);
    deterministicOwner.close();

    const delegatedOwner = new AgentRuntimeOwner({
      generationId: "unobserved-delegated-over-limit",
      config: config([profile({ maxOutputTokens: 128 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          reasoning: "r".repeat(397),
          usage: { prompt_tokens: 19, completion_tokens: 128, total_tokens: 147 },
        }),
    });
    const delegatedResult = await delegatedOwner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer", task: "unobserved delegated over limit" },
      call_id: "unobserved-delegated-call",
    });
    const delegated = JSON.parse(delegatedResult.result) as {
      status: string;
      errorCode?: string;
    };
    const childNode = delegatedOwner.ledger
      .activitySnapshot("failed")
      .nodes.find((node) => node.kind === "child_invocation");

    expect(delegated.status).toBe("error");
    expect(delegated.errorCode).toBe("limit_exceeded");
    expect(childNode?.errorCode).toBe("child_output_token_limit_exceeded");
    expect(delegatedOwner.usage).toEqual({
      inputTokens: 19,
      outputTokens: 397,
      totalTokens: 416,
    });
    expect(delegatedOwner.ledger.counters.childOutputTokens).toBe(397);
    delegatedOwner.close();
  });
  test("charges observed output over a request allowance until the aggregate ceiling", async () => {
    let dispatchCount = 0;
    const limits = {
      ...AGENT_HOST_DEFAULT_LIMITS,
      childOutputTokens: 10,
    };
    const owner = new AgentRuntimeOwner({
      generationId: "aggregate-output-overage",
      config: config([profile({ maxOutputTokens: 4 })]),
      rootConnection: connection(),
      limits,
      dispatch: async () => {
        dispatchCount += 1;
        return dispatchCount === 1
          ? response("", {
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
              observedOutputTokens: 7,
            })
          : response("", {
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
              observedOutputTokens: 3,
            });
      },
    });

    const first = await owner.invoke({
      profileId: "writer",
      task: "over allowance",
      kind: "deterministic",
    });
    expect(first).toMatchObject({
      outcome: "failed",
      errorCode: "child_output_token_limit_exceeded",
      usage: { inputTokens: 2, outputTokens: 7, totalTokens: 9 },
    });
    expect(owner.ledger.counters.childOutputTokens).toBe(7);
    expect(owner.ledger.failure).toBeNull();
    expect(owner.usage).toEqual({
      inputTokens: 2,
      outputTokens: 7,
      totalTokens: 9,
    });

    const second = await owner.invoke({
      profileId: "writer",
      task: "consume remaining aggregate output",
      kind: "deterministic",
    });
    expect(second.outcome).toBe("succeeded");
    expect(dispatchCount).toBe(2);
    expect(owner.ledger.counters.childOutputTokens).toBe(10);

    const third = await owner.invoke({
      profileId: "writer",
      task: "reject after aggregate output ceiling",
      kind: "deterministic",
    });
    expect(third).toMatchObject({
      outcome: "failed",
      errorCode: "child_output_token_limit_exceeded",
    });
    expect(dispatchCount).toBe(2);
    expect(owner.ledger.failure).toMatchObject({
      code: "child_output_token_limit_exceeded",
      budget: "child_output_tokens",
      limit: 10,
      observed: 11,
    });
    expect(owner.ledger.counters.childOutputTokens).toBe(10);
    owner.close();
  });

  test("preserves a preclassified output failure when aggregate usage overflows", async () => {
    let dispatchCount = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "output-failure-before-usage-overflow",
      config: config([profile({ maxOutputTokens: 4 })]),
      rootConnection: connection(),
      dispatch: async () => {
        dispatchCount += 1;
        return dispatchCount === 1
          ? response("", {
              usage: {
                prompt_tokens: Number.MAX_SAFE_INTEGER,
                completion_tokens: 0,
                total_tokens: Number.MAX_SAFE_INTEGER,
              },
              observedOutputTokens: 0,
            })
          : response("", {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              observedOutputTokens: 7,
            });
      },
    });

    const first = await owner.invoke({
      profileId: "writer",
      task: "seed aggregate usage",
      kind: "deterministic",
    });
    expect(first.outcome).toBe("succeeded");

    const second = await owner.invoke({
      profileId: "writer",
      task: "output failure has precedence",
      kind: "deterministic",
    });
    expect(second).toMatchObject({
      outcome: "failed",
      errorCode: "child_output_token_limit_exceeded",
      usage: { inputTokens: 1, outputTokens: 7, totalTokens: 8 },
    });
    expect(dispatchCount).toBe(2);
    expect(owner.usage).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(owner.ledger.counters.childOutputTokens).toBe(7);
    expect(owner.ledger.failure).toBeNull();
    owner.close();
  });

  test("records bounded provider-round nodes across repeated child rounds", async () => {
    let dispatches = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-rounds",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })]),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches += 1;
        return dispatches <= 4
          ? response("", { tool_calls: toolCalls(1, dispatches - 1) })
          : response("done");
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "repeat",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
      stream: true,
    });
    const providerRounds = owner.ledger
      .activitySnapshot("completed")
      .nodes
      .filter((node) => node.kind === "provider_round");

    expect(outcome.outcome).toBe("succeeded");
    expect(dispatches).toBe(5);
    expect(providerRounds).toHaveLength(5);
    expect(providerRounds.map((node) => node.roundIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(providerRounds.every((node) => node.parentId === outcome.invocationId)).toBe(true);
    expect(providerRounds.every((node) => node.continuationMode === "ordinary")).toBe(true);
    owner.close();
  });

  test("preserves exact provider capability failures in live and retained activity", async () => {
    const codes: AgentPublicErrorCode[] = [
      "provider_tool_calling_unsupported",
      "provider_tool_continuation_unsupported",
      "provider_tool_finalization_unsupported",
    ];

    for (const code of codes) {
      const events: AgentActivityEvent[] = [];
      const owner = new AgentRuntimeOwner({
        generationId: `gen-${code}`,
        config: config(),
      rootConnection: connection(),
        dispatch: async () => {
          throw new AgentRuntimeFailure(code);
        },
        onActivity: (event) => events.push(event),
      });

      const outcome = await owner.invoke({
        profileId: "writer",
        task: "exercise capability preflight",
        kind: "deterministic",
        stream: true,
      });
      const snapshot = owner.ledger.activitySnapshot("failed");
      const childNode = snapshot.nodes.find(
        (node) => node.kind === "child_invocation",
      );
      const providerRound = snapshot.nodes.find(
        (node) => node.kind === "provider_round",
      );
      expect(outcome).toMatchObject({ outcome: "failed", errorCode: code });
      expect(events.at(-1)).toMatchObject({ phase: "failed", errorCode: code });
      expect(childNode).toMatchObject({ phase: "failed", errorCode: code });
      expect(providerRound).toMatchObject({ phase: "failed", errorCode: code });
      expect(snapshot.errorCounts).toEqual({ [code]: 2 });
      expect(owner.summary?.errorCodes).toContain(code);

      const delegatedOwner = new AgentRuntimeOwner({
        generationId: `delegated-${code}`,
        config: config(),
      rootConnection: connection(),
        dispatch: async () => {
          throw new AgentRuntimeFailure(code);
        },
      });
      const delegated = await delegatedOwner.executeMainToolCall({
        name: "agent_delegate",
        args: { profile_id: "writer", task: "delegate failure" },
        call_id: `call-${code}`,
      });
      expect(delegated.result).toContain('"errorCode":"provider_failed"');
      expect(delegated.result).not.toContain('"errorCode":"internal_error"');
      const delegatedToolNode = delegatedOwner.ledger
        .activitySnapshot("failed")
        .nodes.find((node) => node.kind === "tool_attempt");
      expect(delegatedToolNode?.errorCode).toBe(code);
      delegatedOwner.close();
      owner.close();
    }
  });

  test("chunks long timeout delays and cancellation prevents rescheduling", () => {
    type PendingTimer = {
      handle: AgentTimeoutHandle;
      callback: () => void;
      delayMs: number;
    };
    const pending: PendingTimer[] = [];
    const cleared = new Set<AgentTimeoutHandle>();
    let nextHandle = 0;
    const scheduler = {
      setTimeout(callback: () => void, delayMs: number): AgentTimeoutHandle {
        const handle = nextHandle as unknown as AgentTimeoutHandle;
        nextHandle += 1;
        pending.push({ handle, callback, delayMs });
        return handle;
      },
      clearTimeout(handle: AgentTimeoutHandle): void {
        cleared.add(handle);
      },
    };
    let fired = 0;
    const cancel = scheduleCancellableAgentTimeout(
      () => {
        fired += 1;
      },
      AGENT_TIMER_MAX_DELAY_MS + 2_000,
      scheduler,
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]?.delayMs).toBe(AGENT_TIMER_MAX_DELAY_MS);
    pending[0]?.callback();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.delayMs).toBe(2_000);

    cancel();
    expect(cleared.has(pending[1]!.handle)).toBe(true);
    pending[1]?.callback();
    expect(fired).toBe(0);
    expect(pending).toHaveLength(2);
  });

  test("reports profile timeout when a child provider honors its timeout signal", async () => {
    // Keep this runtime-only test short; the parser enforces the 5-second minimum.
    const pendingTimers: Array<() => void> = [];
    let nextHandle = 0;
    const scheduler = {
      setTimeout(callback: () => void, _delayMs: number): AgentTimeoutHandle {
        pendingTimers.push(callback);
        const handle = nextHandle as unknown as AgentTimeoutHandle;
        nextHandle += 1;
        return handle;
      },
      clearTimeout(_handle: AgentTimeoutHandle): void {},
    };
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ timeoutMs: 1 })]),
      rootConnection: connection(),
      timeoutScheduler: scheduler,
      dispatch: async ({ signal }) => new Promise<AgentProviderDispatchResponse>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });

    const pendingOutcome = owner.invoke({
      profileId: "writer",
      task: "wait",
      kind: "deterministic",
    });
    expect(pendingTimers).toHaveLength(1);
    pendingTimers[0]!();
    const outcome = await pendingOutcome;

    expect(outcome.outcome).toBe("timed_out");
    expect(outcome.errorCode).toBe("profile_timeout");
    owner.close();
  });

  test("root and close aborts cancel non-cooperative child timeout chunks", async () => {
    for (const abortMode of ["root", "close"] as const) {
      const pendingTimers: Array<{
        handle: AgentTimeoutHandle;
        callback: () => void;
        delayMs: number;
      }> = [];
      const cleared = new Set<AgentTimeoutHandle>();
      let nextHandle = 0;
      const scheduler = {
        setTimeout(callback: () => void, delayMs: number): AgentTimeoutHandle {
          const handle = nextHandle as unknown as AgentTimeoutHandle;
          nextHandle += 1;
          pendingTimers.push({ handle, callback, delayMs });
          return handle;
        },
        clearTimeout(handle: AgentTimeoutHandle): void {
          cleared.add(handle);
        },
      };
      const rootController = new AbortController();
      let release!: (value: AgentProviderDispatchResponse) => void;
      const owner = new AgentRuntimeOwner({
        generationId: "gen-a",
        config: config([profile({
          timeoutMs: AGENT_TIMER_MAX_DELAY_MS + 1_000,
        })]),
      rootConnection: connection(),
        signal: abortMode === "root" ? rootController.signal : undefined,
        timeoutScheduler: scheduler,
        dispatch: async () => new Promise<AgentProviderDispatchResponse>((resolve) => {
          release = resolve;
        }),
      });

      const pendingOutcome = owner.invoke({
        profileId: "writer",
        task: "wait",
        kind: "deterministic",
      });
      expect(pendingTimers).toHaveLength(1);
      expect(pendingTimers[0]?.delayMs).toBe(AGENT_TIMER_MAX_DELAY_MS);

      if (abortMode === "root") rootController.abort();
      else owner.close();

      expect(cleared.has(pendingTimers[0]!.handle)).toBe(true);
      pendingTimers[0]?.callback();
      expect(pendingTimers).toHaveLength(1);

      release(response("late"));
      const outcome = await pendingOutcome;
      expect(outcome.outcome).toBe("cancelled");
      expect(outcome.errorCode).toBe("cancelled");
      owner.close();
    }
  });

  test("round-trips native tool call IDs and carriers", async () => {
    const events: AgentActivityEvent[] = [];
    const requests: AgentProviderDispatchRequest[] = [];
    const queue = [
      response("", {
        toolContinuationMode: "native",
        finish_reason: "tool_use",
        reasoning: "thinking",
        thinking_blocks: [{ type: "thinking", thinking: "x", signature: "sig" }],
        tool_calls: toolCalls(1),
      }),
      response("final", { toolContinuationMode: "native" }),
    ];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push({
          ...request,
          messages: structuredClone(request.messages),
          ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
        });
        return queue.shift()!;
      },
      onActivity: (event) => events.push(event),
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Find it",
      kind: "deterministic",
      stream: true,
      toolIds: ["chat_search_history"],
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools).toHaveLength(1);
    expect(requests[1].messages[2]?.role).toBe("assistant");
    expect(requests[1].messages[3]?.role).toBe("user");
    expect(messageText(requests[1].messages[2])).toContain('"id":"call-0"');
    expect(messageText(requests[1].messages[3])).toContain('"tool_use_id":"call-0"');
    expect(requests[1].messages[2].thinking_blocks).toEqual([
      { type: "thinking", thinking: "x", signature: "sig" },
    ]);
    const childStarted = events.find(
      (event) => event.phase === "started" && event.toolName === undefined,
    );
    expect(childStarted).toMatchObject({
      actor: "child_profile",
      profileName: "Writer",
    });
    const toolEvents = events.filter(
      (event) => event.toolName === "chat_search_history",
    );
    expect(toolEvents.map((event) => event.phase)).toEqual([
      "tool_call",
      "completed",
    ]);
    expect(toolEvents[0].parentInvocationId).toBe(childStarted?.invocationId);
    owner.close();
  });

  test("preserves ordered Responses call/result chronology across rounds", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const carrier = {
      kind: "openai_responses" as const,
      items: [
        {
          type: "function_call" as const,
          id: "function_child",
          call_id: "call-0",
          name: "chat_search_history",
          arguments: "{\"query\":\"hello\"}",
        },
      ],
    };
    const owner = new AgentRuntimeOwner({
      generationId: "responses-child",
      config: config([profile({ toolIds: ["chat_search_history"], maxOutputTokens: 1_024 })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push({
          ...request,
          messages: structuredClone(request.messages),
          ...(request.providerTransientCarrier
            ? { providerTransientCarrier: structuredClone(request.providerTransientCarrier) }
            : {}),
        });
        if (requests.length === 1) {
          return response("", {
            finish_reason: "tool_use",
            tool_calls: toolCalls(1),
            providerTransientCarrier: carrier,
          });
        }
        if (requests.length === 2) {
          return response("", {
            finish_reason: "tool_use",
            tool_calls: toolCalls(1, 1),
            providerTransientCarrier: {
              kind: "openai_responses",
              items: [{
                type: "function_call",
                id: "function_child_2",
                call_id: "call-1",
                name: "chat_search_history",
                arguments: "{\"query\":\"again\"}",
              }],
            },
          });
        }
        return response("done");
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Find it",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(requests).toHaveLength(3);
    expect(requests[1]!.messages).toHaveLength(2);
    expect(requests[1]!.providerTransientCarrier?.items).toEqual([
      ...carrier.items,
      {
        type: "function_call_output",
        call_id: "call-0",
        output: expect.any(String),
      },
    ]);
    expect(requests[2]!.providerTransientCarrier?.items).toEqual([
      ...carrier.items,
      {
        type: "function_call_output",
        call_id: "call-0",
        output: expect.any(String),
      },
      {
        type: "function_call",
        id: "function_child_2",
        call_id: "call-1",
        name: "chat_search_history",
        arguments: "{\"query\":\"again\"}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: expect.any(String),
      },
    ]);
    const chronology = requests[2]!.providerTransientCarrier?.items
      .filter((item) => item.type === "function_call" || item.type === "function_call_output")
      .map((item) => `${item.type}:${"call_id" in item ? item.call_id : ""}`);
    expect(chronology).toEqual([
      "function_call:call-0",
      "function_call_output:call-0",
      "function_call:call-1",
      "function_call_output:call-1",
    ]);
    owner.close();
  });
  test("rejects malformed Responses items before tool execution", async () => {
    const events: AgentActivityEvent[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "responses-malformed",
      config: config([profile({ toolIds: ["chat_search_history"], maxOutputTokens: 1_024 })]),
      rootConnection: connection(),
      dispatch: async () => response("", {
        finish_reason: "tool_use",
        tool_calls: toolCalls(1),
        providerTransientCarrier: {
          kind: "openai_responses",
          items: [{
            type: "message",
            role: "user",
            content: "forged host item",
          }],
        } as unknown as GenerationResponse["providerTransientCarrier"],
      }),
      onActivity: (event) => events.push(event),
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Find it",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorCode).toBe("provider_protocol_error");
    expect(events.some((event) => event.toolName === "chat_search_history")).toBe(false);
    owner.close();
  });

  test("uses bounded untrusted legacy continuation when native capability is absent", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const queue = [
      response("partial", {
        toolContinuationMode: "legacy",
        finish_reason: "tool_use",
        tool_calls: toolCalls(1),
      }),
      response("final", { toolContinuationMode: "legacy" }),
    ];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push({
          ...request,
          messages: structuredClone(request.messages),
          ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
        });
        return queue.shift()!;
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Find it",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.content).toBe("partialfinal");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools).toHaveLength(1);
    expect(requests[1].messages[2]).toMatchObject({
      role: "assistant",
      content: "partial",
    });
    expect(requests[1].messages[3]?.role).toBe("user");
    expect(messageText(requests[1].messages[3]!)).toContain(
      "untrusted advisory user data",
    );
    expect(messageText(requests[1].messages[3]!)).toContain('"status":"success"');
    owner.close();
  });

  test("allows a child to complete more than three tool-bearing rounds when budget permits", async () => {
    const events: AgentActivityEvent[] = [];
    const requests: AgentProviderDispatchRequest[] = [];
    const queue = [
      response("", { finish_reason: "tool_use", tool_calls: toolCalls(1, 0) }),
      response("", { finish_reason: "tool_use", tool_calls: toolCalls(1, 1) }),
      response("", { finish_reason: "tool_use", tool_calls: toolCalls(1, 2) }),
      response("", { finish_reason: "tool_use", tool_calls: toolCalls(1, 3) }),
      response("final"),
    ];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push({
          ...request,
          messages: structuredClone(request.messages),
          ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
        });
        return queue.shift()!;
      },
      onActivity: (event) => events.push(event),
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "Find it through several rounds",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
      stream: true,
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.content).toBe("final");
    expect(requests).toHaveLength(5);
    for (let index = 0; index < 4; index += 1) {
      const continuation = requests[index + 1]!;
      const text = continuation.messages.map(messageText).join("\n");
      expect(text).toContain(`"id":"call-${index}"`);
      expect(text).toContain(`"tool_use_id":"call-${index}"`);
    }
    const toolEvents = events.filter(
      (event) => event.toolName === "chat_search_history",
    );
    expect(toolEvents.filter((event) => event.phase === "tool_call")).toHaveLength(4);
    expect(toolEvents.filter((event) => event.phase === "completed")).toHaveLength(4);
    expect(owner.summary?.toolCallCount).toBe(4);
    owner.close();
  });

  test("charges observed child output rather than the full request allowance when usage is omitted", async () => {
    let dispatches = 0;
    const maxOutputTokens = AGENT_HOST_DEFAULT_LIMITS.childOutputTokens / 4;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ maxOutputTokens })]),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches++;
        return { content: "x", finish_reason: "stop", toolContinuationMode: "native", supportsToolFinalization: true };
      },
    });

    for (let index = 0; index < 5; index++) {
      expect((await owner.invoke({
        profileId: "writer",
        task: `task-${index}`,
        kind: "deterministic",
      })).outcome).toBe("succeeded");
    }
    expect(owner.ledger.counters.childOutputTokens).toBe(5);
    expect(dispatches).toBe(5);
    owner.close();
  });

  test("enforces a configured low invocation limit before provider dispatch", async () => {
    let dispatches = 0;
    const runtimeConfig = config([profile()], 2);
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: runtimeConfig,
      rootConnection: connection(),
      dispatch: async () => {
        dispatches++;
        return response("ok");
      },
    });
    runtimeConfig.maxInvocations = AGENT_INVOCATION_DEFAULT;

    for (let index = 0; index < 2; index += 1) {
      expect((await owner.invoke({
        profileId: "writer",
        task: `task-${index}`,
        kind: "deterministic",
      })).outcome).toBe("succeeded");
    }
    await expect(owner.invoke({
      profileId: "writer",
      task: "over-limit",
      kind: "deterministic",
    })).rejects.toMatchObject({ code: "child_admission_limit_exceeded" });
    expect(dispatches).toBe(2);
    owner.close();
  });
  test("does not consume the child admission cap for recorded pre-admission failures", async () => {
    const events: AgentActivityEvent[] = [];
    let dispatches = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile()], 1),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches++;
        return response("ok");
      },
      onActivity: (event) => events.push(event),
    });

    const rejected = owner.recordInvocationFailure(
      {
        profileId: "writer",
        task: "invalid task",
        kind: "deterministic",
        stream: true,
      },
      "invalid_task",
    );
    expect(rejected.outcome).toBe("failed");
    expect(owner.summary).toMatchObject({
      invocationCount: 1,
      failedCount: 1,
      succeededCount: 0,
    });

    const completed = await owner.invoke({
      profileId: "writer",
      task: "valid task",
      kind: "deterministic",
      stream: true,
    });
    expect(completed.outcome).toBe("succeeded");
    expect(dispatches).toBe(1);

    await expect(owner.invoke({
      profileId: "writer",
      task: "second valid task",
      kind: "deterministic",
      stream: true,
    })).rejects.toMatchObject({ code: "child_admission_limit_exceeded" });
    expect(dispatches).toBe(1);
    expect(owner.summary).toMatchObject({
      invocationCount: 2,
      failedCount: 1,
      succeededCount: 1,
    });
    expect(events.map((event) => event.phase)).toEqual([
      "failed",
      "queued",
      "started",
      "completed",
    ]);
    expect(events[0]).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCode: "invalid_task",
    });
    owner.close();
  });


  test("admits the default 64 child invocations and rejects the 65th before dispatch", async () => {
    let dispatches = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches++;
        return response("ok");
      },
    });

    for (let index = 0; index < AGENT_INVOCATION_DEFAULT; index += 1) {
      expect((await owner.invoke({
        profileId: "writer",
        task: `task-${index}`,
        kind: "deterministic",
      })).outcome).toBe("succeeded");
    }
    await expect(owner.invoke({
      profileId: "writer",
      task: "over-default-limit",
      kind: "deterministic",
    })).rejects.toMatchObject({ code: "child_admission_limit_exceeded" });
    expect(dispatches).toBe(AGENT_INVOCATION_DEFAULT);
    owner.close();
  });

  test("accepts and enforces an invocation limit above the default", async () => {
    const maxInvocations = AGENT_INVOCATION_DEFAULT + 1;
    let dispatches = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile()], maxInvocations),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches++;
        return response("ok");
      },
    });

    for (let index = 0; index < maxInvocations; index += 1) {
      expect((await owner.invoke({
        profileId: "writer",
        task: `task-${index}`,
        kind: "deterministic",
      })).outcome).toBe("succeeded");
    }
    await expect(owner.invoke({
      profileId: "writer",
      task: "over-configured-limit",
      kind: "deterministic",
    })).rejects.toMatchObject({ code: "child_admission_limit_exceeded" });
    expect(dispatches).toBe(maxInvocations);
    owner.close();
  });

  test("intersects deterministic stream requests with the profile ceiling", async () => {
    const events: AgentActivityEvent[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([
        profile(),
        profile({ id: "quiet", name: "Quiet", streamActivity: false }),
      ]),
      rootConnection: connection(),
      dispatch: async () => response("ok"),
      onActivity: (event) => events.push(event),
    });

    await owner.invoke({
      profileId: "writer",
      task: "silent deterministic",
      kind: "deterministic",
      stream: false,
    });
    expect(events).toHaveLength(0);

    await owner.invoke({
      profileId: "writer",
      task: "visible deterministic",
      kind: "deterministic",
      stream: true,
    });
    expect(events.map((event) => event.phase)).toEqual([
      "queued",
      "started",
      "completed",
    ]);
    events.length = 0;

    await owner.invoke({
      profileId: "quiet",
      task: "silent delegation",
      kind: "delegated",
    });
    expect(events).toHaveLength(0);
    owner.close();
  });
  test("records main-model core tools as bounded live activity", async () => {
    const events: AgentActivityEvent[] = [];
    const mainConfig = config();
    mainConfig.mainToolIds = ["chat_search_history"];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: mainConfig,
      rootConnection: connection(),
      dispatch: async () => response("unused"),
      onActivity: (event) => events.push(event),
    });
    owner.setSnapshot(snapshot());

    expect(owner.validateMainRoundCallCount(8)).toBe(true);
    expect(owner.validateMainRoundCallCount(9)).toBe(true);
    const result = await owner.executeMainToolCall({
      name: "chat_search_history",
      args: { query: "hello" },
      call_id: "main-call",
    });

    expect(JSON.parse(result.result).status).toBe("success");
    expect(events.map((event) => event.phase)).toEqual([
      "queued",
      "started",
      "tool_call",
      "completed",
    ]);
    expect(events.every((event) => event.actor === "main_model")).toBe(true);
    expect(events.every((event) => !Object.hasOwn(event, "profileName"))).toBe(true);
    expect(events.every((event) => event.profileName === undefined)).toBe(true);
    expect(events[2].toolName).toBe("chat_search_history");
    expect(owner.summary).toMatchObject({
      status: "succeeded",
      invocationCount: 1,
      succeededCount: 1,
      toolCallCount: 1,
    });
    owner.close();
  });

  test("charges ordinary mixed-root calls through the shared ledger", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    let executed = false;
    const result = await owner.executeOrdinaryToolCall(
      {
        name: "council_tool",
        args: { query: "ordinary" },
        call_id: "ordinary-call",
      },
      async () => {
        executed = true;
        return {
          callId: "ordinary-call",
          qualifiedName: "council_tool",
          toolName: "council_tool",
          toolDisplayName: "Council tool",
          result: "ordinary result",
        };
      },
    );

    expect(executed).toBe(true);
    expect(result.callId).toBe("ordinary-call");
    expect(owner.ledger.counters.aggregateToolCalls).toBe(1);
    expect(owner.ledger.budgetCounters.find(({ id }) => id === "argument_bytes")?.observed)
      .toBeGreaterThan(0);
    expect(owner.ledger.budgetCounters.find(({ id }) => id === "result_bytes")?.observed)
      .toBeGreaterThan(0);
    owner.close();
  });

  test("charges rejected oversized main arguments and correlated errors", async () => {
    const mainConfig = config([], AGENT_INVOCATION_DEFAULT, 2);
    mainConfig.mainToolIds = ["chat_search_history"];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: mainConfig,
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    owner.setSnapshot(snapshot());

    const result = await owner.executeMainToolCall({
      name: "chat_search_history",
      args: { query: "x".repeat(20_000) },
      call_id: "oversized",
    });

    expect(JSON.parse(result.result)).toMatchObject({
      status: "error",
      errorCode: "limit_exceeded",
    });
    expect(owner.ledger.budgetCounters.find(({ id }) => id === "argument_bytes")?.observed)
      .toBeGreaterThan(0);
    expect(owner.ledger.budgetCounters.find(({ id }) => id === "result_bytes")?.observed)
      .toBeGreaterThan(0);
    owner.close();
  });

  test("releases child output reservation when provider admission rejects dispatch", async () => {
    const limits = {
      ...AGENT_HOST_DEFAULT_LIMITS,
      providerDispatchesPerUser: 0,
    };
    const admission = new AgentRuntimeAdmissionManager(limits);
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile()]),
      rootConnection: connection(),
      admission,
      dispatch: async () => response("unexpected"),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "provider must reject",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorCode).toBe("capacity_exceeded");
    expect(owner.ledger.remaining("child_output_tokens"))
      .toBe(AGENT_HOST_DEFAULT_LIMITS.childOutputTokens);
    expect(owner.ledger.activitySnapshot("failed").nodes.find(
      (node) => node.kind === "provider_round",
    )).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCode: "capacity_exceeded",
    });
    owner.close();
  });
  test("terminalizes a provider round when dispatch reservation is rejected", async () => {
    const limits = {
      ...AGENT_HOST_DEFAULT_LIMITS,
      logicalProviderRequests: 0,
    };
    const owner = new AgentRuntimeOwner({
      generationId: "dispatch-reservation-rejected",
      config: config([profile()]),
      rootConnection: connection(),
      limits,
      dispatch: async () => response("unexpected"),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "logical dispatch must reject",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      errorCode: "logical_provider_request_limit_exceeded",
    });
    expect(owner.ledger.activitySnapshot("failed").nodes.find(
      (node) => node.kind === "provider_round",
    )).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCode: "logical_provider_request_limit_exceeded",
    });
    owner.close();
  });

  test("terminalizes a provider round when output allowance is exhausted", async () => {
    const limits = {
      ...AGENT_HOST_DEFAULT_LIMITS,
      childOutputTokens: 0,
    };
    let dispatches = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "output-reservation-rejected",
      config: config([profile()]),
      rootConnection: connection(),
      limits,
      dispatch: async () => {
        dispatches += 1;
        return response("unexpected");
      },
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "output must reject",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      errorCode: "child_output_token_limit_exceeded",
    });
    expect(dispatches).toBe(0);
    expect(owner.ledger.activitySnapshot("failed").nodes.find(
      (node) => node.kind === "provider_round",
    )).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCode: "child_output_token_limit_exceeded",
    });
    owner.close();
  });

  test("returns ordered same-call-ID aggregate quota results without throwing", async () => {
    const mainConfig = config([], AGENT_INVOCATION_DEFAULT, 1);
    mainConfig.mainToolIds = ["chat_search_history"];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: mainConfig,
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    owner.setSnapshot(snapshot());

    const accepted = await owner.executeMainToolCall({
      name: "chat_search_history",
      args: { query: "hello" },
      call_id: "accepted",
    });
    expect(accepted.callId).toBe("accepted");
    expect(JSON.parse(accepted.result).status).toBe("success");

    const limited = await owner.executeMainToolCall({
      name: "chat_search_history",
      args: { query: "hello" },
      call_id: "limited",
    });
    expect(limited.callId).toBe("limited");
    expect(JSON.parse(limited.result)).toMatchObject({
      status: "error",
      errorCode: "limit_exceeded",
    });
    owner.close();
  });

  test("does not succeed when a provider resolves after cancellation", async () => {
    const controller = new AbortController();
    let release!: (value: AgentProviderDispatchResponse) => void;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      signal: controller.signal,
      dispatch: async () => new Promise<AgentProviderDispatchResponse>((resolve) => {
        release = resolve;
        controller.abort();
      }),
    });

    const pending = owner.invoke({
      profileId: "writer",
      task: "wait",
      kind: "deterministic",
    });
    release(response("late"));
    const outcome = await pending;
    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.content).toBe("");
    expect(owner.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      totalTokens: 6,
    });
    owner.close();
  });
  test("settles terminal child output overage and terminalizes its provider round", async () => {
    const controller = new AbortController();
    const owner = new AgentRuntimeOwner({
      generationId: "terminal-output-overage",
      config: config([profile({ maxOutputTokens: 4 })]),
      rootConnection: connection(),
      signal: controller.signal,
      dispatch: async () => {
        controller.abort();
        return response("late", {
          observedOutputTokens: 7,
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
      },
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "settle after stop",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "cancelled",
      usage: { inputTokens: 2, outputTokens: 7, totalTokens: 9 },
    });
    expect(owner.ledger.counters.childOutputTokens).toBe(7);
    const providerRounds = owner.ledger.activitySnapshot(
      "cancelled",
      "cancelled",
    ).nodes.filter((node) => node.kind === "provider_round");
    expect(providerRounds).toHaveLength(1);
    expect(providerRounds[0]).toMatchObject({
      phase: "cancelled",
      status: "cancelled",
      errorCode: "cancelled",
    });
    owner.close();
  });

  test("prefers an exact ledger failure after accounting a complete response", async () => {
    let owner: AgentRuntimeOwner;
    owner = new AgentRuntimeOwner({
      generationId: "ledger-failure-after-response",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => {
        owner.ledger.charge(
          "root_wall_clock_ms",
          owner.ledger.limits.rootWallClockMs + 1,
        );
        return response("late", { postResponseErrorCode: "cancelled" });
      },
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "complete at deadline",
      kind: "deterministic",
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      errorCode: "root_wall_clock_limit_exceeded",
      usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
    });
    expect(owner.ledger.failure?.code).toBe("root_wall_clock_limit_exceeded");
    expect(owner.ledger.activitySnapshot("failed").nodes
      .find((node) => node.kind === "provider_round")?.errorCode)
      .toBe("root_wall_clock_limit_exceeded");
    owner.close();
  });

  test("close suppresses callbacks but terminalizes an active child", async () => {
    const events: AgentActivityEvent[] = [];
    let release!: (value: AgentProviderDispatchResponse) => void;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      dispatch: async () =>
        new Promise<AgentProviderDispatchResponse>((resolve) => {
          release = resolve;
        }),
      onActivity: (event) => events.push(event),
    });

    const pending = owner.invoke({
      profileId: "writer",
      task: "stop me",
      kind: "deterministic",
      stream: true,
    });
    expect(events.map((event) => event.phase)).toEqual(["queued", "started"]);

    owner.close();
    release(response("late"));
    const outcome = await pending;

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.content).toBe("");
    expect(events.map((event) => event.phase)).toEqual(["queued", "started"]);
    expect(owner.summary).toMatchObject({
      status: "cancelled",
      cancelledCount: 1,
    });
    const terminalNodes = owner.ledger
      .activitySnapshot("cancelled", "cancelled")
      .nodes.filter(
        (node) =>
          node.kind === "child_invocation" ||
          node.kind === "provider_round",
      );
    expect(terminalNodes.map((node) => node.kind).sort()).toEqual([
      "child_invocation",
      "provider_round",
    ]);
    expect(terminalNodes.every(
      (node) =>
        node.phase === "cancelled" &&
        node.status === "cancelled" &&
        node.errorCode === "cancelled",
    )).toBe(true);
  });

  test("terminalizes admitted delegation and core-tool activity after close", async () => {
    const events: AgentActivityEvent[] = [];
    let owner: AgentRuntimeOwner;
    owner = new AgentRuntimeOwner({
      generationId: "terminal-activity",
      config: config([profile({ toolIds: ["chat_search_history"] })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("", {
          finish_reason: "tool_use",
          tool_calls: toolCalls(1),
          observedOutputTokens: 1,
        }),
      onActivity: (event) => {
        events.push(event);
        if (
          event.toolName === "chat_search_history" &&
          event.phase === "tool_call"
        ) {
          owner.close();
        }
      },
    });
    owner.setSnapshot(snapshot());

    await owner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer", task: "stop during tool activity" },
      call_id: "terminal-activity-call",
    });

    const activity = owner.ledger.activitySnapshot("cancelled", "cancelled");
    const admittedNodes = activity.nodes.filter(
      (node) =>
        node.kind === "child_invocation" ||
        node.kind === "tool_attempt",
    );
    expect(admittedNodes.map((node) =>
      node.kind === "tool_attempt" ? `${node.kind}:${node.toolId}` : node.kind,
    ).sort()).toEqual([
      "child_invocation",
      "tool_attempt:agent_delegate",
      "tool_attempt:chat_search_history",
    ]);
    expect(admittedNodes.every(
      (node) =>
        node.phase === "cancelled" &&
        node.status === "cancelled" &&
        node.errorCode === "cancelled",
    )).toBe(true);
    expect(events.some(
      (event) =>
        event.toolName === "chat_search_history" &&
        event.phase === "tool_call",
    )).toBe(true);
    owner.close();
  });

  test("fails before executing a child tool call with an empty provider ID", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ toolIds: ["chat_search_history"] })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push(request);
        return response("", {
          observedOutputTokens: 1,
          tool_calls: [
            {
              name: "chat_search_history",
              args: { query: "hello" },
              call_id: "",
            },
          ],
        });
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "invalid call id",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorCode).toBe("provider_failed");
    expect(requests).toHaveLength(1);
    expect(owner.summary).toMatchObject({ toolCallCount: 0 });
    owner.close();
  });

  test("fails before executing child tools with duplicate provider IDs", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ toolIds: ["chat_search_history"] })]),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push(request);
        return response("", {
          observedOutputTokens: 1,
          tool_calls: [
            {
              name: "chat_search_history",
              args: { query: "hello" },
              call_id: "duplicate",
            },
            {
              name: "chat_search_history",
              args: { query: "world" },
              call_id: "duplicate",
            },
          ],
        });
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "duplicate call ids",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorCode).toBe("provider_failed");
    expect(requests).toHaveLength(1);
    expect(owner.summary).toMatchObject({ toolCallCount: 0 });
    owner.close();
  });

  test("rejects whitespace-only child tasks before dispatch", async () => {
    let dispatchCount = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => {
        dispatchCount++;
        return response("unexpected");
      },
    });

    let error: unknown;
    try {
      await owner.invoke({
        profileId: "writer",
        task: " \n\t ",
        kind: "deterministic",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "invalid_task" });
    expect(dispatchCount).toBe(0);
    owner.close();
  });

  test("accepts 32 KiB ASCII and multibyte child tasks and rejects 32 KiB plus one byte before dispatch", async () => {
    let dispatchCount = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "gen-child-task-boundary",
      config: config(),
      rootConnection: connection(),
      dispatch: async () => {
        dispatchCount += 1;
        return response("done");
      },
    });
    const asciiBoundary = "a".repeat(AGENT_CHILD_TASK_MAX_BYTES);
    const multibyteBoundary = "é".repeat(AGENT_CHILD_TASK_MAX_BYTES / 2);
    const oneByteOver = `${multibyteBoundary}a`;

    expect(Buffer.byteLength(asciiBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(multibyteBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(oneByteOver, "utf8")).toBe(32_769);
    for (const task of [asciiBoundary, multibyteBoundary]) {
      const outcome = await owner.invoke({
        profileId: "writer",
        task,
        kind: "deterministic",
      });
      expect(outcome.outcome).toBe("succeeded");
    }
    await expect(owner.invoke({
      profileId: "writer",
      task: oneByteOver,
      kind: "deterministic",
    })).rejects.toMatchObject({ code: "invalid_task" });
    expect(dispatchCount).toBe(2);
    owner.close();
  });

  test("rejects deterministic child output one byte above serialized value limit", async () => {
    const boundaryContentBytes =
      AGENT_SERIALIZED_VALUE_MAX_BYTES -
      Buffer.byteLength(
        JSON.stringify({
          producerLabel: "Writer",
          status: "succeeded",
          content: "",
        }),
        "utf8",
      );
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ maxOutputTokens: boundaryContentBytes + 1 })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("x".repeat(boundaryContentBytes + 1)),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "large output",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorCode).toBe("serialized_value_limit_exceeded");
    const failureNode = owner.ledger.activitySnapshot("failed").nodes.find(
      (node) => node.kind === "child_invocation",
    );
    expect(failureNode?.errorCode).toBe("materialized_limit_exceeded");
    owner.close();
  });

  test("accepts deterministic child output at the serialized value limit", async () => {
    const boundaryContentBytes =
      AGENT_SERIALIZED_VALUE_MAX_BYTES -
      Buffer.byteLength(
        JSON.stringify({
          producerLabel: "Writer",
          status: "succeeded",
          content: "",
        }),
        "utf8",
      );
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ maxOutputTokens: boundaryContentBytes })]),
      rootConnection: connection(),
      dispatch: async () =>
        response("x".repeat(boundaryContentBytes)),
    });

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "boundary output",
      kind: "deterministic",
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBe(
      boundaryContentBytes,
    );
    owner.close();
  });

  test("nests delegated child activity beneath the main delegation tool", async () => {
    const events: AgentActivityEvent[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ name: "   " })]),
      rootConnection: connection(),
      dispatch: async () => response("delegated"),
      onActivity: (event) => events.push(event),
    });

    const result = await owner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer", task: "Do one thing" },
      call_id: "delegate-call",
    });

    expect(result.result).toContain('"status":"success"');
    const delegationEvent = events.find(
      (event) =>
        event.phase === "tool_call" &&
        event.toolName === "agent_delegate",
    );
    const childEvent = events.find(
      (event) =>
        event.phase === "started" &&
        event.actor === "child_profile" &&
        event.profileName === "writer",
    );
    expect(delegationEvent).toMatchObject({ actor: "main_model" });
    expect(delegationEvent && Object.hasOwn(delegationEvent, "profileName")).toBe(false);
    expect(childEvent?.parentInvocationId).toBe(
      delegationEvent?.invocationId,
    );
    owner.close();
  });

  test("hides main and child delegation activity when the profile stream ceiling is disabled", async () => {
    const events: AgentActivityEvent[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([profile({ streamActivity: false })]),
      rootConnection: connection(),
      dispatch: async () => response("delegated"),
      onActivity: (event) => events.push(event),
    });

    const result = await owner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer", task: "Do one thing quietly" },
      call_id: "quiet-delegate-call",
    });

    expect(JSON.parse(result.result).status).toBe("success");
    expect(events).toHaveLength(0);
    owner.close();
  });

  test("describes authorized delegation profiles and rejects malformed arguments", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "gen-a",
      config: config([
        profile({ toolIds: ["chat_search_history"] }),
        profile({
          id: "private",
          name: "Private",
          allowMainDelegation: false,
        }),
      ]),
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });

    const definition = owner
      .getMainToolDefinitions()
      .find((candidate) => candidate.name === "agent_delegate");
    const parameters: unknown = definition?.parameters;
    if (
      !parameters ||
      typeof parameters !== "object" ||
      !("properties" in parameters) ||
      !parameters.properties ||
      typeof parameters.properties !== "object"
    ) {
      throw new Error("agent_delegate schema has no properties");
    }
    const properties = parameters.properties;
    if (!("profile_id" in properties)) {
      throw new Error("agent_delegate schema has no profile_id");
    }
    expect(properties.profile_id).toEqual({
      type: "string",
      enum: ["writer"],
    });
    expect(definition?.description).toContain(
      "writer (Writer; tools: chat_search_history)",
    );
    expect(definition?.description).not.toContain("private");

    const malformed = await owner.executeMainToolCall({
      name: "agent_delegate",
      args: { profile_id: "writer" },
      call_id: "malformed",
    });
    expect(JSON.parse(malformed.result)).toMatchObject({
      status: "error",
      errorCode: "invalid_arguments",
    });
    owner.close();
  });

  test("keeps the reserved result envelope through a normal second round", async () => {
    const requests: AgentProviderDispatchRequest[] = [];
    const queue = [
      response("", { finish_reason: "tool_use", tool_calls: toolCalls(1) }),
      response("done"),
    ];
    const owner = new AgentRuntimeOwner({
      generationId: "reservation-round",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })], AGENT_INVOCATION_DEFAULT, 2),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push(request);
        return queue.shift()!;
      },
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "settle the first result before continuing",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });

    expect(outcome).toMatchObject({
      outcome: "succeeded",
      content: "done",
      terminalReason: "completed",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toHaveLength(1);
    owner.close();
  });

  test("uses one tools-disabled finalization request at the tool budget", async () => {
    const finalizationRequests: AgentProviderDispatchRequest[] = [];
    const finalizationOwner = new AgentRuntimeOwner({
      generationId: "budget-final",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })], AGENT_INVOCATION_DEFAULT, 1),
      rootConnection: connection(),
      dispatch: async (request) => {
        finalizationRequests.push(request);
        return finalizationRequests.length === 1
          ? response("", { finish_reason: "tool_use", tool_calls: toolCalls(1) })
          : response("final");
      },
    });
    finalizationOwner.setSnapshot(snapshot());

    const completed = await finalizationOwner.invoke({
      profileId: "writer",
      task: "finish after one tool",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });
    expect(completed).toMatchObject({
      outcome: "succeeded",
      terminalReason: "completed_at_tool_budget",
    });
    expect(finalizationRequests).toHaveLength(2);
    expect(finalizationRequests[0]?.tools).toHaveLength(1);
    expect(finalizationRequests[1]?.tools).toBeUndefined();
    finalizationOwner.close();

    const violatingRequests: AgentProviderDispatchRequest[] = [];
    const violatingOwner = new AgentRuntimeOwner({
      generationId: "budget-final-violation",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })], AGENT_INVOCATION_DEFAULT, 1),
      rootConnection: connection(),
      dispatch: async (request) => {
        violatingRequests.push(request);
        return violatingRequests.length === 1
          ? response("", { finish_reason: "tool_use", tool_calls: toolCalls(1) })
          : response("", {
              finish_reason: "tool_use",
              tool_calls: toolCalls(1, 1),
            });
      },
    });
    violatingOwner.setSnapshot(snapshot());

    const violation = await violatingOwner.invoke({
      profileId: "writer",
      task: "do not execute a call during finalization",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });
    expect(violation).toMatchObject({
      outcome: "failed",
      errorCode: "tool_round_limit_exceeded",
    });
    expect(violatingRequests).toHaveLength(2);
    expect(violatingRequests[1]?.tools).toBeUndefined();
    expect(violatingOwner.summary?.toolCallCount).toBe(1);
    violatingOwner.close();
  });

  test("rejects a mixed semantic batch with ordered correlated codes and no effects", async () => {
    const events: AgentActivityEvent[] = [];
    const requests: AgentProviderDispatchRequest[] = [];
    const owner = new AgentRuntimeOwner({
      generationId: "mixed-batch",
      config: config([profile({
        toolIds: ["chat_search_history"],
        maxOutputTokens: 1_024,
      })], AGENT_INVOCATION_DEFAULT, 2),
      rootConnection: connection(),
      dispatch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? response("", {
              finish_reason: "tool_use",
              tool_calls: [
                {
                  name: "chat_search_history",
                  args: { query: 7 },
                  call_id: "invalid",
                },
                {
                  name: "chat_search_history",
                  args: { query: "valid" },
                  call_id: "valid",
                },
              ],
            })
          : response("done");
      },
      onActivity: (event) => events.push(event),
    });
    owner.setSnapshot(snapshot());

    const outcome = await owner.invoke({
      profileId: "writer",
      task: "reject the entire batch",
      kind: "deterministic",
      toolIds: ["chat_search_history"],
    });

    expect(outcome.outcome).toBe("succeeded");
    expect(events.filter((event) => event.toolName === "chat_search_history"))
      .toHaveLength(0);
    const resultMessage = [...(requests[1]?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    if (!resultMessage || typeof resultMessage.content === "string") {
      throw new Error("expected structured correlated tool results");
    }
    const resultParts = resultMessage.content.filter(
      (part): part is Extract<typeof part, { type: "tool_result" }> =>
        part.type === "tool_result",
    );
    const resultCodes = resultParts.map((part) => {
      const value: unknown = JSON.parse(part.content);
      if (!value || typeof value !== "object" || !("errorCode" in value)) {
        throw new Error("missing correlated error code");
      }
      return value.errorCode;
    });
    expect(resultCodes).toEqual(["invalid_arguments", "batch_rejected"]);
    owner.close();
  });

  test("does not expand rejected tasks and aborts timed-out expansion before dispatch", async () => {
    let dispatches = 0;
    let expansions = 0;
    const owner = new AgentRuntimeOwner({
      generationId: "lazy-task-admission",
      config: config([profile()], 1),
      rootConnection: connection(),
      dispatch: async () => {
        dispatches += 1;
        return response("done");
      },
    });
    await owner.invoke({
      profileId: "writer",
      task: "consume the only admission",
      kind: "deterministic",
    });
    await expect(owner.invoke({
      profileId: "writer",
      task: () => {
        expansions += 1;
        return "must not expand";
      },
      kind: "deterministic",
    })).rejects.toMatchObject({ code: "child_admission_limit_exceeded" });
    expect(expansions).toBe(0);
    expect(dispatches).toBe(1);
    owner.close();

    const pendingTimers: Array<() => void> = [];
    const timeoutOwner = new AgentRuntimeOwner({
      generationId: "lazy-task-timeout",
      config: config([profile({ timeoutMs: 1 })]),
      rootConnection: connection(),
      timeoutScheduler: {
        setTimeout(callback: () => void): AgentTimeoutHandle {
          pendingTimers.push(callback);
          return pendingTimers.length as unknown as AgentTimeoutHandle;
        },
        clearTimeout(): void {},
      },
      dispatch: async () => {
        throw new Error("provider must not run");
      },
    });
    let timedOutExpansion = 0;
    const pending = timeoutOwner.invoke({
      profileId: "writer",
      task: () => {
        timedOutExpansion += 1;
        return Promise.withResolvers<string>().promise;
      },
      kind: "deterministic",
    });
    expect(pendingTimers).toHaveLength(1);
    pendingTimers[0]!();
    await expect(pending).rejects.toMatchObject({ code: "profile_timeout" });
    expect(timedOutExpansion).toBe(1);
    timeoutOwner.close();
  });

  test("rejects an invalid ordinary sibling before executing the first agent call", async () => {
    const owner = new AgentRuntimeOwner({
      generationId: "root-batch-invalid-sibling",
      config: (() => {
        const value = config([], AGENT_INVOCATION_DEFAULT, 4);
        value.mainToolIds = ["chat_search_history"];
        return value;
      })(),
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    owner.setSnapshot(snapshot());
    const ordinaryDefinitions = new Map<string, ToolDefinition>([
      ["ordinary_tool", {
        name: "ordinary_tool",
        description: "ordinary",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
    ]);
    const plan = owner.planMainToolBatch(
      [
        {
          name: "chat_search_history",
          args: { query: "agent" },
          call_id: "agent-first",
        },
        {
          name: "ordinary_tool",
          args: { query: 7 },
          call_id: "ordinary-invalid",
        },
      ],
      { ordinaryDefinitions },
    );
    expect(plan.rejected).toBe(true);
    expect(plan.reservation).not.toBeNull();
    const executed: string[] = [];
    const results = plan.calls.map((call) => owner.buildMainToolBatchErrorResult(
      call,
      plan.semanticErrors.get(call.call_id)?.code ?? "batch_rejected",
    ));
    expect(executed).toEqual([]);
    expect(results.map((result) => JSON.parse(result.result).errorCode)).toEqual([
      "batch_rejected",
      "invalid_arguments",
    ]);
    for (let index = 0; index < results.length; index += 1) {
      expect(plan.reservation!.settleResult(
        index,
        Buffer.byteLength(results[index]!.result, "utf8"),
      )).toBe(true);
    }
    plan.reservation!.releaseToolPermits();
    plan.reservation!.release();
    owner.close();
  });

  test("rejects a whole batch at the zero/one aggregate-call boundary", () => {
    const value = config([], AGENT_INVOCATION_DEFAULT, 1);
    value.mainToolIds = ["chat_search_history"];
    const owner = new AgentRuntimeOwner({
      generationId: "root-batch-capacity-boundary",
      config: value,
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    owner.setSnapshot(snapshot());
    const plan = owner.planMainToolBatch([
      ...toolCalls(2),
    ]);
    expect(plan.reservation).toBeNull();
    expect(plan.failureCode).toBe("tool_call_limit_exceeded");
    owner.close();
  });

  test("executes a valid mixed root batch serially in provider order", async () => {
    const value = config([], AGENT_INVOCATION_DEFAULT, 4);
    value.mainToolIds = ["chat_search_history"];
    const owner = new AgentRuntimeOwner({
      generationId: "root-batch-serial-order",
      config: value,
      rootConnection: connection(),
      dispatch: async () => response("unused"),
    });
    owner.setSnapshot(snapshot());
    const ordinaryDefinitions = new Map<string, ToolDefinition>([
      ["ordinary_tool", {
        name: "ordinary_tool",
        description: "ordinary",
        parameters: { type: "object" },
      }],
    ]);
    const plan = owner.planMainToolBatch(
      [
        {
          name: "chat_search_history",
          args: { query: "agent" },
          call_id: "agent-first",
        },
        {
          name: "ordinary_tool",
          args: {},
          call_id: "ordinary-second",
        },
      ],
      { ordinaryDefinitions },
    );
    expect(plan.rejected).toBe(false);
    const order: string[] = [];
    const results = [];
    for (let index = 0; index < plan.calls.length; index += 1) {
      const result = plan.featureCallIndexes.includes(index)
        ? await owner.executePlannedMainToolCall(plan, index)
        : await owner.executePlannedOrdinaryToolCall(
            plan,
            index,
            async () => {
              order.push("ordinary");
              return {
                callId: plan.calls[index]!.call_id,
                qualifiedName: "ordinary_tool",
                toolName: "ordinary_tool",
                toolDisplayName: "ordinary",
                result: "ordinary-result",
              };
            },
          );
      if (plan.featureCallIndexes.includes(index)) order.push("agent");
      results.push(result);
      expect(plan.reservation!.settleResult(
        index,
        Buffer.byteLength(result.result, "utf8"),
      )).toBe(true);
    }
    expect(order).toEqual(["agent", "ordinary"]);
    expect(results.map((result) => result.callId)).toEqual([
      "agent-first",
      "ordinary-second",
    ]);
    plan.reservation!.releaseToolPermits();
    plan.reservation!.release();
    owner.close();
  });

});

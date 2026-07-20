import { describe, expect, test } from "bun:test";
import type { LlmMessageDTO } from "lumiverse-spindle-types";
import {
  FINAL_RESPONSE_CARRIER_FIELD,
  normalizeInterceptorFinalResponse,
  type NormalizeFinalResponseInput,
} from "./interceptor-final-response";
import {
  interceptorPipeline,
  type Interceptor,
  type InterceptorBreakdownEntry,
  type InterceptorResult,
} from "./interceptor-pipeline";
import { createInterceptorTerminalLease } from "./lifecycle";
import { createBoundHostContainmentFatal } from "./bound-generation";
import { brandHostGenerationId } from "./bound-generation-types";

type NormalizeFixture = Omit<
  NormalizeFinalResponseInput,
  "result" | "inputMessages" | "outputMessages" | "breakdown"
>;

const NORMALIZE_IDS: NormalizeFixture = {
  extensionId: "pipeline-test",
  extensionName: "Pipeline test",
  workerId: "worker-pipeline-test",
  registrationId: "registration-pipeline-test",
  callbackUserId: "user-pipeline-test",
  hostGeneration: "generation-pipeline-test",
  permissionGranted: true,
  permissionGuard: () => true,
};

function pipelineBreakdown(
  entries: readonly { messageIndex: number; name?: string }[],
  messages: readonly LlmMessageDTO[],
  extensionId: string,
): InterceptorBreakdownEntry[] {
  return entries.map((entry) => {
    const message = messages[entry.messageIndex];
    if (!message) throw new Error("test breakdown points outside messages");
    if (typeof message.content !== "string") {
      throw new Error("test breakdown requires text content");
    }
    return {
      messageIndex: entry.messageIndex,
      name: entry.name ?? extensionId,
      role: message.role,
      content: message.content,
      extensionId,
      extensionName: extensionId,
    };
  });
}

function normalizedResult(input: {
  extensionId: string;
  inputMessages: readonly LlmMessageDTO[];
  outputMessages: readonly LlmMessageDTO[];
  breakdown?: readonly { messageIndex: number; name?: string }[];
  result?: unknown;
  permissionGranted?: boolean;
  permissionGuard?: () => boolean;
}): InterceptorResult {
  const normalized = normalizeInterceptorFinalResponse({
    ...NORMALIZE_IDS,
    extensionId: input.extensionId,
    extensionName: input.extensionId,
    workerId: `worker-${input.extensionId}`,
    registrationId: `registration-${input.extensionId}`,
    result: input.result,
    inputMessages: input.inputMessages,
    outputMessages: input.outputMessages,
    breakdown: input.breakdown ?? [],
    permissionGranted: input.permissionGranted ?? true,
    permissionGuard: input.permissionGuard ?? (() => true),
  });
  const breakdown = pipelineBreakdown(
    normalized.breakdown,
    normalized.messages,
    input.extensionId,
  );
  return {
    messages: normalized.messages,
    ...(breakdown.length > 0 ? { breakdown } : {}),
    ...(normalized.finalResponse ? { finalResponseState: normalized.finalResponse } : {}),
  };
}

function validCandidate(
  inputMessages: readonly LlmMessageDTO[],
  extensionId: string,
  answer: string,
  fallback: string,
): InterceptorResult {
  const outputMessages = [...inputMessages, { role: "system" as const, content: fallback }];
  return normalizedResult({
    extensionId,
    inputMessages,
    outputMessages,
    breakdown: [{ messageIndex: outputMessages.length - 1, name: `${extensionId} fallback` }],
    result: { content: answer, fallbackMessageIndex: outputMessages.length - 1 },
  });
}

function ordinaryEdit(
  inputMessages: readonly LlmMessageDTO[],
  extensionId: string,
  content: string,
  result: unknown = undefined,
  permissionGranted = true,
): InterceptorResult {
  const carrierIndex = inputMessages.findIndex(
    (message) =>
      (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] !== undefined,
  );
  const insertionIndex = carrierIndex >= 0 ? carrierIndex : inputMessages.length;
  const outputMessages = [
    ...inputMessages.slice(0, insertionIndex),
    { role: "system" as const, content },
    ...inputMessages.slice(insertionIndex),
  ];
  return normalizedResult({
    extensionId,
    inputMessages,
    outputMessages,
    breakdown: [{ messageIndex: insertionIndex, name: `${extensionId} ordinary` }],
    result,
    permissionGranted,
  });
}

async function runWith(interceptors: readonly Interceptor[]): Promise<InterceptorResult> {
  const disposers = interceptors.map((interceptor) => interceptorPipeline.register(interceptor));
  try {
    return await interceptorPipeline.run(
      [{ role: "user", content: "pipeline input" }],
      { chatId: "pipeline-chat" },
      "user-pipeline-test",
    );
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
}
function trackedTerminalLease(extensionId: string, isRunSettled: () => boolean) {
  let releaseCount = 0;
  let releaseObservedBeforeSettlement = false;
  const lease = createInterceptorTerminalLease({
    registrationId: `${extensionId}-registration`,
    generationId: "generation-pipeline-test",
    callbackUserId: "user-pipeline-test",
    extensionId,
    extensionName: extensionId,
    onDispose: () => {
      releaseCount += 1;
      releaseObservedBeforeSettlement = !isRunSettled();
    },
  });
  return {
    lease,
    get releaseCount() {
      return releaseCount;
    },
    get releaseObservedBeforeSettlement() {
      return releaseObservedBeforeSettlement;
    },
  };
}


function carrierCount(messages: readonly LlmMessageDTO[]): number {
  return messages.filter(
    (message) =>
      (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] !== undefined,
  ).length;
}

describe("interceptor pipeline final-response folding", () => {
  test("accepts the first valid state and exposes exactly one protected carrier", async () => {
    const result = await runWith([
      {
        extensionId: "first-valid",
        extensionName: "First valid",
        priority: 1,
        handler: async (messages) => validCandidate(messages, "first-valid", "answer", "fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    expect(carrierCount(result.messages)).toBe(1);
    expect(result.messages.some((message) => message.content === "fallback")).toBe(true);
    expect("finalResponse" in result).toBe(false);
  });

  test("supersedes in registration order with one replacement and corrected breakdown", async () => {
    const result = await runWith([
      {
        extensionId: "first-winner",
        extensionName: "First winner",
        priority: 1,
        handler: async (messages) =>
          validCandidate(messages, "first-winner", "first answer", "first fallback"),
      },
      {
        extensionId: "second-winner",
        extensionName: "Second winner",
        priority: 2,
        handler: async (messages) =>
          validCandidate(messages, "second-winner", "second answer", "second fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("second-winner");
      expect(result.finalResponseState.supersededResponse?.extensionId).toBe("first-winner");
    }
    expect(carrierCount(result.messages)).toBe(1);
    expect(result.messages.some((message) => message.content === "first fallback")).toBe(false);
    expect(result.messages.some((message) => message.content === "second fallback")).toBe(true);
    expect(result.breakdown?.filter((entry) => entry.content === "second fallback")).toHaveLength(1);
    expect(result.breakdown?.some((entry) => entry.content === "first fallback")).toBe(false);
  });

  test("retains a valid winner across omitted, invalid, and unauthorized handlers", async () => {
    const result = await runWith([
      {
        extensionId: "retained-winner",
        extensionName: "Retained winner",
        priority: 1,
        handler: async (messages) =>
          validCandidate(messages, "retained-winner", "answer", "protected fallback"),
      },
      {
        extensionId: "omitted-edit",
        extensionName: "Omitted edit",
        priority: 2,
        handler: async (messages) => ordinaryEdit(messages, "omitted-edit", "omitted safe edit"),
      },
      {
        extensionId: "invalid-edit",
        extensionName: "Invalid edit",
        priority: 3,
        handler: async (messages) =>
          ordinaryEdit(messages, "invalid-edit", "invalid safe edit", { content: "", fallbackMessageIndex: -1 }),
      },
      {
        extensionId: "unauthorized-edit",
        extensionName: "Unauthorized edit",
        priority: 4,
        handler: async (messages) =>
          ordinaryEdit(
            messages,
            "unauthorized-edit",
            "unauthorized safe edit",
            { content: "answer", fallbackMessageIndex: messages.length },
            false,
          ),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("retained-winner");
    }
    expect(carrierCount(result.messages)).toBe(1);
    for (const content of ["omitted safe edit", "invalid safe edit", "unauthorized safe edit", "protected fallback"]) {
      expect(result.messages.some((message) => message.content === content)).toBe(true);
    }
  });

  test("discards modified or missing prior carriers instead of accepting unsafe output", async () => {
    let accepted: InterceptorResult | undefined;
    const modified = await runWith([
      {
        extensionId: "stable-before-modification",
        extensionName: "Stable before modification",
        priority: 1,
        handler: async (messages) => {
          accepted = validCandidate(messages, "stable-before-modification", "answer", "protected");
          return accepted;
        },
      },
      {
        extensionId: "modified-carrier",
        extensionName: "Modified carrier",
        priority: 2,
        handler: async (messages) => {
          const changed = messages.map((message) =>
            (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined
              ? message
              : { ...message, content: "tampered carrier" },
          );
          return { messages: [...changed, { role: "system", content: "unsafe edit" }] };
        },
      },
    ]);
    if (!accepted) throw new Error("first handler did not produce a result");
    expect(modified.messages).toEqual(accepted.messages);
    expect(modified.breakdown).toEqual(accepted.breakdown);
    expect(modified.finalResponseState).toBe(accepted.finalResponseState);
    expect(modified.messages.some((message) => message.content === "unsafe edit")).toBe(false);

    let acceptedMissing: InterceptorResult | undefined;
    const missing = await runWith([
      {
        extensionId: "stable-before-removal",
        extensionName: "Stable before removal",
        priority: 1,
        handler: async (messages) => {
          acceptedMissing = validCandidate(messages, "stable-before-removal", "answer", "protected");
          return acceptedMissing;
        },
      },
      {
        extensionId: "missing-carrier",
        extensionName: "Missing carrier",
        priority: 2,
        handler: async (messages) => ({
          messages: messages.filter(
            (message) =>
              (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined,
          ).concat({ role: "system", content: "unsafe missing-carrier edit" }),
        }),
      },
    ]);
    if (!acceptedMissing) throw new Error("first missing-carrier handler did not produce a result");
    expect(missing.messages).toEqual(acceptedMissing.messages);
    expect(missing.breakdown).toEqual(acceptedMissing.breakdown);
    expect(missing.finalResponseState).toBe(acceptedMissing.finalResponseState);
    expect(missing.messages.some((message) => message.content === "unsafe missing-carrier edit")).toBe(false);
  });

  test("retains the prior winner when a later valid supersession is structurally unsafe", async () => {
    let accepted: InterceptorResult | undefined;
    const result = await runWith([
      {
        extensionId: "structural-prior",
        extensionName: "Structural prior",
        priority: 1,
        handler: async (messages) => {
          accepted = validCandidate(messages, "structural-prior", "answer", "prior fallback");
          return accepted;
        },
      },
      {
        extensionId: "structural-next",
        extensionName: "Structural next",
        priority: 2,
        handler: async (messages) => {
          const changedInput = messages.map((message) =>
            (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined
              ? message
              : { ...message, content: "changed prior carrier" },
          );
          return normalizedResult({
            extensionId: "structural-next",
            inputMessages: changedInput,
            outputMessages: [...changedInput, { role: "system", content: "next fallback" }],
            breakdown: [{ messageIndex: changedInput.length, name: "next fallback" }],
            result: { content: "next answer", fallbackMessageIndex: changedInput.length },
          });
        },
      },
    ]);

    if (!accepted) throw new Error("structural prior handler did not produce a result");
    expect(result.messages).toEqual(accepted.messages);
    expect(result.breakdown).toEqual(accepted.breakdown);
    expect(result.finalResponseState).toBe(accepted.finalResponseState);
    expect(result.messages.some((message) => message.content === "next fallback")).toBe(false);
  });

  test("keeps rejected diagnostics until a later valid candidate appears", async () => {
    const result = await runWith([
      {
        extensionId: "invalid-first",
        extensionName: "Invalid first",
        priority: 1,
        handler: async (messages) =>
          normalizedResult({
            extensionId: "invalid-first",
            inputMessages: messages,
            outputMessages: messages,
            result: { content: "", fallbackMessageIndex: -1 },
          }),
      },
      {
        extensionId: "valid-later",
        extensionName: "Valid later",
        priority: 2,
        handler: async (messages) => validCandidate(messages, "valid-later", "answer", "later fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("valid-later");
    }
    expect(carrierCount(result.messages)).toBe(1);
  });

  test("leaves ordinary output unchanged when no handler returns a response state", async () => {
    const result = await runWith([
      {
        extensionId: "ordinary-only",
        extensionName: "Ordinary only",
        priority: 1,
        handler: async (messages) => ({
          messages: [...messages, { role: "system", content: "ordinary output" }],
        }),
      },
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "pipeline input" },
      { role: "system", content: "ordinary output" },
    ]);
    expect(result.finalResponseState).toBeUndefined();
  });
});

describe("interceptor pipeline containment fatal boundary", () => {
  test("releases every prior terminal lease before rethrowing the exact host fatal", async () => {
    const fatal = createBoundHostContainmentFatal({
      code: "BOUND_WORKER_CONTAINMENT_FAILED",
      message: "pipeline host containment fatal",
      hostGeneration: brandHostGenerationId("pipeline-host-generation"),
      workerId: "pipeline-worker",
      requestId: "pipeline-request",
    });
    let runSettled = false;
    const prior = trackedTerminalLease("pipeline-prior-lease", () => runSettled);
    const disposePrior = interceptorPipeline.register({
      extensionId: "pipeline-prior-lease",
      extensionName: "Pipeline prior lease",
      priority: 1,
      handler: async (messages) => ({
        messages,
        terminalLeases: [prior.lease],
      }),
    });
    const disposeFatal = interceptorPipeline.register({
      extensionId: "pipeline-fatal",
      extensionName: "Pipeline fatal",
      priority: 2,
      handler: async () => {
        throw fatal;
      },
    });

    try {
      const run = interceptorPipeline.run(
        [{ role: "user", content: "pipeline fatal input" }],
        { chatId: "pipeline-fatal-chat" },
        "user-pipeline-test",
      ).then(
        (result) => {
          runSettled = true;
          return { kind: "fulfilled" as const, result };
        },
        (error) => {
          runSettled = true;
          return { kind: "rejected" as const, error };
        },
      );
      const outcome = await run;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("pipeline unexpectedly fulfilled");
      expect(outcome.error).toBe(fatal);
      expect(prior.releaseCount).toBe(1);
      expect(prior.releaseObservedBeforeSettlement).toBe(true);
      expect(prior.lease.isActive()).toBe(false);
    } finally {
      disposeFatal();
      disposePrior();
      prior.lease.release();
    }
  });
});


describe("interceptor pipeline callback cancellation", () => {
  const synchronousLeaseAbortCases: readonly {
    id: string;
    description: string;
    later?: Pick<Interceptor, "userId" | "matcher">;
  }[] = [
    { id: "final-return", description: "with no later interceptor" },
    {
      id: "user-filter",
      description: "before a later user-skipped interceptor",
      later: { userId: "different-user" },
    },
    {
      id: "matcher-filter",
      description: "before a later matcher-skipped interceptor",
      later: { matcher: () => false },
    },
  ];

  async function expectSynchronousLeaseAbort(
    scenario: (typeof synchronousLeaseAbortCases)[number],
  ): Promise<void> {
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "lease input" }];
    const outer = new AbortController();
    const abortReason = new Error(`synchronous abort at ${scenario.id}`);
    let runSettled = false;
    let laterInvoked = false;
    const tracked = trackedTerminalLease(
      `synchronous-lease-${scenario.id}`,
      () => runSettled,
    );
    const disposeA = interceptorPipeline.register({
      extensionId: `synchronous-lease-${scenario.id}-a`,
      extensionName: "Interceptor A",
      priority: 1,
      handler: async (messages) => {
        outer.abort(abortReason);
        return { messages, terminalLeases: [tracked.lease] };
      },
    });
    const disposeLater = scenario.later
      ? interceptorPipeline.register({
          extensionId: `synchronous-lease-${scenario.id}-later`,
          extensionName: "Skipped interceptor",
          priority: 2,
          ...scenario.later,
          handler: async (messages) => {
            laterInvoked = true;
            return { messages };
          },
        })
      : undefined;
    try {
      const runOutcome = interceptorPipeline.run(
        inputMessages,
        { chatId: `synchronous-lease-${scenario.id}` },
        "user-pipeline-test",
        outer.signal,
      ).then(
        (result) => {
          runSettled = true;
          return { kind: "fulfilled" as const, result };
        },
        (error) => {
          runSettled = true;
          return { kind: "rejected" as const, error };
        },
      );
      const outcome = await runOutcome;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("pipeline unexpectedly fulfilled");
      expect(outcome.error).toBe(abortReason);
      expect(outer.signal.aborted).toBe(true);
      expect(outer.signal.reason).toBe(abortReason);
      expect(laterInvoked).toBe(false);
      expect(tracked.releaseCount).toBe(1);
      expect(tracked.releaseObservedBeforeSettlement).toBe(true);
      expect(tracked.lease.isActive()).toBe(false);

      tracked.lease.release();
      tracked.lease.release();
      expect(tracked.releaseCount).toBe(1);
    } finally {
      disposeLater?.();
      disposeA();
    }
  }

  for (const scenario of synchronousLeaseAbortCases) {
    test(`rejects ${scenario.description} after a lease-producing interceptor aborts`, () =>
      expectSynchronousLeaseAbort(scenario));
  }

  test("aborts the prepared signal before timeout settles and ignores a late handler result", async () => {
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "timeout input" }];
    let callbackSignal: AbortSignal | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveLate: ((result: InterceptorResult) => void) | undefined;
    const lateResult = new Promise<InterceptorResult>((resolve) => {
      resolveLate = resolve;
    });
    let runSettled = false;
    let abortObservedBeforeRunSettled = false;
    let resolveAborted: ((reason: unknown) => void) | undefined;
    const callbackAborted = new Promise<unknown>((resolve) => {
      resolveAborted = resolve;
    });
    const dispose = interceptorPipeline.register({
      extensionId: "timeout-callback",
      extensionName: "Timeout callback",
      priority: 1,
      resolveTimeoutMs: () => 5,
      contextPreparer: (_context, signal) => {
        if (!signal) throw new Error("test callback signal was not prepared");
        callbackSignal = signal;
        signal.addEventListener(
          "abort",
          () => {
            abortObservedBeforeRunSettled = !runSettled;
            resolveAborted?.(signal.reason);
          },
          { once: true },
        );
        return {};
      },
      handler: async () => {
        resolveStarted?.();
        return lateResult;
      },
    });
    try {
      const run = interceptorPipeline.run(
        inputMessages,
        { chatId: "timeout-chat" },
        "user-pipeline-test",
      ).then(
        (result) => {
          runSettled = true;
          return result;
        },
        (error) => {
          runSettled = true;
          throw error;
        },
      );
      await started;
      const timeoutReason = await callbackAborted;
      expect(callbackSignal).toBeDefined();
      expect(callbackSignal?.aborted).toBe(true);
      expect(callbackSignal?.reason).toBe(timeoutReason);
      expect(timeoutReason).toBeInstanceOf(Error);
      expect(abortObservedBeforeRunSettled).toBe(true);

      const result = await run;
      expect(runSettled).toBe(true);
      expect(result.messages).toEqual(inputMessages);

      resolveLate?.({
        messages: [...inputMessages, { role: "system", content: "late output" }],
      });
      await lateResult;
      expect(result.messages).toEqual(inputMessages);
    } finally {
      dispose();
    }
  });

  test("does not abort a successful callback before its result is reconciled", async () => {
    let callbackSignal: AbortSignal | undefined;
    let handlerSawAbort = true;
    const dispose = interceptorPipeline.register({
      extensionId: "successful-callback",
      extensionName: "Successful callback",
      priority: 1,
      resolveTimeoutMs: () => 100,
      contextPreparer: (_context, signal) => {
        callbackSignal = signal;
        return {};
      },
      handler: async (messages) => {
        handlerSawAbort = callbackSignal?.aborted ?? true;
        return { messages: [...messages, { role: "system", content: "successful output" }] };
      },
    });
    try {
      const result = await interceptorPipeline.run(
        [{ role: "user", content: "success input" }],
        { chatId: "success-chat" },
        "user-pipeline-test",
      );
      expect(handlerSawAbort).toBe(false);
      expect(callbackSignal).toBeDefined();
      expect(callbackSignal?.aborted).toBe(false);
      expect(result.messages).toEqual([
        { role: "user", content: "success input" },
        { role: "system", content: "successful output" },
      ]);
    } finally {
      dispose();
    }
  });

  test("isolates callback signals across concurrent runs", async () => {
    type RunContext = { chatId: string; runId: "first" | "second" };
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "concurrent input" }];
    const firstOuter = new AbortController();
    const secondOuter = new AbortController();
    const prepared = new Map<RunContext["runId"], AbortSignal>();
    const releaseHandlers = new Map<
      RunContext["runId"],
      (result: InterceptorResult) => void
    >();
    const preparedPromises = new Map<
      RunContext["runId"],
      Promise<void>
    >();
    const resolvePrepared = new Map<
      RunContext["runId"],
      () => void
    >();
    for (const runId of ["first", "second"] as const) {
      preparedPromises.set(
        runId,
        new Promise<void>((resolve) => resolvePrepared.set(runId, resolve)),
      );
    }
    const dispose = interceptorPipeline.register({
      extensionId: "concurrent-callbacks",
      extensionName: "Concurrent callbacks",
      priority: 1,
      resolveTimeoutMs: () => 1_000,
      contextPreparer: (context, signal) => {
        const runId = (context as RunContext).runId;
        prepared.set(runId, signal!);
        resolvePrepared.get(runId)?.();
        return context;
      },
      handler: async (_messages, context) => {
        const runId = (context as RunContext).runId;
        return new Promise<InterceptorResult>((resolve) => {
          releaseHandlers.set(runId, (result) => resolve(result));
        });
      },
    });
    try {
      const firstRun = interceptorPipeline.run(
        inputMessages,
        { chatId: "first-chat", runId: "first" },
        "user-pipeline-test",
        firstOuter.signal,
      ).then(
        () => undefined,
        (error) => error,
      );
      const secondRun = interceptorPipeline.run(
        inputMessages,
        { chatId: "second-chat", runId: "second" },
        "user-pipeline-test",
        secondOuter.signal,
      );
      await Promise.all([
        preparedPromises.get("first"),
        preparedPromises.get("second"),
      ]);
      const firstSignal = prepared.get("first");
      const secondSignal = prepared.get("second");
      expect(firstSignal).toBeDefined();
      expect(secondSignal).toBeDefined();
      const firstReason = new Error("first run aborted");
      firstOuter.abort(firstReason);
      expect(firstSignal?.aborted).toBe(true);
      expect(firstSignal?.reason).toBe(firstReason);
      expect(secondSignal?.aborted).toBe(false);

      releaseHandlers.get("second")?.({
        messages: [...inputMessages, { role: "system", content: "second output" }],
      });
      const secondResult = await secondRun;
      expect(secondResult.messages).toEqual([
        ...inputMessages,
        { role: "system", content: "second output" },
      ]);
      expect(secondSignal?.aborted).toBe(false);

      expect(await firstRun).toBe(firstReason);
      releaseHandlers.get("first")?.({ messages: inputMessages });
    } finally {
      dispose();
    }
  });

  test("releases an earlier terminal lease when the outer run aborts during a pending interceptor", async () => {
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "lease input" }];
    const outer = new AbortController();
    let bSignal: AbortSignal | undefined;
    let resolvePrepared: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      resolvePrepared = resolve;
    });
    let resolveLate: ((result: InterceptorResult) => void) | undefined;
    const lateResult = new Promise<InterceptorResult>((resolve) => {
      resolveLate = resolve;
    });
    let resolveLateHandler: (() => void) | undefined;
    const lateHandlerCompleted = new Promise<void>((resolve) => {
      resolveLateHandler = resolve;
    });
    let releaseCount = 0;
    let runSettled = false;
    let releaseObservedBeforeSettlement = false;
    let lateOutputAccepted = false;
    const lease = createInterceptorTerminalLease({
      registrationId: "interceptor-a-registration",
      generationId: "generation-pipeline-test",
      callbackUserId: "user-pipeline-test",
      extensionId: "interceptor-a",
      extensionName: "Interceptor A",
      onDispose: () => {
        releaseCount += 1;
        releaseObservedBeforeSettlement = !runSettled;
      },
    });
    const disposeA = interceptorPipeline.register({
      extensionId: "interceptor-a",
      extensionName: "Interceptor A",
      priority: 1,
      handler: async (messages) => ({
        messages,
        terminalLeases: [lease],
      }),
    });
    const disposeB = interceptorPipeline.register({
      extensionId: "interceptor-b",
      extensionName: "Interceptor B",
      priority: 2,
      contextPreparer: (_context, signal) => {
        if (!signal) throw new Error("test callback signal was not prepared");
        bSignal = signal;
        resolvePrepared?.();
        return {};
      },
      handler: async () => {
        const result = await lateResult;
        resolveLateHandler?.();
        return result;
      },
    });
    try {
      const runOutcome = interceptorPipeline.run(
        inputMessages,
        { chatId: "lease-abort-chat" },
        "user-pipeline-test",
        outer.signal,
      ).then(
        (result) => {
          runSettled = true;
          return { kind: "fulfilled" as const, result };
        },
        (error) => {
          runSettled = true;
          return { kind: "rejected" as const, error };
        },
      );
      await prepared;
      expect(bSignal).toBeDefined();
      expect(bSignal?.aborted).toBe(false);

      const abortReason = new Error("outer abort during interceptor B");
      outer.abort(abortReason);
      expect(bSignal?.aborted).toBe(true);
      expect(bSignal?.reason).toBe(abortReason);

      const outcome = await runOutcome;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("pipeline unexpectedly fulfilled");
      expect(outcome.error).toBe(abortReason);
      expect(releaseCount).toBe(1);
      expect(releaseObservedBeforeSettlement).toBe(true);
      expect(lease.isActive()).toBe(false);

      const lateOutput: InterceptorResult = {
        get messages() {
          lateOutputAccepted = true;
          return [...inputMessages, { role: "system" as const, content: "late output" }];
        },
      };
      resolveLate?.(lateOutput);
      await lateHandlerCompleted;
      expect(outcome.kind).toBe("rejected");
      expect(lateOutputAccepted).toBe(false);
      expect(releaseCount).toBe(1);
      lease.release();
      lease.release();
      expect(releaseCount).toBe(1);
    } finally {
      disposeB();
      disposeA();
    }
  });

});
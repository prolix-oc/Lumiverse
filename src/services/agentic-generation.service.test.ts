import { describe, expect, test } from "bun:test";
import {
  runAgenticGeneration,
  requestAgenticGenerationCancellation,
  requestAgenticChatCancellation,
  AgenticGenerationError,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { AssemblyPlanV1 } from "./agentic-assembly-compiler";
import type { GenerationAssemblySnapshotV1, InputRevisionSetV1Local } from "./prompt-assembly-snapshot.service";

const TEST_REVISIONS: InputRevisionSetV1Local = Object.freeze({
  version: 1, revisions: [], digest: "test-revisions", entries: [],
  target: [], chat: [], messages: [], preset: [], blocks: [], config: [], slotBinding: [],
  connection: [], endpoint: [], credential: [], participants: [], worldLore: [], databank: [], settings: [],
  variables: [], regex: [], cognition: [], readiness: [],
});

function snapshotFixture(target: AgenticTargetSnapshot): GenerationAssemblySnapshotV1 {
  return {
    version: 1,
    assemblySurface: "WORK",
    snapshotId: "snapshot-test",
    userId: "user-1",
    generationId: "generation-test",
    chatId: "chat-1",
    target: {
      generationType: target.generationType,
      messageId: target.messageId ?? null,
      swipeId: target.swipeId ?? null,
      continueMessageId: null,
      excludedMessageId: null,
      userInput: "",
    },
    chat: { id: "chat-1", character_id: null, name: "Test", created_at: 0, updated_at: 0, metadata: {}, revision: "1" },
    messages: [],
    preset: null,
    blocks: [],
    participants: { persona: null, character: { id: "character-1" }, group: [], availabilityRevision: "1" },
    variables: { preset: {}, chat: {}, settings: {}, revision: "1" },
    regexScripts: [],
    worldInfo: { books: [], entries: [], candidates: [], state: {} },
    agentCognition: {
      schema: "present", cognitionGraph: null, cognitionSource: null, revision: "1",
    },
    availability: { participantIds: [], toolIds: [], extensionsExcluded: true, ambientSpindleExcluded: true, revision: "1" },
    connection: null,
    agentConfig: null,
    limits: HOST_PREPARATION_LIMITS_V1,
    inputRevisionSet: TEST_REVISIONS,
    revisions: TEST_REVISIONS,
    extensionData: null,
    ambientSpindleData: null,
  };
}

function planFixture(snapshot: GenerationAssemblySnapshotV1): AssemblyPlanV1 {
  const messages: AssemblyPlanV1["messages"] = [];
  return {
    version: 1,
    operation: "compile_agent_assembly",
    assemblySurface: "WORK",
    requestId: "request-test",
    limits: snapshot.limits,
    providerMessages: messages,
    messages,
    children: [],
    childDescriptors: [],
    resultSlots: [],
    activationEvidence: [],
    tokenEvidence: [],
    profileOutputLimits: [],
    seals: [],
    privateEvidence: { activation: [], cognition: [], token: {}, inputRevisionDigest: snapshot.inputRevisionSet.digest },
    deferredDeltas: [],
    deltas: [],
    inputRevisions: snapshot.inputRevisionSet,
    inputRevisionSet: snapshot.inputRevisionSet,
    workPolicyMessages: [],
    customPhasePlan: { status: "ready", phases: [], issues: [], omittedPhaseIds: [] },
    workspaceUsageMessages: [],
    completionCriteriaMessages: [],
    renderPolicyMessages: [],
    loomPolicy: { version: 1, workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
    loomBlocks: [],
    snapshotId: snapshot.snapshotId,
  };
}


function input(overrides: Partial<AgenticGenerationInput> = {}): AgenticGenerationInput {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationType: "normal",
    ...overrides,
  };
}

function dependencies(log: string[], overrides: Partial<AgenticGenerationDependencies> = {}): AgenticGenerationDependencies {
  return {
    resolveRuntime: async () => ({ mode: "agentic", inputRevisions: { chat: 1 } }),
    createExecution: ({ executionId }) => ({ id: executionId }),
    requestCancellation: () => true,
    buildAssemblySnapshot: async (_input, _decision, target) => snapshotFixture(target),
    compileAssemblyPlan: async (snapshot) => planFixture(snapshot),
    runWork: async () => ({ status: "completed", summary: "done", workspace: {} }),
    render: async () => ({ content: "rendered" }),
    prepareRender: async ({ render }) => ({ content: render.content }),
    commit: async () => ({ receiptId: "receipt-1" }),
    transitionExecution: (_execution, _from, to) => { log.push(to); },
    publishTerminal: (event) => { log.push(`terminal:${event.status}`); },
    cleanup: () => { log.push("cleanup"); },
    ...overrides,
  };
}

async function settle(generationId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await import("./agentic-generation.service").then((module) => module.waitForAgenticGeneration(generationId));
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Agentic generation did not settle");
}

describe("agentic generation orchestration", () => {
  test("keeps internal execution chronology separate from canonical public phases for all targets", async () => {
    for (const generationType of ["normal", "continue", "regenerate", "swipe"] as const) {
      const log: string[] = [];
      const publicPhases: string[] = [];
      const started = await runAgenticGeneration(input({ generationType }), dependencies(log, {
        publishPhase: (event) => { publicPhases.push(event.workPhase ?? "missing"); },
      }));
      expect(started.status).toBe("streaming");
      const result = await settle(started.generationId) as { status: string; phase: string; receipt?: { receiptId: string } };
      expect(result.status).toBe("completed");
      expect(result.phase).toBe("COMMITTED");
      expect(result.receipt?.receiptId).toBe("receipt-1");
      expect(log).toEqual(["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "terminal:completed", "cleanup"]);
      expect(publicPhases).toEqual(["ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT"]);
    }
  });
  test("publishes completed orchestration without a failure reason", async () => {
    let terminalReason: string | null | undefined;
    const started = await runAgenticGeneration(input(), dependencies([], {
      publishTerminal: (event) => {
        terminalReason = event.reason;
      },
    }));
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("completed");
    expect(terminalReason).toBeNull();
  });


  test("does not dispatch provider work or mutate through commit when preflight fails", async () => {
    const calls: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(calls, {
      buildAssemblySnapshot: async () => { calls.push("snapshot"); throw new Error("invalid_input"); },
      runWork: async () => { calls.push("work"); return { status: "completed" }; },
      commit: async () => { calls.push("commit"); return { receiptId: "never" }; },
    }));
    const result = await settle(started.generationId) as { status: string; errorCode: string };
    expect(result.status).toBe("rejected");
    expect(result.errorCode).toBe("agentic_preflight_failed");
    expect(calls).toEqual(["snapshot", "FAILED", "terminal:rejected", "cleanup"]);
  });

  test("publishes an ASSEMBLE revision rejection only through the terminal owner", async () => {
    const phaseEvents: string[] = [];
    const terminalEvents: Array<{
      status: string;
      phase: string;
      workOutcome?: string | null;
      errorCode?: string;
    }> = [];
    let durablePhase: "ASSEMBLE" | "FAILED" = "ASSEMBLE";
    const started = await runAgenticGeneration(input(), dependencies([], {
      buildAssemblySnapshot: async () => {
        throw new AgenticGenerationError(
          "agentic_revision_conflict",
          "stale_input_revision",
          { phase: "ASSEMBLE", retryable: true },
        );
      },
      transitionExecution: (execution, from, to, reason) => {
        expect(from).toBe("ASSEMBLE");
        expect(to).toBe("FAILED");
        expect(reason).toBe("invalid_input");
        durablePhase = "FAILED";
        return { ...execution, phase: to };
      },
      readExecutionPhase: () => durablePhase,
      publishPhase: (event) => { phaseEvents.push(event.phase); },
      publishTerminal: (event) => {
        terminalEvents.push({
          status: event.status,
          phase: event.phase,
          workOutcome: event.workOutcome,
          errorCode: event.errorCode,
        });
      },
    }));

    const result = await settle(started.generationId) as {
      status: string;
      phase: string;
      workOutcome: string | null;
      errorCode?: string;
    };
    expect(result).toMatchObject({
      status: "rejected",
      phase: "FAILED",
      workOutcome: "rejected",
      errorCode: "agentic_revision_conflict",
    });
    expect(phaseEvents).toEqual(["ASSEMBLE"]);
    expect(terminalEvents).toEqual([{
      status: "rejected",
      phase: "FAILED",
      workOutcome: "rejected",
      errorCode: "agentic_revision_conflict",
    }]);
  });

  test("uses internal resolution when UI did not provide a token", async () => {
    let resolved = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      resolveRuntime: async () => { resolved += 1; return { mode: "agentic" }; },
    }));
    await settle(started.generationId);
    expect(resolved).toBe(1);
  });
  test("rejects unsupported surfaces without calling decision or provider", async () => {
    let calls = 0;
    await expect(runAgenticGeneration(input({ generationType: "impersonate" }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isImpersonate: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isGroupChat: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isGroupChat: 1 }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    expect(calls).toBe(0);
    await expect(runAgenticGeneration(input({ regenFeedback: "try again" }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
    await expect(runAgenticGeneration(input({ isDryRun: true }), dependencies([], {
      resolveRuntime: async () => { calls += 1; return { mode: "agentic" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });
  });
  test("burns a presented token before rejecting an unsupported surface", async () => {
    const calls: string[] = [];
    await expect(runAgenticGeneration(input({
      generationType: "impersonate",
      runtimeDecisionToken: "runtime-token",
    }), dependencies([], {
      claimRuntimeToken: (_input, token) => { calls.push(`claim:${token}`); },
      consumeRuntimeToken: async () => { calls.push("consume"); return { mode: "agentic" }; },
      resolveRuntime: async () => { calls.push("resolve"); return { mode: "agentic" }; },
      createExecution: ({ executionId }) => { calls.push("execution"); return { id: executionId }; },
      runWork: async () => { calls.push("work"); return { status: "completed" }; },
    }))).rejects.toMatchObject({ code: "agentic_unsupported_surface" });

    expect(calls).toEqual(["claim:runtime-token"]);
  });

  test("does not reject a non-impersonation Agentic request", async () => {
    let resolved = 0;
    const started = await runAgenticGeneration(input({ isImpersonate: false }), dependencies([], {
      resolveRuntime: async () => {
        resolved += 1;
        return { mode: "agentic" };
      },
    }));
    await settle(started.generationId);
    expect(resolved).toBe(1);
  });

  test("root Stop is idempotent and prevents downstream dispatch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markExecutionCreated!: () => void;
    const executionCreated = new Promise<void>((resolve) => { markExecutionCreated = resolve; });
    let cancellationCalls = 0;
    const calls: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(calls, {
      createExecution: ({ executionId }) => {
        markExecutionCreated();
        return { id: executionId };
      },
      requestCancellation: () => {
        cancellationCalls += 1;
        return cancellationCalls === 1;
      },
      buildAssemblySnapshot: async (_input, _decision, target) => { await blocked; return snapshotFixture(target); },
    }));
    await executionCreated;
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe(true);
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe(false);
    release();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("cancelled");
    expect(calls).not.toContain("WORK");
  });

  test("user Stop wins the WORK durable CAS before aborting the controller", async () => {
    let markWorkEntered!: () => void;
    const workEntered = new Promise<void>((resolve) => { markWorkEntered = resolve; });
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    let workSignal!: AbortSignal;
    let cancellationCalls = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      runWork: async ({ signal }) => {
        workSignal = signal;
        markWorkEntered();
        await workGate;
        return { status: "completed", summary: "done", workspace: {} };
      },
      requestCancellation: (_execution, reason) => {
        cancellationCalls += 1;
        expect(reason).toBe("stopped");
        expect(workSignal.aborted).toBe(false);
        return true;
      },
    }));
    await workEntered;
    expect(await requestAgenticChatCancellation("user-1", "chat-1")).toBe(true);
    expect(cancellationCalls).toBe(1);
    expect(workSignal.aborted).toBe(true);
    releaseWork();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("cancelled");
  });

  test("Stop returns the durable too_late result without aborting once COMMITTING begins", async () => {
    let markCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => { markCommitEntered = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let commitSignal!: AbortSignal;
    let cancellationCalls = 0;
    const started = await runAgenticGeneration(input(), dependencies([], {
      commit: async ({ signal }) => {
        commitSignal = signal;
        markCommitEntered();
        await commitGate;
        return { receiptId: "receipt-commit" };
      },
      requestCancellation: () => {
        cancellationCalls += 1;
        return "too_late";
      },
    }));
    await commitEntered;
    expect(await requestAgenticGenerationCancellation("user-1", started.generationId)).toBe("too_late");
    expect(cancellationCalls).toBe(1);
    expect(commitSignal.aborted).toBe(false);
    releaseCommit();
    const result = await settle(started.generationId) as { status: string };
    expect(result.status).toBe("completed");
  });
  test("preserves a committed turn when post-commit reconciliation throws", async () => {
    const log: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(log, {
      createExecution: ({ executionId }) => ({ id: executionId, deadlineAt: Date.now() + 100 }),
      commit: async () => {
        throw new Error("agentic_commit_failed");
      },
      readExecutionPhase: () => "COMMITTED",
      publishTerminal: (event) => {
        log.push(`terminal:${event.status}:${event.phase}`);
      },
    }));
    const result = await settle(started.generationId) as {
      status: string;
      phase: string;
      errorCode?: string;
      retryable?: boolean;
    };
    expect(result).toMatchObject({
      status: "completed",
      phase: "COMMITTED",
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.retryable).toBeUndefined();
    expect(log).toContain("terminal:completed:COMMITTED");
  });

  test("recomputes the terminal result from a durable CAS winner", async () => {
    let transitionAttempted = false;
    const started = await runAgenticGeneration(input(), dependencies([], {
      runWork: async () => ({ status: "failed", errorCode: "child_provider_error" }),
      readExecutionPhase: () => transitionAttempted ? "TIMED_OUT" : "WORK",
      transitionExecution: (_execution, _from, next) => {
        if (next === "FAILED") {
          transitionAttempted = true;
          throw new Error("execution_cas_lost");
        }
      },
    }));
    const result = await settle(started.generationId) as {
      status: string;
      phase: string;
      workOutcome: string;
      errorCode?: string;
    };
    expect(result).toMatchObject({
      status: "timed_out",
      phase: "TIMED_OUT",
      workOutcome: "failed",
      errorCode: "agentic_timed_out",
    });
  });
  test("bounds terminal child joining at the execution deadline", async () => {
    const log: string[] = [];
    const started = await runAgenticGeneration(input(), dependencies(log, {
      createExecution: ({ executionId }) => ({ id: executionId, deadlineAt: Date.now() + 15 }),
      runWork: async () => ({ status: "failed", errorCode: "child_provider_error" }),
      cancelAndJoinChildren: () => new Promise<void>(() => undefined),
    }));
    const result = await settle(started.generationId) as {
      status: string;
      phase: string;
      errorCode?: string;
    };
    expect(result).toMatchObject({
      status: "failed",
      phase: "FAILED",
      errorCode: "agentic_internal_error",
    });
    expect(log).toContain("cleanup");
  });

  test("terminal convergence failure does not invent a projection cause for committed success", async () => {
    const started = await runAgenticGeneration(input(), dependencies([], {
      publishTerminal: () => {
        throw new Error("projection schema failure");
      },
    }));
    const result = await settle(started.generationId) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "completed",
      phase: "COMMITTED",
      workOutcome: "completed",
    });
    expect(result).not.toHaveProperty("errorCode", "projection_unavailable");
    expect(result).not.toHaveProperty("reason", "reconciliation_required");
  });

  test("terminal convergence failure preserves each durable noncommit cause", async () => {
    const cases = [
      { status: "timed_out", phase: "TIMED_OUT", code: "agentic_timed_out", outcome: "failed" },
      { status: "cancelled", phase: "CANCELLED", code: "agentic_cancelled", outcome: "stopped" },
      { status: "exhausted", phase: "EXHAUSTED", code: "agentic_work_exhausted", outcome: "exhausted" },
    ] as const;
    for (const terminalCase of cases) {
      const started = await runAgenticGeneration(input(), dependencies([], {
        readExecutionPhase: () => terminalCase.phase,
        runWork: async () => ({ status: terminalCase.status, errorCode: terminalCase.code }),
        publishTerminal: () => {
          throw new Error("projection schema failure");
        },
      }));
      const result = await settle(started.generationId) as Record<string, unknown>;
      expect(result).toMatchObject({
        status: terminalCase.status,
        phase: terminalCase.phase,
        workOutcome: terminalCase.outcome,
        errorCode: terminalCase.code,
      });
      expect(result.errorCode).not.toBe("projection_unavailable");
    }
  });

  test("refused retry admission does not publish a phantom attempt", async () => {
    const { retryAgenticGeneration } = await import("./agentic-generation.service");
    const events: string[] = [];
    const retryDeps = dependencies(events, {
      resolveRuntime: async () => ({ mode: "agentic" as const }),
      createExecution: () => {
        throw new Error("agentic_target_unsupported");
      },
      publishTerminal: () => { events.push("terminal"); },
    });
    await expect(retryAgenticGeneration(input({ generationType: "normal" }), "attempt-previous", retryDeps))
      .rejects.toThrow("agentic_target_unsupported");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContain("terminal");
  });

  test("pre-execution decision_refresh_required skips FAILED phase publish and keeps the typed code", async () => {
    const calls: string[] = [];
    const terminals: Array<{ errorCode?: string; errorMessage?: string; status: string }> = [];
    const started = await runAgenticGeneration(input({ runtimeDecisionToken: "tok" }), dependencies(calls, {
      consumeRuntimeToken: async () => {
        throw new AgenticGenerationError(
          "decision_refresh_required",
          "decision_refresh_required: input_revision_digest",
          { phase: "ASSEMBLE", retryable: true },
        );
      },
      createExecution: () => {
        calls.push("create");
        return { id: "never" };
      },
      publishPhase: () => {
        calls.push("phase");
        throw new Error("FOREIGN KEY constraint failed");
      },
      publishTerminal: (event) => {
        terminals.push({
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          status: event.status,
        });
        calls.push(`terminal:${event.status}`);
      },
    }));
    const result = await settle(started.generationId) as {
      status: string;
      errorCode: string;
      errorMessage?: string;
    };
    expect(result.status).toBe("rejected");
    expect(result.errorCode).toBe("decision_refresh_required");
    expect(result.errorMessage).toBe("decision_refresh_required: input_revision_digest");
    expect(terminals).toEqual([{
      errorCode: "decision_refresh_required",
      errorMessage: "decision_refresh_required: input_revision_digest",
      status: "rejected",
    }]);
    expect(calls).toEqual(["terminal:rejected", "cleanup"]);
  });

  test("keeps a stale-decision rejection canonical when the durable FAILED CAS already won", async () => {
    let durablePhase = "ASSEMBLE";
    let terminal: {
      status: string;
      phase: string;
      workOutcome?: string | null;
      reason?: string | null;
      errorCode?: string;
    } | undefined;
    const started = await runAgenticGeneration(input(), dependencies([], {
      buildAssemblySnapshot: async () => {
        throw new AgenticGenerationError(
          "decision_refresh_required",
          "decision_refresh_required: runtime_policy",
          { phase: "ASSEMBLE", retryable: true },
        );
      },
      readExecutionPhase: () => durablePhase as "ASSEMBLE" | "FAILED",
      transitionExecution: (_execution, _from, to) => {
        if (to === "FAILED") {
          durablePhase = "FAILED";
          throw new AgenticGenerationError(
            "agentic_internal_error",
            "terminal CAS already settled",
            { phase: "FAILED" },
          );
        }
      },
      publishTerminal: (event) => {
        terminal = event;
      },
    }));
    const result = await settle(started.generationId) as {
      status: string;
      phase: string;
      workOutcome: string | null;
      reason: string | null;
      errorCode?: string;
    };
    expect(result).toMatchObject({
      status: "rejected",
      phase: "FAILED",
      workOutcome: "rejected",
      reason: "decision_refresh_required",
      errorCode: "decision_refresh_required",
    });
    expect(terminal).toMatchObject({
      status: "rejected",
      phase: "FAILED",
      workOutcome: "rejected",
      reason: "decision_refresh_required",
      errorCode: "decision_refresh_required",
    });
  });
});

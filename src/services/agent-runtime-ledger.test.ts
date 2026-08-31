import { describe, expect, test } from "bun:test";
import type { AgentAuthorizationSnapshot, AgentConfigV2 } from "../types/agents";
import { AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES } from "./agent-runtime-accounting";
import { AgentRuntimeAdmissionManager } from "./agent-runtime-admission";
import { AgentTurnLedger } from "./agent-runtime-ledger";
import { AGENT_HOST_DEFAULT_LIMITS } from "./agent-runtime-limits";

const authorization: AgentAuthorizationSnapshot = {
  rootUserId: "u1",
  mainToolIds: [],
  mainLoreScope: "active",
  profileGrants: {},
};
const config: AgentConfigV2 = {
  version: 2,
  agentsEnabled: true,
  allowedModes: ["response"],
  defaultMode: "response",
  maxInvocations: 2,
  maxToolCalls: 2,
  mainToolIds: [],
  mainLoreScope: "active",
  profiles: [],
  connectionSlots: [],
};

function create(overrides: Partial<typeof AGENT_HOST_DEFAULT_LIMITS> = {}) {
  const limits = { ...AGENT_HOST_DEFAULT_LIMITS, ...overrides };
  const admission = new AgentRuntimeAdmissionManager(limits);
  return {
    admission,
    ledger: new AgentTurnLedger({
      generationId: crypto.randomUUID(),
      config,
      authorization,
      limits,
      admission,
    }),
  };
}

describe("agent turn ledger", () => {
  test("charges authored child and aggregate tool attempts exactly", () => {
    const { ledger } = create();
    expect(ledger.chargeChildAdmission()).toBe(true);
    expect(ledger.chargeChildAdmission()).toBe(true);
    expect(ledger.chargeChildAdmission()).toBe(false);
    expect(ledger.failure?.context).toEqual({
      code: "child_admission_limit_exceeded",
      id: "child_admissions",
      limit: 2,
      observed: 3,
    });
    ledger.close();
  });

  test("reserves logical and physical requests together at the 0/1 boundary", () => {
    const { ledger } = create({ logicalProviderRequests: 1, physicalDispatchAttempts: 1 });
    const reservation = ledger.reserveProviderDispatch();
    expect(reservation).not.toBeNull();
    reservation!.logical.consume();
    reservation!.physical.consume();
    expect(ledger.reserveProviderDispatch()).toBeNull();
    expect(ledger.failure?.code).toBe("logical_provider_request_limit_exceeded");
    ledger.close();
  });

  test("shares one 2 MiB aggregate across argument and result bytes", () => {
    const { ledger } = create();
    expect(ledger.chargeBytes("argument_bytes", AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES - 1)).toBe(true);
    expect(ledger.chargeBytes("result_bytes", 1)).toBe(true);
    expect(ledger.chargeBytes("result_bytes", 1)).toBe(false);
    expect(ledger.failure?.code).toBe("result_limit_exceeded");
    ledger.close();
  });

  test("root and operation permits release exactly once on termination", () => {
    const { ledger, admission } = create();
    const provider = ledger.acquireProviderPermit();
    const tool = ledger.acquireToolPermit();
    expect(provider).not.toBeNull();
    expect(tool).not.toBeNull();
    expect(ledger.tryTerminate("stopped")).toBe(true);
    expect(ledger.tryTerminate("completed")).toBe(false);
    ledger.releaseOperationPermit(provider!);
    ledger.releaseOperationPermit(tool!);
    expect(admission.snapshot()).toMatchObject({
      rootsProcess: 0,
      providersProcess: 0,
      toolsProcess: 0,
    });
  });
  test("reports the saturated user admission dimension", () => {
    const limits = {
      ...AGENT_HOST_DEFAULT_LIMITS,
      providerDispatchesPerUser: 1,
      providerDispatchesProcess: 16,
    };
    const admission = new AgentRuntimeAdmissionManager(limits);
    const occupied = admission.acquireProvider("u1");
    const ledger = new AgentTurnLedger({
      generationId: crypto.randomUUID(),
      config,
      authorization,
      userId: "u1",
      limits,
      admission,
    });

    expect(ledger.acquireProviderPermit()).toBeNull();
    expect(ledger.failure?.context).toMatchObject({
      code: "capacity_exceeded",
      id: "provider_dispatches_per_user",
      limit: 1,
      observed: 1,
      admission: {
        kind: "provider",
        scope: "user",
        userLimit: 1,
        userObserved: 1,
        processLimit: 16,
        processObserved: 1,
      },
    });

    occupied.release();
    ledger.close();
  });

  test("releases logical reservation when physical reservation cannot be made", () => {
    const { ledger } = create({
      logicalProviderRequests: 1,
      physicalDispatchAttempts: 0,
    });
    expect(ledger.reserveProviderDispatch()).toBeNull();
    expect(ledger.counters.logicalProviderRequests).toBe(0);
    ledger.close();
  });
  test("settles an admitted child output overage once after terminal CAS", () => {
    const { ledger } = create({ childOutputTokens: 10 });
    const reservation = ledger.reserve("child_output_tokens", 4);
    expect(reservation).not.toBeNull();
    expect(ledger.tryTerminate("stopped")).toBe(true);

    expect(ledger.settleOutputReservation(reservation!, 7)).toBe(true);
    reservation!.consume();
    reservation!.release();
    expect(ledger.settleOutputReservation(reservation!, 7)).toBe(true);
    expect(ledger.counters.childOutputTokens).toBe(7);
    expect(ledger.remaining("child_output_tokens")).toBe(3);
  });

  test("records child output overage without replacing the first ledger failure", () => {
    const { ledger } = create({ childOutputTokens: 4 });
    const reservation = ledger.reserve("child_output_tokens", 4);
    expect(reservation).not.toBeNull();
    expect(
      ledger.charge("root_wall_clock_ms", ledger.limits.rootWallClockMs + 1),
    ).toBe(false);
    expect(ledger.tryTerminate("stopped")).toBe(true);

    expect(ledger.settleOutputReservation(reservation!, 7)).toBe(false);
    expect(ledger.counters.childOutputTokens).toBe(7);
    expect(ledger.failure).toMatchObject({
      code: "root_wall_clock_limit_exceeded",
      budget: "root_wall_clock_ms",
    });
  });
  test("terminalizes an admitted provider round once after ledger CAS", () => {
    const { ledger } = create();
    const startedAt = 1;
    const providerRound = {
      id: `${ledger.generationId}:root:provider:0`,
      parentId: ledger.generationId,
      kind: "provider_round" as const,
      actor: "provider" as const,
      phase: "running" as const,
      status: "running" as const,
      roundIndex: 0,
      continuationMode: "ordinary" as const,
      startedAt,
      elapsedMs: 1,
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        toolCalls: 0,
        childInvocations: 0,
      },
    };

    ledger.recordActivityNode(providerRound);
    expect(ledger.tryTerminate("stopped")).toBe(true);
    ledger.recordTerminalActivityNode({
      ...providerRound,
      phase: "cancelled",
      status: "cancelled",
      elapsedMs: 3,
      errorCode: "cancelled",
    });
    ledger.recordTerminalActivityNode({
      ...providerRound,
      phase: "cancelled",
      status: "cancelled",
      elapsedMs: 4,
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
        toolCalls: 0,
        childInvocations: 0,
      },
      errorCode: "cancelled",
    });

    const snapshot = ledger.activitySnapshot("cancelled", "cancelled");
    expect(snapshot.nodes.find((node) => node.id === providerRound.id)).toMatchObject({
      phase: "cancelled",
      status: "cancelled",
      usage: providerRound.usage,
      errorCode: "cancelled",
    });
    expect(snapshot.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    expect(
      ledger.budgetCounters.find((counter) => counter.id === "activity_events"),
    ).toMatchObject({ observed: 1 });
  });
  test("terminalizes an admitted queued node with the winning deadline state", () => {
    const { ledger } = create();
    const child = {
      id: `${ledger.generationId}:child`,
      parentId: ledger.generationId,
      kind: "child_invocation" as const,
      actor: "child" as const,
      profileId: "writer",
      phase: "queued" as const,
      status: "queued" as const,
      startedAt: 1,
      elapsedMs: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        childInvocations: 1,
      },
    };

    ledger.recordActivityNode(child);
    expect(ledger.tryTerminate("root_wall_clock_limit_exceeded")).toBe(true);
    ledger.recordTerminalActivityNode({
      ...child,
      phase: "running",
      status: "running",
      elapsedMs: 2,
    });

    expect(ledger.activitySnapshot("timed_out").nodes.find(
      (node) => node.id === child.id,
    )).toMatchObject({
      phase: "timed_out",
      status: "timed_out",
      errorCode: "root_wall_clock_limit_exceeded",
    });
    ledger.close();
  });

  test("retains approved child activity error codes and drops unknown strings", () => {
    const { ledger } = create();
    const startedAt = 1;
    const approved = {
      id: `${ledger.generationId}:child`,
      parentId: ledger.generationId,
      kind: "child_invocation" as const,
      actor: "child" as const,
      phase: "failed" as const,
      status: "failed" as const,
      startedAt,
      elapsedMs: 2,
      errorCode: "child_output_limit_exceeded" as const,
    };
    const leaked = {
      id: `${ledger.generationId}:tool`,
      parentId: ledger.generationId,
      kind: "tool_attempt" as const,
      actor: "tool" as const,
      phase: "failed" as const,
      status: "failed" as const,
      startedAt,
      elapsedMs: 2,
      errorCode: "secret_internal_code" as "internal_error",
    };
    ledger.recordActivityNode(approved);
    ledger.recordActivityNode({
      ...approved,
      id: `${ledger.generationId}:required`,
      errorCode: "child_required_failed",
    });
    ledger.recordActivityNode({
      ...approved,
      id: `${ledger.generationId}:protocol`,
      errorCode: "agentic_protocol_failure",
    });
    ledger.recordActivityNode(leaked);
    const snapshot = ledger.activitySnapshot("failed", "internal_error");
    expect(snapshot.nodes.find((node) => node.id === approved.id)?.errorCode).toBe("child_output_limit_exceeded");
    expect(snapshot.nodes.find((node) => node.id === `${ledger.generationId}:required`)?.errorCode).toBe("child_required_failed");
    expect(snapshot.nodes.find((node) => node.id === `${ledger.generationId}:protocol`)?.errorCode).toBe("agentic_protocol_failure");
    expect(snapshot.nodes.find((node) => node.id === leaked.id)?.errorCode).toBeUndefined();
    ledger.close();
  });

});


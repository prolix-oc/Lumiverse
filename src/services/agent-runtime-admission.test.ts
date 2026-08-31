import { describe, expect, test } from "bun:test";
import { AGENT_HOST_DEFAULT_LIMITS } from "./agent-runtime-limits";
import { AgentRuntimeAdmissionManager } from "./agent-runtime-admission";

function manager() {
  return new AgentRuntimeAdmissionManager({
    ...AGENT_HOST_DEFAULT_LIMITS,
    activeRootsPerUser: 1,
    activeRootsProcess: 2,
    providerDispatchesPerUser: 1,
    providerDispatchesProcess: 2,
    toolExecutionsPerUser: 1,
    toolExecutionsProcess: 2,
  });
}

describe("agent runtime admission", () => {
  test("atomically enforces user and process capacity without a queue", () => {
    const admission = manager();
    const first = admission.tryAcquireRoot("u1");
    expect(first).not.toBeNull();
    expect(admission.tryAcquireRoot("u1")).toBeNull();
    expect(admission.lastFailure?.context).toMatchObject({
      code: "capacity_exceeded",
      kind: "root",
      userLimit: 1,
      userObserved: 1,
    });
    const second = admission.tryAcquireRoot("u2");
    expect(second).not.toBeNull();
    expect(admission.tryAcquireRoot("u3")).toBeNull();
    expect(admission.lastFailure?.context.processObserved).toBe(2);
  });

  test("provider and tool permits release idempotently", () => {
    const admission = manager();
    const provider = admission.acquireProvider("u1");
    const tool = admission.acquireTool("u1");
    expect(admission.snapshot()).toMatchObject({ providersProcess: 1, toolsProcess: 1 });
    provider.release();
    provider.release();
    tool.release();
    tool.release();
    expect(admission.snapshot()).toMatchObject({ providersProcess: 0, toolsProcess: 0 });
    expect(admission.snapshot().providersByUser).toEqual({});
    expect(admission.snapshot().toolsByUser).toEqual({});
  });
});

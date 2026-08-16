import { afterEach, describe, expect, test } from "bun:test";
import {
  ProviderRegistry,
  providerRegistry,
  type ProviderHostToWorker,
  type ProviderKey,
} from "./provider-registry";

afterEach(() => {
  providerRegistry.reset();
});

function key(scope: ProviderKey["effectiveScope"], installationId: string, kind = "embedding", id = "foo"): ProviderKey {
  return { effectiveScope: scope, installationId, kind, id };
}

describe("provider registry identity", () => {
  test("allows same kind and id across different effective users", () => {
    const registry = new ProviderRegistry();
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-b", installScope: "user", authenticatedSubject: "bob" },
    );

    expect(registry.list("user:alice")).toHaveLength(1);
    expect(registry.list("user:bob")).toHaveLength(1);
    expect(registry.get(key("user:alice", "inst-a"))?.key).toEqual(key("user:alice", "inst-a"));
    expect(registry.get(key("user:bob", "inst-b"))?.key).toEqual(key("user:bob", "inst-b"));
  });

  test("rejects duplicate kind and id within one installation scope", () => {
    const registry = new ProviderRegistry();
    const host = { installationId: "inst-a", installScope: "user" as const, authenticatedSubject: "alice" };
    registry.register({ kind: "tts", id: "voice" }, host);
    expect(() => registry.register({ kind: "tts", id: "voice" }, host)).toThrow(
      /already registered/,
    );
  });

  test("does not trust worker supplied user or owner", () => {
    const registry = new ProviderRegistry();
    const record = registry.handleWorkerMessage(
      {
        type: "provider_register",
        phase: "register",
        kind: "stt",
        id: "transcribe",
        owner: "attacker",
        userId: "attacker",
      },
      {
        installationId: "inst-a",
        installScope: "user",
        installedByUserId: "alice",
        authenticatedSubject: "alice",
      },
    ) as { key: ProviderKey };

    expect(record.key.effectiveScope).toBe("user:alice");
    expect(record.key.installationId).toBe("inst-a");
    expect(registry.list("user:attacker")).toEqual([]);
    expect(registry.get(key("user:alice", "inst-a", "stt", "transcribe"))?.provenance.owner).toBe("alice");
  });

  test("isolates list and invoke across users and shared operator installations", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      { kind: "sidecar", id: "tools" },
      { installationId: "inst-user-a", installScope: "user", authenticatedSubject: "alice" },
    );
    registry.register(
      { kind: "sidecar", id: "tools" },
      { installationId: "inst-user-b", installScope: "user", authenticatedSubject: "bob" },
    );
    registry.register(
      { kind: "sidecar", id: "tools" },
      { installationId: "inst-op", installScope: "operator", authenticatedSubject: "op-1" },
    );

    expect(registry.list("user:alice").map((row) => row.key.installationId)).toEqual(["inst-user-a"]);
    expect(registry.list("user:bob").map((row) => row.key.installationId)).toEqual(["inst-user-b"]);
    expect(registry.list("operator:op-1").map((row) => row.key.installationId)).toEqual(["inst-op"]);
    expect(registry.listVisible(["user:alice", "operator:op-1"]).map((row) => row.key.installationId).sort()).toEqual([
      "inst-op",
      "inst-user-a",
    ]);

    await expect(
      registry.invoke(key("user:bob", "inst-user-b", "sidecar", "tools"), {}, { callerScope: "user:alice" }),
    ).rejects.toThrow(/isolated/);
    await expect(
      registry.invoke(key("operator:op-1", "inst-op", "sidecar", "tools"), {}, { callerScope: "user:alice" }),
    ).rejects.toThrow(/isolated/);
  });
});

describe("provider registry invocations", () => {
  test("aborts timed-out and cancelled invocations", async () => {
    const outbound: ProviderHostToWorker[] = [];
    const registry = new ProviderRegistry({ timeoutMs: 20 });
    registry.attachWorker("inst-a", (message) => outbound.push(message));
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );

    const timedOut = registry.invoke(key("user:alice", "inst-a"), { text: "hello" }, {
      callerScope: "user:alice",
      correlationId: "timeout-1",
    });
    await expect(timedOut).rejects.toThrow(/timed out/);
    expect(outbound.some((message) => message.type === "provider_abort" && message.correlationId === "timeout-1")).toBe(true);

    outbound.length = 0;
    const cancelled = registry.invoke(key("user:alice", "inst-a"), { text: "later" }, {
      callerScope: "user:alice",
      correlationId: "cancel-1",
    });
    expect(registry.abort("cancel-1", "provider invoke aborted")).toBe(true);
    expect(registry.abort("cancel-1", "provider invoke aborted")).toBe(false);
    await expect(cancelled).rejects.toThrow(/aborted/);
    expect(outbound.filter((message) => message.type === "provider_abort")).toHaveLength(1);
  });

  test("suppresses late provider_result after abort", async () => {
    const registry = new ProviderRegistry({ timeoutMs: 30_000 });
    registry.attachWorker("inst-a", () => undefined);
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );

    const pending = registry.invoke(key("user:alice", "inst-a"), { text: "hello" }, {
      callerScope: "user:alice",
      correlationId: "late-1",
      round: 1,
    });
    registry.abort("late-1");
    expect(registry.handleProviderResult({
      type: "provider_result",
      phase: "result",
      correlationId: "late-1",
      round: 1,
      result: { leaked: true },
    })).toBe(false);
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

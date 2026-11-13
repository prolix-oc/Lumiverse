import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const { ttsConnectionsRoutes } = await import("./tts-connections.routes");
const { getTtsProvider, getTtsProviderList } = await import("../tts/registry");
const { providerRegistry } = await import("../spindle/provider-registry");
import type { ProviderKey } from "../spindle/provider-registry";

const ALICE = "alpha-id";
const BOB = "beta-id";

const aliceHost = {
  installationId: "inst-alice",
  installScope: "user" as const,
  authenticatedSubject: ALICE,
};
const systemHost = {
  installationId: "inst-system",
  installScope: "system" as const,
};

function aliceKey(id: string): ProviderKey {
  return { effectiveScope: `user:${ALICE}`, installationId: "inst-alice", kind: "tts", id };
}

function app(userId: string) {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", userId);
    return next();
  });
  instance.route("/", ttsConnectionsRoutes);
  return instance;
}

async function listedProviderIds(userId: string): Promise<string[]> {
  const response = await app(userId).request("/providers");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { providers: Array<{ id: string }> };
  return body.providers.map((provider) => provider.id);
}

afterEach(() => {
  providerRegistry.reset();
});

describe("tts routes multi-tenant isolation", () => {
  test("user-scoped registry provider is visible only to its owner while system providers are visible to all", async () => {
    providerRegistry.register({ kind: "tts", id: "alice-ext-tts" }, aliceHost);
    providerRegistry.register({ kind: "tts", id: "shared-sys-tts" }, systemHost);

    const aliceIds = await listedProviderIds(ALICE);
    expect(aliceIds).toContain("alice-ext-tts");
    expect(aliceIds).toContain("shared-sys-tts");

    const bobIds = await listedProviderIds(BOB);
    expect(bobIds).not.toContain("alice-ext-tts");
    expect(bobIds).toContain("shared-sys-tts");

    expect(getTtsProviderList(ALICE).some((p) => p.name === "alice-ext-tts")).toBe(true);
    expect(getTtsProviderList(BOB).some((p) => p.name === "alice-ext-tts")).toBe(false);
  });

  test("absent userId falls back to system-only visibility, not a full-registry sweep", () => {
    providerRegistry.register({ kind: "tts", id: "alice-sweep-tts" }, aliceHost);
    providerRegistry.register({ kind: "tts", id: "sys-fallback-tts" }, systemHost);

    const anonymousNames = getTtsProviderList().map((p) => p.name);
    expect(anonymousNames).toContain("sys-fallback-tts");
    expect(anonymousNames).not.toContain("alice-sweep-tts");
    expect(getTtsProvider("alice-sweep-tts")).toBeUndefined();
    expect(getTtsProvider("alice-sweep-tts", ALICE)).toBeDefined();
  });

  test("another user cannot resolve or invoke alice's provider", async () => {
    providerRegistry.register({ kind: "tts", id: "alice-private-tts" }, aliceHost);

    expect(getTtsProvider("alice-private-tts", ALICE)).toBeDefined();
    expect(getTtsProvider("alice-private-tts", BOB)).toBeUndefined();

    await expect(
      providerRegistry.invoke(aliceKey("alice-private-tts"), {}, { callerScope: `user:${BOB}` }),
    ).rejects.toThrow("provider invoke is isolated to the caller scope");

    await expect(
      providerRegistry.invoke(aliceKey("alice-private-tts"), {}, { callerScope: "system" }),
    ).rejects.toThrow("provider invoke is isolated to the caller scope");
  });

  test("real caller scope is threaded into invokes: users may invoke system providers but never other users' providers", async () => {
    providerRegistry.register({ kind: "tts", id: "sys-broker-tts" }, systemHost);

    // Bob passes the isolation gate on the system provider: the invoke leaves
    // scope validation and reaches the worker dispatch path, where a stub
    // worker answers so we can prove execution got past the isolation check.
    providerRegistry.attachWorker("inst-system", ((message: {
      type?: string;
      correlationId?: string;
      round?: number;
    }) => {
      if (message?.type === "provider_invoke") {
        providerRegistry.handleProviderResult(
          {
            type: "provider_result",
            phase: "result",
            correlationId: message.correlationId!,
            round: message.round,
            error: "gate_passed",
          },
          { installationId: "inst-system", installScope: "system" },
        );
      }
    }) as never);

    const sysKey: ProviderKey = {
      effectiveScope: "system",
      installationId: "inst-system",
      kind: "tts",
      id: "sys-broker-tts",
    };
    await expect(
      providerRegistry.invoke(sysKey, {}, { callerScope: `user:${BOB}` }),
    ).rejects.toThrow("gate_passed");

    // Alice's user-scoped provider stays unreachable for bob even by id.
    providerRegistry.register({ kind: "tts", id: "alice-hidden-tts" }, aliceHost);
    expect(getTtsProvider("alice-hidden-tts", BOB)).toBeUndefined();
    expect(getTtsProvider("alice-hidden-tts", ALICE)).toBeDefined();

    // And a system context can never invoke a user-scoped record.
    const aliceKey2: ProviderKey = {
      effectiveScope: `user:${ALICE}`,
      installationId: "inst-alice",
      kind: "tts",
      id: "alice-hidden-tts",
    };
    await expect(
      providerRegistry.invoke(aliceKey2, {}, { callerScope: "system" }),
    ).rejects.toThrow("provider invoke is isolated to the caller scope");
  });
});

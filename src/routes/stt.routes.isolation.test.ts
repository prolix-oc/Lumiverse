import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const { sttConnectionsRoutes } = await import("./stt-connections.routes");
const {
  listProviders,
  getProvider,
} = await import("../services/stt-connections.service");
const { providerRegistry } = await import("../spindle/provider-registry");

const ALICE = "user:alpha-id";
const BOB = "user:beta-id";

const aliceHost = {
  installationId: "inst-alice-stt",
  installScope: "user" as const,
  authenticatedSubject: ALICE,
};
const systemHost = {
  installationId: "inst-system-stt",
  installScope: "system" as const,
};

function app(userId: string) {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", userId);
    return next();
  });
  instance.route("/", sttConnectionsRoutes);
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

describe("stt routes multi-tenant isolation", () => {
  test("user-scoped registry provider is visible only to its owner while system providers are visible to all", async () => {
    providerRegistry.register({ kind: "stt", id: "alice-ext-stt" }, aliceHost);
    providerRegistry.register({ kind: "stt", id: "shared-sys-stt" }, systemHost);

    const aliceIds = await listedProviderIds(ALICE);
    expect(aliceIds).toContain("alice-ext-stt");
    expect(aliceIds).toContain("shared-sys-stt");

    const bobIds = await listedProviderIds(BOB);
    expect(bobIds).not.toContain("alice-ext-stt");
    expect(bobIds).toContain("shared-sys-stt");

    const aliceList = listProviders(ALICE).map((provider) => provider.id);
    const bobList = listProviders(BOB).map((provider) => provider.id);
    expect(aliceList).toContain("alice-ext-stt");
    expect(bobList).not.toContain("alice-ext-stt");
  });

  test("another user cannot resolve alice's provider while builtins and system providers stay shared", () => {
    providerRegistry.register({ kind: "stt", id: "alice-private-stt" }, aliceHost);
    providerRegistry.register({ kind: "stt", id: "sys-shared-stt" }, systemHost);

    expect(getProvider("alice-private-stt", ALICE)).not.toBeNull();
    expect(getProvider("alice-private-stt", BOB)).toBeNull();
    // Absent userId resolves system scope ONLY — never an all-users sweep.
    expect(getProvider("alice-private-stt")).toBeNull();

    expect(getProvider("openai", BOB)).not.toBeNull();
    expect(getProvider("sys-shared-stt", BOB)).not.toBeNull();
    expect(getProvider("sys-shared-stt", ALICE)).not.toBeNull();
  });

  test("absent userId falls back to system-only visibility, not a full-registry sweep", () => {
    providerRegistry.register({ kind: "stt", id: "alice-sweep-stt" }, aliceHost);
    providerRegistry.register({ kind: "stt", id: "sys-fallback-stt" }, systemHost);

    const anonymousList = listProviders().map((provider) => provider.id);
    expect(anonymousList).toContain("sys-fallback-stt");
    expect(anonymousList).not.toContain("alice-sweep-stt");
    expect(listProviders(ALICE).map((provider) => provider.id)).toContain("alice-sweep-stt");
  });

  test("denied or unloaded installations disappear from every user's listing", async () => {
    providerRegistry.register(
      { kind: "stt", id: "denied-stt", description: { denied: true } },
      aliceHost,
    );
    providerRegistry.register({ kind: "stt", id: "live-alice-stt" }, aliceHost);

    await expect(listedProviderIds(ALICE)).resolves.not.toContain("denied-stt");
    await expect(listedProviderIds(BOB)).resolves.not.toContain("live-alice-stt");

    providerRegistry.unloadInstallation("inst-alice-stt");

    const aliceIds = await listedProviderIds(ALICE);
    expect(aliceIds).not.toContain("live-alice-stt");
    expect(aliceIds).not.toContain("denied-stt");
  });
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("../auth/index", () => ({ auth: { api: {} } }));

const { embeddingsRoutes } = await import("./embeddings.routes");
const {
  listEmbeddingDrivers,
  commitEmbeddingRegistryProvider,
  revokeEmbeddingRegistryProvider,
  publishEmbeddingProviderRegistryChanged,
} = await import("../services/embeddings.service");
const { providerRegistry } = await import("../spindle/provider-registry");
const { emitProviderRegistryChanged, eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");

const USER_ID = "owner-id";
const host = {
  installationId: "inst-embed",
  installScope: "user" as const,
  authenticatedSubject: USER_ID,
};

const originalEmit = eventBus.emit.bind(eventBus);
const emitCalls: Array<{ event: unknown; payload: unknown; userId?: string; options?: { topic?: string } }> = [];

function installEmitSpy() {
  emitCalls.length = 0;
  eventBus.emit = ((event, payload, userId, options) => {
    emitCalls.push({ event, payload, userId, options });
  }) as typeof eventBus.emit;
}

afterEach(() => {
  eventBus.emit = originalEmit;
  emitCalls.length = 0;
  providerRegistry.reset();
});

function app() {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", USER_ID);
    return next();
  });
  instance.route("/", embeddingsRoutes);
  return instance;
}

describe("embeddings routes provider registry", () => {
  test("emits scoped provider_changed add remove and change after registry commit", () => {
    installEmitSpy();

    commitEmbeddingRegistryProvider({ kind: "embedding", id: "ext-embed" }, host, USER_ID);
    publishEmbeddingProviderRegistryChanged({
      userId: USER_ID,
      action: "change",
      payload: { id: "ext-embed", kind: "embedding", name: "ext-embed" },
    });
    revokeEmbeddingRegistryProvider({ kind: "embedding", id: "ext-embed" }, host, USER_ID);

    expect(emitCalls).toHaveLength(3);
    expect(emitCalls.map((call) => (call.payload as { action: string }).action)).toEqual(["add", "change", "remove"]);
    for (const call of emitCalls) {
      expect(call.event).toBe(EventType.SPINDLE_PROVIDER_CHANGED);
      expect(call.userId).toBe(USER_ID);
      expect(call.options?.topic).toBe(`user:${USER_ID}`);
      expect(call.options?.topic).not.toBe("system");
    }

    emitCalls.length = 0;
    emitProviderRegistryChanged({
      userId: "",
      scope: "frontend",
      action: "add",
      generation: 1,
      revision: 99,
      payload: { id: "should-not-broadcast" },
    });
    expect(emitCalls).toEqual([]);
  });

  test("removes embedding TTS STT and sidecar options after unload without page reload", async () => {
    providerRegistry.register({ kind: "embedding", id: "live-embed" }, host);
    const listed = listEmbeddingDrivers({ userId: USER_ID });
    expect(listed.some((driver) => driver.id === "live-embed")).toBe(true);

    const response = await app().request("/providers");
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: Array<{ id: string }> };
    expect(body.providers.some((driver) => driver.id === "live-embed")).toBe(true);

    providerRegistry.unloadInstallation("inst-embed");
    expect(listEmbeddingDrivers({ userId: USER_ID }).some((driver) => driver.id === "live-embed")).toBe(false);

    const after = await app().request("/providers");
    const afterBody = await after.json() as { providers: Array<{ id: string }> };
    expect(afterBody.providers.some((driver) => driver.id === "live-embed")).toBe(false);
  });

  test("renders unavailable and timeout fallback", () => {
    providerRegistry.register(
      { kind: "embedding", id: "down-embed", description: { status: "unavailable" } },
      host,
    );
    providerRegistry.register(
      { kind: "embedding", id: "slow-embed", description: { availability: "timeout" } },
      host,
    );

    const listed = listEmbeddingDrivers({ userId: USER_ID });
    expect(listed.find((driver) => driver.id === "down-embed")?.status).toBe("unavailable");
    expect(listed.find((driver) => driver.id === "slow-embed")?.status).toBe("timeout");
  });

  test("denied registration is not visible to consumers", () => {
    providerRegistry.register(
      { kind: "embedding", id: "denied-embed", description: { denied: true } },
      host,
    );
    providerRegistry.register(
      { kind: "embedding", id: "other-user-embed" },
      { installationId: "inst-other", installScope: "user", authenticatedSubject: "intruder" },
    );

    const ids = listEmbeddingDrivers({ userId: USER_ID }).map((driver) => driver.id);
    expect(ids).not.toContain("denied-embed");
    expect(ids).not.toContain("other-user-embed");
  });

  test("provider failure is isolated", () => {
    providerRegistry.register({ kind: "embedding", id: "good-embed" }, host);
    providerRegistry.register(
      { kind: "embedding", id: "broken-embed", description: Object.create(null, {
        status: { get() { throw new Error("descriptor boom"); } },
      }) },
      { ...host, installationId: "inst-broken" },
    );

    const listed = listEmbeddingDrivers({ userId: USER_ID });
    expect(listed.some((driver) => driver.id === "good-embed")).toBe(true);
    expect(listed.some((driver) => driver.id === "openai-compatible")).toBe(true);
    expect(listed.some((driver) => driver.id === "broken-embed")).toBe(false);
  });
});

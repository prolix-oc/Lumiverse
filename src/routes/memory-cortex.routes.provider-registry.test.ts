import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";

mock.module("../auth/index", () => ({ auth: { api: {} } }));
mock.module("../services/connections.service", () => ({
  resolveConnection: () => null,
  testConnection: async () => ({ success: false, message: "unused" }),
}));
mock.module("../llm/registry", () => ({
  getProvider: () => ({ capabilities: { apiKeyRequired: true } }),
}));

const { memoryCortexRoutes } = await import("./memory-cortex.routes");
const memoryCortex = await import("../services/memory-cortex");
const { providerRegistry } = await import("../spindle/provider-registry");
const { emitProviderRegistryChanged, eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");

const USER_ID = "owner-id";
const host = {
  installationId: "inst-sidecar",
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
  instance.route("/", memoryCortexRoutes);
  return instance;
}

describe("memory-cortex routes provider registry", () => {
  test("emits scoped provider_changed add remove and change after registry commit", () => {
    installEmitSpy();

    memoryCortex.commitSidecarRegistryProvider({ kind: "sidecar", id: "ext-sidecar" }, host, USER_ID);
    memoryCortex.publishSidecarProviderRegistryChanged({
      userId: USER_ID,
      action: "change",
      payload: { id: "ext-sidecar", kind: "sidecar" },
    });
    memoryCortex.revokeSidecarRegistryProvider({ kind: "sidecar", id: "ext-sidecar" }, host, USER_ID);

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
    const configSpy = spyOn(memoryCortex, "getCortexConfig").mockReturnValue({
      sidecar: { connectionProfileId: null, model: null },
      queryGeneration: { primary: { connectionProfileId: null, model: null }, secondary: null },
      memorySummarization: { primary: { connectionProfileId: null, model: null }, secondary: null },
    } as never);

    providerRegistry.register({ kind: "sidecar", id: "live-sidecar" }, host);
    expect(memoryCortex.listCortexSidecarProviders({ userId: USER_ID }).some((row) => row.id === "live-sidecar")).toBe(true);

    const response = await app().request("/providers");
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: Array<{ id: string }> };
    expect(body.providers.some((row) => row.id === "live-sidecar")).toBe(true);

    providerRegistry.unloadInstallation("inst-sidecar");
    expect(memoryCortex.listCortexSidecarProviders({ userId: USER_ID }).some((row) => row.id === "live-sidecar")).toBe(false);

    const after = await app().request("/providers");
    const afterBody = await after.json() as { providers: Array<{ id: string }> };
    expect(afterBody.providers.some((row) => row.id === "live-sidecar")).toBe(false);
    configSpy.mockRestore();
  });

  test("renders unavailable and timeout fallback", () => {
    providerRegistry.register(
      { kind: "sidecar", id: "down-sidecar", description: { status: "unavailable" } },
      host,
    );
    providerRegistry.register(
      { kind: "sidecar", id: "slow-sidecar", description: { availability: "timeout" } },
      { ...host, installationId: "inst-slow" },
    );

    const listed = memoryCortex.listCortexSidecarProviders({ userId: USER_ID });
    expect(listed.find((row) => row.id === "down-sidecar")?.status).toBe("unavailable");
    expect(listed.find((row) => row.id === "slow-sidecar")?.status).toBe("timeout");
  });

  test("denied registration is not visible to consumers", () => {
    providerRegistry.register(
      { kind: "sidecar", id: "denied-sidecar", description: { denied: true } },
      host,
    );
    providerRegistry.register(
      { kind: "sidecar", id: "other-sidecar" },
      { installationId: "inst-other", installScope: "user", authenticatedSubject: "intruder" },
    );

    const ids = memoryCortex.listCortexSidecarProviders({ userId: USER_ID }).map((row) => row.id);
    expect(ids).not.toContain("denied-sidecar");
    expect(ids).not.toContain("other-sidecar");
  });

  test("provider failure is isolated", () => {
    providerRegistry.register({ kind: "sidecar", id: "good-sidecar" }, host);
    providerRegistry.register(
      { kind: "sidecar", id: "broken-sidecar", description: Object.create(null, {
        status: { get() { throw new Error("sidecar boom"); } },
      }) },
      { ...host, installationId: "inst-broken" },
    );

    const listed = memoryCortex.listCortexSidecarProviders({ userId: USER_ID });
    expect(listed.some((row) => row.id === "good-sidecar")).toBe(true);
    expect(listed.some((row) => row.id === "broken-sidecar")).toBe(false);
  });
});

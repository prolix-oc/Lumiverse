import { describe, expect, test } from "bun:test";
import {
  ProviderRegistry,
  envelopeContainsSecrets,
  type BrokerRequest,
} from "./provider-registry";

describe("provider secret resolution", () => {
  test("secret resolved only on host immediately before request; no secret in worker messages", async () => {
    const order: string[] = [];
    let resolvedBeforeFetch = false;
    const registry = new ProviderRegistry({
      getSecret: async (userId, key) => {
        order.push(`secret:${userId}:${key}`);
        return "super-secret-token";
      },
      fetch: async (_url, options) => {
        resolvedBeforeFetch = order.includes("secret:alice:extension:inst-a:embedding-key");
        order.push("fetch");
        const headers = new Headers(options?.headers);
        expect(headers.get("Authorization")).toBe("Bearer super-secret-token");
        return new Response(new Uint8Array([7, 7, 7]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });

    const outbound: unknown[] = [];
    registry.attachWorker("inst-a", (message) => outbound.push(message));
    registry.register({
      kind: "embedding",
      id: "foo",
      broker: {
        kind: "embedding",
        url: "https://provider.test/embed",
        secretKey: "extension:inst-a:embedding-key",
      },
    }, {
      installationId: "inst-a",
      installScope: "user",
      authenticatedSubject: "alice",
    });

    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "extension:inst-a:embedding-key",
      headers: { Accept: "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
      binary: true,
      correlationId: "secret-1",
      userId: "attacker",
      owner: "attacker",
    };

    const prepared = registry.prepareBroker(request, {
      installScope: "user",
      authenticatedSubject: "alice",
      installedByUserId: "alice",
      installationId: "inst-a",
    });

    expect(order).toEqual([]);
    expect(prepared.authenticatedSubject).toBe("alice");
    expect(prepared.workerView.secretKey).toBeUndefined();
    expect(prepared.workerView.userId).toBeUndefined();
    expect(envelopeContainsSecrets(prepared.workerView)).toBe(false);
    expect(outbound.every((message) => !JSON.stringify(message).includes("super-secret-token"))).toBe(true);
    expect(outbound.every((message) => !JSON.stringify(message).includes("embedding-key"))).toBe(true);

    const response = await registry.completeBroker(prepared);
    expect(resolvedBeforeFetch).toBe(true);
    expect(order).toEqual(["secret:alice:extension:inst-a:embedding-key", "fetch"]);
    expect(response.ok).toBe(true);
    expect(response.body).toEqual(new Uint8Array([7, 7, 7]));
    expect(envelopeContainsSecrets(response)).toBe(false);
    expect(JSON.stringify(outbound)).not.toContain("super-secret-token");
  });

  test("system-scoped install resolves secrets via the reserved system principal", async () => {
    const order: string[] = [];
    let resolvedBeforeFetch = false;
    const registry = new ProviderRegistry({
      getSecret: async (userId, key) => {
        order.push(`secret:${userId}:${key}`);
        return "system-token";
      },
      fetch: async (_url, options) => {
        resolvedBeforeFetch = order.includes("secret:__system__:extension:inst-sys:embedding-key");
        order.push("fetch");
        const headers = new Headers(options?.headers);
        expect(headers.get("Authorization")).toBe("Bearer system-token");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    registry.register({
      kind: "embedding",
      id: "sys-embed",
      broker: {
        kind: "embedding",
        url: "https://provider.test/embed",
        secretKey: "extension:inst-sys:embedding-key",
      },
    }, {
      installationId: "inst-sys",
      installScope: "system",
    });

    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "extension:inst-sys:embedding-key",
      headers: { Accept: "application/json" },
      body: { text: "hello" },
      correlationId: "sys-secret-1",
    };

    // No human subject on a system-scope host: the host-side principal
    // selection falls back to the reserved system principal, never any
    // request-supplied field.
    const prepared = registry.prepareBroker(request, {
      installScope: "system",
      installationId: "inst-sys",
    });

    expect(order).toEqual([]);
    expect(prepared.authenticatedSubject).toBe("__system__");
    expect(prepared.workerView.secretKey).toBeUndefined();

    const response = await registry.completeBroker(prepared);
    expect(resolvedBeforeFetch).toBe(true);
    expect(order).toEqual(["secret:__system__:extension:inst-sys:embedding-key", "fetch"]);
    expect(response.ok).toBe(true);
  });

  test("system-scoped invoke path resolves via the reserved system principal", async () => {
    const lookups: string[] = [];
    const registry = new ProviderRegistry({
      getSecret: async (userId, key) => {
        lookups.push(`secret:${userId}:${key}`);
        return "system-token";
      },
      fetch: async (_url, options) => {
        const headers = new Headers(options?.headers);
        expect(headers.get("Authorization")).toBe("Bearer system-token");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    registry.attachWorker("inst-sys", () => {});
    registry.register({
      kind: "sidecar",
      id: "tools",
      broker: {
        kind: "sidecar",
        url: "https://provider.test/v1",
        secretKey: "extension:inst-sys:api-key",
      },
    }, {
      installationId: "inst-sys",
      installScope: "system",
    });

    await registry.invoke(
      { effectiveScope: "system", installationId: "inst-sys", kind: "sidecar", id: "tools" },
      { input: "hello" },
      { callerScope: "system", correlationId: "sys-invoke-1" },
    );

    expect(lookups).toEqual(["secret:__system__:extension:inst-sys:api-key"]);
  });
});

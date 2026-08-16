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
        resolvedBeforeFetch = order.includes("secret:alice:embedding-key");
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
        secretKey: "embedding-key",
      },
    }, {
      installationId: "inst-a",
      installScope: "user",
      authenticatedSubject: "alice",
    });

    const request: BrokerRequest = {
      kind: "embedding",
      url: "https://provider.test/embed",
      secretKey: "embedding-key",
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
    expect(order).toEqual(["secret:alice:embedding-key", "fetch"]);
    expect(response.ok).toBe(true);
    expect(response.body).toEqual(new Uint8Array([7, 7, 7]));
    expect(envelopeContainsSecrets(response)).toBe(false);
    expect(JSON.stringify(outbound)).not.toContain("super-secret-token");
  });
});

import { describe, expect, test } from "bun:test";
import { SSRFError, safeFetch, validateHost } from "./safe-fetch";

describe("validateHost loopback allowance", () => {
  test("allows loopback IP literals when explicitly enabled", async () => {
    await expect(validateHost("127.0.0.1", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("::1", { allowLoopback: true })).resolves.toBeUndefined();
  });

  test("keeps loopback blocked by default", async () => {
    await expect(validateHost("127.0.0.1")).rejects.toBeInstanceOf(SSRFError);
  });

  test("does not allow broader private ranges", async () => {
    await expect(validateHost("192.168.1.10", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("10.0.0.5", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("169.254.169.254", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
  });
});

describe("validateHost DNS timeout", () => {
  test("fails fast when DNS resolution exceeds the budget", async () => {
    // Unique random hostname guarantees cache miss, forcing a real network
    // lookup that cannot complete within a 1ms budget. The timer fires first
    // and we surface a `timed out` SSRFError instead of stalling for minutes
    // (the Termux/.spot regression).
    const uniqueHost = `ssrf-timeout-${crypto.randomUUID()}.invalid`;
    const start = Date.now();
    await expect(
      validateHost(uniqueHost, { dnsTimeoutMs: 1 })
    ).rejects.toBeInstanceOf(SSRFError);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("safeFetch SSRF protections", () => {
  test("re-validates redirect targets before fetching them", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1:5432/" },
        });
      }
      throw new Error("redirect target should not be fetched");
    }) as unknown as typeof fetch;

    try {
      await expect(safeFetch("http://93.184.216.34/redirect")).rejects.toBeInstanceOf(SSRFError);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes method and body through to fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("payload");
      return new Response("ok");
    }) as unknown as typeof fetch;

    try {
      const response = await safeFetch("http://93.184.216.34/api", {
        method: "POST",
        body: "payload",
      });
      await expect(response.text()).resolves.toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

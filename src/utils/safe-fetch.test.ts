import { afterEach, describe, expect, test } from "bun:test";
import { JavaScriptDownloadError, SSRFError, safeFetch, validateHost } from "./safe-fetch";

describe("safeFetch JavaScript download policy", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("rejects script URL paths before issuing a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;

    for (const path of [
      "/bundle.js", "/bundle.MJS?v=1", "/bundle.cjs", "/bundle.es",
      "/bundle%2Ejs", "/bundle.%6As", "/bundle.js;version=1", "/bundle.js/", "/bundle%ff%2Ejs",
    ]) {
      await expect(safeFetch(`http://93.184.216.34${path}`, { blockJavaScript: true }))
        .rejects.toBeInstanceOf(JavaScriptDownloadError);
    }
    expect(calls).toBe(0);
  });

  test("rejects JavaScript MIME types and cancels the response body", async () => {
    for (const contentType of [
      "text/javascript", "Application/JavaScript; charset=utf-8",
      "application/ecmascript", "text/ecmascript", "application/x-javascript",
      "application/x-ecmascript", "text/x-javascript", "text/x-ecmascript",
      "text/javascript1.0", "text/javascript1.5", "text/jscript", "text/livescript",
    ]) {
      let cancelled = false;
      let signal: AbortSignal | null | undefined;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          cancel() { cancelled = true; },
        }), { headers: { "content-type": contentType } });
      }) as typeof fetch;

      await expect(safeFetch("http://93.184.216.34/download", { blockJavaScript: true }))
        .rejects.toBeInstanceOf(JavaScriptDownloadError);
      expect(cancelled).toBe(true);
      expect(signal?.aborted).toBe(true);
    }
  });

  test("rejects JavaScript download filenames even when served as ordinary data", async () => {
    for (const disposition of [
      'attachment; filename="bundle.js"',
      "attachment; filename=bundle.cjs",
      "attachment; filename*=UTF-8''bundle%2Emjs",
      "attachment; filename*=ISO-8859-1''bundle%EE%2Ejs",
      "attachment; filename=card.json; filename*=UTF-8'en'bundle%2EJS",
      'attachment; filename="nested;bundle.js"',
    ]) {
      globalThis.fetch = (async () => new Response("export default 1", {
        headers: { "content-type": "application/octet-stream", "content-disposition": disposition },
      })) as unknown as typeof fetch;
      await expect(safeFetch("http://93.184.216.34/download", { blockJavaScript: true }))
        .rejects.toBeInstanceOf(JavaScriptDownloadError);
    }
  });

  test("rejects redirects to scripts before requesting the script target", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "/bundle.mjs?version=1" } });
    }) as unknown as typeof fetch;

    await expect(safeFetch("http://93.184.216.34/redirect", { blockJavaScript: true }))
      .rejects.toBeInstanceOf(JavaScriptDownloadError);
    expect(calls).toEqual(["http://93.184.216.34/redirect"]);
  });

  test("checks the MIME type after an extensionless redirect", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return calls.length === 1
        ? new Response(null, { status: 307, headers: { location: "/download" } })
        : new Response("export default 1", { headers: { "content-type": "text/javascript" } });
    }) as typeof fetch;

    await expect(safeFetch("http://93.184.216.34/redirect", { blockJavaScript: true }))
      .rejects.toBeInstanceOf(JavaScriptDownloadError);
    expect(calls).toEqual(["http://93.184.216.34/redirect", "http://93.184.216.34/download"]);
  });

  test("checks redirect response headers before following Location", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302, headers: { location: "/data.json", "content-type": "application/javascript" },
      });
    }) as unknown as typeof fetch;
    await expect(safeFetch("http://93.184.216.34/redirect", { blockJavaScript: true }))
      .rejects.toBeInstanceOf(JavaScriptDownloadError);
    expect(calls).toBe(1);
  });

  test("allows JSON, ordinary text, and media with the policy enabled", async () => {
    for (const [path, contentType, body] of [
      ["/data.json", "application/json", '{"description":"JavaScript: export default 1"}'],
      ["/readme.txt", "text/plain", "An ordinary document"],
      ["/schema.js.map", "application/json", '{"version":3}'],
      ["/image.png", "image/png", "media bytes"],
    ]) {
      globalThis.fetch = (async () => new Response(body, { headers: {
        "content-type": contentType, "content-disposition": 'attachment; filename="data.json"',
      } })) as unknown as typeof fetch;
      const response = await safeFetch(`http://93.184.216.34${path}`, { blockJavaScript: true });
      expect(await response.text()).toBe(body);
    }
  });

  test("does not claim to detect scripts disguised as plain text", async () => {
    globalThis.fetch = (async () => new Response("export default 1", {
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
    const response = await safeFetch("http://93.184.216.34/data", { blockJavaScript: true });
    expect(await response.text()).toBe("export default 1");
  });

  test("keeps the content policy opt-in for other host consumers", async () => {
    globalThis.fetch = (async () => new Response("export default 1", {
      headers: { "content-type": "text/javascript" },
    })) as unknown as typeof fetch;
    const response = await safeFetch("http://93.184.216.34/bundle.js");
    expect(await response.text()).toBe("export default 1");
  });
});

describe("validateHost loopback allowance", () => {
  test("allows loopback IP literals when explicitly enabled", async () => {
    await expect(validateHost("127.0.0.1", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("::1", { allowLoopback: true })).resolves.toBeUndefined();
  });

  test("allows localhost names when explicitly enabled", async () => {
    await expect(validateHost("localhost", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("localhost.", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("service.localhost", { allowLoopback: true })).resolves.toBeUndefined();
  });

  test("treats loopback as private when private ranges are enabled", async () => {
    await expect(validateHost("localhost", { allowPrivate: true })).resolves.toBeUndefined();
    await expect(validateHost("localhost.", { allowPrivate: true })).resolves.toBeUndefined();
    await expect(validateHost("service.localhost", { allowPrivate: true })).resolves.toBeUndefined();
    await expect(validateHost("127.0.0.1", { allowPrivate: true })).resolves.toBeUndefined();
    await expect(validateHost("::1", { allowPrivate: true })).resolves.toBeUndefined();
  });

  test("keeps loopback blocked by default", async () => {
    await expect(validateHost("127.0.0.1")).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("localhost")).rejects.toBeInstanceOf(SSRFError);
  });

  test("does not allow broader private ranges", async () => {
    await expect(validateHost("192.168.1.10", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("10.0.0.5", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("169.254.169.254", { allowLoopback: true })).rejects.toBeInstanceOf(SSRFError);
  });

  test("blocks private IPv4-mapped IPv6 literals", async () => {
    await expect(validateHost("::ffff:7f00:1")).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("::ffff:7f00:1", { allowLoopback: true })).resolves.toBeUndefined();
    await expect(validateHost("::ffff:192.168.1.10")).rejects.toBeInstanceOf(SSRFError);
    await expect(validateHost("::ffff:a9fe:a9fe")).rejects.toBeInstanceOf(SSRFError);
  });
});

describe("validateHost hostname normalization", () => {
  test("blocks reserved hostnames with trailing root dots", async () => {
    await expect(validateHost("metadata.google.internal.")).rejects.toBeInstanceOf(SSRFError);
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

  test("does not forward request bodies to redirect origins outside the allowlist", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, {
        status: 307,
        headers: { location: "http://93.184.216.35/collect" },
      });
    }) as typeof fetch;

    try {
      await expect(safeFetch("http://93.184.216.34/broker", {
        method: "POST",
        body: "private text",
        allowedOrigins: ["http://93.184.216.34"],
      })).rejects.toThrow(/origin is not allowed/);
      expect(calls).toEqual(["http://93.184.216.34/broker"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("safeFetch User-Agent", () => {
  test("enforces maxBytes against actual streamed response bytes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("x".repeat(100), {
      headers: { "content-length": "1" },
    })) as unknown as typeof fetch;

    try {
      const response = await safeFetch("http://93.184.216.34/large", { maxBytes: 10 });
      await expect(response.text()).rejects.toBeInstanceOf(SSRFError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("propagates caller cancellation after response headers have arrived", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Response("ok");
    }) as typeof fetch;
    try {
      await safeFetch("http://93.184.216.34/model", { signal: controller.signal });
      expect(receivedSignal?.aborted).toBe(false);
      controller.abort();
      expect(receivedSignal?.aborted).toBe(true);
      await expect(safeFetch("http://93.184.216.34/model", { signal: controller.signal })).rejects.toThrow();
    } finally { globalThis.fetch = originalFetch; }
  });
  test("sends a product/version User-Agent when the caller omitted one", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/^Lumiverse\/\S+$/);
      return new Response("ok");
    }) as unknown as typeof fetch;

    try {
      await safeFetch("http://93.184.216.34/image.png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replaces a blank User-Agent so hosts that RST empty tokens still accept the request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/^Lumiverse\/\S+$/);
      expect(new Headers(init?.headers).get("accept")).toBe("image/*");
      return new Response("ok");
    }) as unknown as typeof fetch;

    try {
      await safeFetch("http://93.184.216.34/image.png", {
        headers: { Accept: "image/*", "User-Agent": "" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps an explicit caller User-Agent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe("Lumiverse");
      return new Response("ok");
    }) as unknown as typeof fetch;

    try {
      await safeFetch("http://93.184.216.34/image.png", {
        headers: { "User-Agent": "Lumiverse" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

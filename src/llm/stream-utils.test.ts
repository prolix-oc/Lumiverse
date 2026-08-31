import { afterEach, describe, expect, test } from "bun:test";

import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import {
  BoundedSseReader,
  PROVIDER_STREAM_LIMITS,
  ProviderProtocolError,
  ProviderResponseTooLargeError,
  fetchWithPreflightAbort,
  normalizeProviderReceiveLimit,
  normalizeProviderStreamLimits,
  readJsonWithAbort,
} from "./stream-utils";

describe("fetchWithPreflightAbort", () => {
  test("aborts the provider request before response headers arrive", async () => {
    const originalFetch = globalThis.fetch;
    let fetchSignal: AbortSignal | undefined;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const pending = fetchWithPreflightAbort(
        "https://provider.test/stream",
        {},
        controller.signal,
      );

      controller.abort(new DOMException("Stopped", "AbortError"));

      await expect(pending).rejects.toThrow("Stopped");
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not forward later aborts after response headers arrive", async () => {
    const originalFetch = globalThis.fetch;
    let fetchSignal: AbortSignal | undefined;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Response("ok");
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const response = await fetchWithPreflightAbort(
        "https://provider.test/stream",
        {},
        controller.signal,
      );

      controller.abort(new DOMException("Stopped", "AbortError"));

      expect(fetchSignal?.aborted).toBe(false);
      expect(await response.text()).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Abort teardown closes the upstream connection ────────────────────────────
// Bun's reader.cancel() on a fetch response body stops delivery to JS but does
// NOT close the underlying HTTP connection — the upstream server keeps
// generating into the void (a local llama.cpp keeps burning GPU and blocks its
// single slot; metered APIs keep billing). Stopping a generation must therefore
// also force the socket closed via closeConnection(), and the server must see
// the disconnect promptly. Regression: stop requests looked "ignored" for
// local backends because the connection was never torn down.

class TestProvider extends OpenAICompatibleProvider {
  readonly name = "test";
  readonly displayName = "Test";
  readonly defaultUrl = "";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "openai" as const,
    toolCalling: true,
    requiredToolChoice: false,
    nativeToolContinuation: false,
    toolContinuationMode: "legacy" as const,
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
  };
}

const enc = new TextEncoder();

/** SSE server that streams a token every 10ms and records when the client
 *  connection actually goes away (ReadableStream cancel). */
function makeTokenServer() {
  const state = { cancelled: false, sent: 0 };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      let timer: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            state.sent++;
            const chunk = { choices: [{ delta: { content: `tok${state.sent} ` }, finish_reason: null }] };
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch {
              if (timer) clearInterval(timer);
            }
          }, 10);
        },
        cancel() {
          state.cancelled = true;
          if (timer) clearInterval(timer);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, state };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

let activeServer: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  activeServer?.stop(true);
  activeServer = null;
});

describe("streaming abort teardown", () => {
  test("aborting generateStream closes the upstream connection promptly", async () => {
    const { server, state } = makeTokenServer();
    activeServer = server;
    const provider = new TestProvider();
    const ac = new AbortController();

    const stream = provider.generateStream("", `http://localhost:${server.port}/v1`, {
      model: "mock",
      messages: [{ role: "user", content: "hi" }],
      parameters: {},
      signal: ac.signal,
    } as any);

    // Consume a few chunks to ensure the stream is live, then abort.
    let received = 0;
    for await (const _chunk of stream) {
      if (++received >= 3) {
        ac.abort();
        break;
      }
    }
    expect(received).toBe(3);

    // The server must see the disconnect quickly — not at process teardown.
    expect(await waitFor(() => state.cancelled, 1000)).toBe(true);

    // And generation must actually stop: no further tokens after the close.
    const sentAtClose = state.sent;
    await new Promise((r) => setTimeout(r, 100));
    expect(state.sent).toBe(sentAtClose);
  });

  test("aborting readJsonWithAbort closes the upstream connection", async () => {
    const { server, state } = makeTokenServer();
    activeServer = server;
    const ac = new AbortController();

    const res = await fetchWithPreflightAbort(`http://localhost:${server.port}/`, { method: "GET" }, ac.signal);
    const pending = readJsonWithAbort(res, ac.signal).catch((err) => err);
    // Let a chunk or two arrive so the read loop is mid-body, then abort.
    await waitFor(() => state.sent >= 2, 1000);
    ac.abort();

    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    expect(await waitFor(() => state.cancelled, 1000)).toBe(true);
  });
});

async function collectSse(reader: BoundedSseReader): Promise<readonly { data: string; retry?: number }[]> {
  const events: Array<{ data: string; retry?: number }> = [];
  for await (const event of reader) {
    events.push({ data: event.data, ...(event.retry !== undefined ? { retry: event.retry } : {}) });
  }
  return events;
}

function bodylessJsonResponse(
  text: string,
  contentLength?: string,
  onText?: () => void,
): Response {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return {
    body: null,
    headers,
    text: async () => {
      onText?.();
      return text;
    },
  } as unknown as Response;
}
function chunkedResponse(bytes: Uint8Array, chunkSize = 1024): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }));
}

function exactJsonBytes(totalBytes: number): Uint8Array {
  const prefix = '{"value":"';
  const suffix = '"}';
  const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
  if (totalBytes < fixedBytes) throw new Error("test JSON target is too small");
  return new TextEncoder().encode(`${prefix}${"x".repeat(totalBytes - fixedBytes)}${suffix}`);
}

function exactSseBytes(totalBytes: number): Uint8Array {
  const terminal = "data: [DONE]\n\n";
  const terminalBytes = new TextEncoder().encode(terminal).byteLength;
  if (totalBytes < terminalBytes + 1) throw new Error("test SSE target is too small");
  let remaining = totalBytes - terminalBytes;
  let body = "";
  while (remaining > 0) {
    if (remaining === 1) {
      body += "\n";
      remaining = 0;
      continue;
    }
    if (remaining === 2) {
      body += "\n\n";
      remaining = 0;
      continue;
    }
    const frameBytes = Math.min(1024, remaining);
    body += `:${"x".repeat(frameBytes - 3)}\n\n`;
    remaining -= frameBytes;
  }
  return new TextEncoder().encode(body + terminal);
}

describe("provider receive-limit normalization", () => {
  test("keeps default, tighter, exact, and caps caller response limits", () => {
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    expect(normalizeProviderReceiveLimit(undefined)).toBe(host);
    expect(normalizeProviderReceiveLimit(host - 1)).toBe(host - 1);
    expect(normalizeProviderReceiveLimit(host)).toBe(host);
    expect(normalizeProviderReceiveLimit(host + 1)).toBe(host);
  });

  test("clamps every SSE line/event/frame/stream/count dimension independently", () => {
    const host = PROVIDER_STREAM_LIMITS;
    const dimensions = [
      ["maxLineBytes", host.maxLineBytes],
      ["maxEventBytes", host.maxEventBytes],
      ["maxBufferBytes", host.maxBufferBytes],
      ["maxResponseBytes", host.maxResponseBytes],
      ["maxEvents", host.maxEvents],
    ] as const;
    for (const [name, limit] of dimensions) {
      const values = [undefined, limit - 1, limit, limit + 1];
      const expected = [limit, limit - 1, limit, limit];
      for (let index = 0; index < values.length; index++) {
        const normalized = normalizeProviderStreamLimits({
          [name]: values[index],
        } as Parameters<typeof normalizeProviderStreamLimits>[0]);
        expect(normalized[name]).toBe(expected[index]);
      }
    }
  });

  test("uses immutable host defaults for omitted dimensions", () => {
    const host = PROVIDER_STREAM_LIMITS;
    expect(normalizeProviderStreamLimits()).toEqual({
      maxLineBytes: host.maxLineBytes,
      maxEventBytes: host.maxEventBytes,
      maxBufferBytes: host.maxBufferBytes,
      maxResponseBytes: host.maxResponseBytes,
      maxEvents: host.maxEvents,
    });
  });

  test("rejects malformed or nonpositive limits before reading", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => normalizeProviderReceiveLimit(value)).toThrow(RangeError);
      expect(() => normalizeProviderStreamLimits({ maxBufferBytes: value })).toThrow(RangeError);
    }
  });
  test("JSON helper accepts a default, tighter, exact host body and rejects host plus one", async () => {
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    await expect(readJsonWithAbort(new Response('{"ok":true}'), undefined))
      .resolves.toEqual({ ok: true });
    const tighter = exactJsonBytes(1024);
    await expect(readJsonWithAbort(chunkedResponse(tighter, 17), undefined, tighter.byteLength))
      .resolves.toEqual({ value: "x".repeat(1024 - '{"value":""}'.length) });

    const exact = exactJsonBytes(host);
    const exactValue = await readJsonWithAbort<{ value: string }>(
      chunkedResponse(exact, 32 * 1024),
      undefined,
      host,
    );
    expect(exactValue.value.length).toBe(host - '{"value":""}'.length);

    const over = new Uint8Array(host + 1);
    over.set(exact);
    over[host] = 0x20;
    await expect(readJsonWithAbort(chunkedResponse(over, 32 * 1024), undefined, host + 1))
      .rejects.toMatchObject({
        code: "provider_response_too_large",
        limit: host,
      });
  });
  test("SSE helper accepts default/tighter/exact caps and clamps host plus one", async () => {
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    const smallBody = new TextEncoder().encode("data: [DONE]\n\n");
    await expect(collectSse(new BoundedSseReader(
      chunkedResponse(smallBody, 3),
      undefined,
      { terminalMarker: "[DONE]" },
    ))).resolves.toEqual([{ data: "[DONE]" }]);
    await expect(collectSse(new BoundedSseReader(
      chunkedResponse(smallBody, 3),
      undefined,
      { terminalMarker: "[DONE]", maxResponseBytes: smallBody.byteLength },
    ))).resolves.toEqual([{ data: "[DONE]" }]);

    const exact = exactSseBytes(host);
    await expect(collectSse(new BoundedSseReader(
      chunkedResponse(exact, 32 * 1024),
      undefined,
      { terminalMarker: "[DONE]", maxResponseBytes: host },
    ))).resolves.toEqual([{ data: "[DONE]" }]);

    const over = exactSseBytes(host + 1);
    await expect(collectSse(new BoundedSseReader(
      chunkedResponse(over, 32 * 1024),
      undefined,
      { terminalMarker: "[DONE]", maxResponseBytes: host + 1 },
    ))).rejects.toMatchObject({
      code: "provider_response_too_large",
      limit: host,
    });
  });
});

describe("BoundedSseReader frame accounting", () => {
  test("charges unknown fields at the exact frame cap", async () => {
    const body = "unknown:abc\ndata:x\n\ndata:[DONE]\n\n";
    const events = await collectSse(new BoundedSseReader(new Response(body), undefined, {
      maxBufferBytes: 17,
      maxResponseBytes: body.length,
      terminalMarker: "[DONE]",
    }));
    expect(events[0]).toEqual({ data: "x" });
  });

  test("rejects an unknown field at cap plus one", async () => {
    const body = "unknown:abc\ndata:x\n\ndata:[DONE]\n\n";
    const pending = collectSse(new BoundedSseReader(new Response(body), undefined, {
      maxBufferBytes: 16,
      maxResponseBytes: body.length,
      terminalMarker: "[DONE]",
    }));
    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderResponseTooLargeError);
    expect((error as ProviderResponseTooLargeError).code).toBe("provider_response_too_large");
    expect((error as ProviderResponseTooLargeError).limit).toBe(16);
    expect((error as ProviderResponseTooLargeError).observed).toBe(17);
  });

  test("charges retry fields at the exact frame cap", async () => {
    const body = "retry:12\ndata:x\n\ndata:[DONE]\n\n";
    const events = await collectSse(new BoundedSseReader(new Response(body), undefined, {
      maxBufferBytes: 14,
      maxResponseBytes: body.length,
      terminalMarker: "[DONE]",
    }));
    expect(events[0]).toEqual({ data: "x", retry: 12 });
  });

  test("rejects a retry field at cap plus one", async () => {
    const body = "retry:12\ndata:x\n\ndata:[DONE]\n\n";
    const pending = collectSse(new BoundedSseReader(new Response(body), undefined, {
      maxBufferBytes: 13,
      maxResponseBytes: body.length,
      terminalMarker: "[DONE]",
    }));
    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderResponseTooLargeError);
    expect((error as ProviderResponseTooLargeError).code).toBe("provider_response_too_large");
    expect((error as ProviderResponseTooLargeError).limit).toBe(13);
    expect((error as ProviderResponseTooLargeError).observed).toBe(14);
  });

  test("emits a valid final frame when EOF omits the dispatching blank line", async () => {
    const body = "data: answer\n\ndata: [DONE]";
    await expect(collectSse(new BoundedSseReader(new Response(body), undefined, {
      terminalMarker: "[DONE]",
      maxResponseBytes: new TextEncoder().encode(body).byteLength,
    }))).resolves.toEqual([
      { data: "answer" },
      { data: "[DONE]" },
    ]);
  });

  test("opt-in compatibility emits consecutive data lines as separate events", async () => {
    const body = "data: one\ndata: two\n";
    await expect(collectSse(new BoundedSseReader(new Response(body), undefined, {
      requireTerminal: false,
      singleDataLineEvents: true,
      maxResponseBytes: new TextEncoder().encode(body).byteLength,
    }))).resolves.toEqual([
      { data: "one" },
      { data: "two" },
    ]);
    await expect(collectSse(new BoundedSseReader(new Response(body), undefined, {
      requireTerminal: false,
      maxResponseBytes: new TextEncoder().encode(body).byteLength,
    }))).resolves.toEqual([{ data: "one\ntwo" }]);
  });

  test("rejects malformed positive bounds before reading", () => {
    const names = ["maxLineBytes", "maxEventBytes", "maxBufferBytes", "maxResponseBytes"] as const;
    for (const name of names) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
        expect(() => new BoundedSseReader(
          new Response("data: [DONE]\n\n"),
          undefined,
          { [name]: value },
        )).toThrow(RangeError);
      }
    }
  });
});

describe("readJsonWithAbort bodyless responses", () => {
  test("fails closed on an exact bodyless content length without calling text", async () => {
    const body = JSON.stringify({ ok: true });
    let reads = 0;
    await expect(readJsonWithAbort(
      bodylessJsonResponse(
        body,
        String(new TextEncoder().encode(body).byteLength),
        () => { reads += 1; },
      ),
      undefined,
      body.length,
    )).rejects.toBeInstanceOf(ProviderProtocolError);
    expect(reads).toBe(0);
  });

  test("rejects a bodyless response with a missing content length", async () => {
    await expect(readJsonWithAbort(
      bodylessJsonResponse("{}"),
      undefined,
      2,
    )).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("rejects bodyless content length above the receive cap", async () => {
    await expect(readJsonWithAbort(
      bodylessJsonResponse("{}", "3"),
      undefined,
      2,
    )).rejects.toMatchObject({ code: "provider_response_too_large" });
  });

  test("fails closed on an understated bodyless content length", async () => {
    let reads = 0;
    await expect(readJsonWithAbort(
      bodylessJsonResponse("{}{}", "2", () => { reads += 1; }),
      undefined,
      3,
    )).rejects.toBeInstanceOf(ProviderProtocolError);
    expect(reads).toBe(0);
  });

  test("honors an already-aborted signal without starting a bodyless text read", async () => {
    let reads = 0;
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(readJsonWithAbort(
      bodylessJsonResponse("{}", "2", () => { reads += 1; }),
      controller.signal,
      2,
    )).rejects.toThrow("Stopped");
    expect(reads).toBe(0);
  });

  test("prioritizes an aborted signal over missing or oversized bodyless metadata", async () => {
    for (const contentLength of [undefined, "3"]) {
      let reads = 0;
      const controller = new AbortController();
      controller.abort(new DOMException("Stopped", "AbortError"));
      await expect(readJsonWithAbort(
        bodylessJsonResponse("{}", contentLength, () => { reads += 1; }),
        controller.signal,
        2,
      )).rejects.toThrow("Stopped");
      expect(reads).toBe(0);
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { fetchWithPreflightAbort, readJsonWithAbort } from "./stream-utils";

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

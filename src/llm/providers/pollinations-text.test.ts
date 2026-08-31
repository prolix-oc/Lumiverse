import { afterEach, describe, expect, test } from "bun:test";

import { ProviderProtocolError, ProviderResponseTooLargeError } from "../stream-utils";
import { ProviderRequestError } from "../../utils/provider-errors";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import type { GenerationRequest, StreamChunk } from "../types";
import { PollinationsTextProvider } from "./pollinations-text";

const provider = new PollinationsTextProvider();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(
  maxTokens = 64,
  signal?: AbortSignal,
  receiveLimitBytes = 64 * 1024,
): GenerationRequest {
  return {
    model: "pollinations-test",
    messages: [{ role: "user", content: "hello" }],
    parameters: { max_tokens: maxTokens },
    signal,
    receiveLimitBytes,
  };
}

function sse(...payloads: readonly unknown[]): string {
  return payloads
    .map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`)
    .join("");
}

function mockResponse(body: BodyInit | null, status = 200): void {
  globalThis.fetch = (async () => new Response(body, {
    status,
    statusText: status === 200 ? "OK" : "Upstream failure",
    headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;
}

async function collect(stream: AsyncGenerator<StreamChunk, void, unknown>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Pollinations text usage protocol", () => {
  test("fails closed for unsupported required tool mode before network I/O", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(provider.generate("", "https://pollinations.test", {
      ...request(),
      toolMode: "required",
      tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
    })).rejects.toThrow("Pollinations Text cannot require a host tool");
    expect(fetched).toBe(false);
  });

  test("forwards valid terminal usage before the done marker", async () => {
    mockResponse(sse(
      { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
      {
        choices: [{ finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
      "[DONE]",
    ));

    const chunks = await collect(provider.generateStream("", "https://pollinations.test", request()));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.token).toBe("answer");
    expect(chunks[1]).toMatchObject({
      token: "",
      finish_reason: "stop",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  });

  test("forwards an intermediate usage observation", async () => {
    mockResponse(sse(
      {
        choices: [{ delta: { content: "answer" }, finish_reason: null }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ));

    const chunks = await collect(provider.generateStream("", "https://pollinations.test", request(3)));
    expect(chunks[0]?.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    });
  });

  test("forwards valid non-stream usage", async () => {
    mockResponse(JSON.stringify({
      choices: [{
        message: { content: "answer" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), 200);

    await expect(provider.generate("", "https://pollinations.test", request())).resolves.toMatchObject({
      content: "answer",
      finish_reason: "stop",
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  test("rejects over-cap intermediate usage before yielding it", async () => {
    mockResponse(sse(
      {
        choices: [{ delta: { content: "answer" }, finish_reason: null }],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ));

    await expect(collect(provider.generateStream("", "https://pollinations.test", request(3))))
      .rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("rejects malformed streaming usage before yielding it", async () => {
    mockResponse(sse(
      {
        choices: [{ delta: { content: "answer" }, finish_reason: null }],
        usage: { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 3 },
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ));

    await expect(collect(provider.generateStream("", "https://pollinations.test", request())))
      .rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("rejects malformed non-stream usage", async () => {
    mockResponse(JSON.stringify({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: "1", total_tokens: 2 },
    }), 200);
    await expect(provider.generate("", "https://pollinations.test", request()))
      .rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test.each([42, {}, "unexpected"]) (
    "rejects malformed finish_reason %j before yielding",
    async (finishReason) => {
      mockResponse(sse(
        { choices: [{ delta: {}, finish_reason: finishReason }] },
        "[DONE]",
      ));
      await expect(collect(provider.generateStream("", "https://pollinations.test", request())))
        .rejects.toBeInstanceOf(ProviderProtocolError);
    },
  );
  test("rejects present non-string buffered content and finish_reason", async () => {
    for (const payload of [
      { choices: [{ message: { content: { invalid: true } }, finish_reason: "stop" }] },
      { choices: [{ message: { content: "answer" }, finish_reason: { invalid: true } }] },
    ]) {
      mockResponse(JSON.stringify(payload), 200);
      await expect(provider.generate("", "https://pollinations.test", request()))
        .rejects.toBeInstanceOf(ProviderProtocolError);
    }
  });

  test("rejects cumulative reasoning at carrier cap plus one before yielding", async () => {
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    mockResponse(sse(
      { choices: [{ delta: { reasoning: "r".repeat(half) }, finish_reason: null }] },
      { choices: [{ delta: { reasoning: "x".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ));
    await expect(collect(provider.generateStream(
      "",
      "https://pollinations.test",
      request(64, undefined, 1 * 1024 * 1024),
    ))).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });

});

describe("Pollinations text bounded HTTP errors", () => {
  test("passes the request cap to the shared error-body reader", async () => {
    mockResponse("E".repeat(32), 503);
    let caught: unknown;
    try {
      await provider.generate("", "https://pollinations.test", request(64, undefined, 8));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    const providerError = caught as ProviderRequestError;
    expect(providerError.rawBody).toBe(`${"E".repeat(8)}…[truncated]`);
    expect(providerError.rawBody?.length).toBeGreaterThan(8);
  });

  test("passes the request cap to the streaming error-body reader", async () => {
    mockResponse("S".repeat(32), 503);
    let caught: unknown;
    try {
      await collect(provider.generateStream(
        "",
        "https://pollinations.test",
        request(64, undefined, 8),
      ));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).rawBody).toBe(`${"S".repeat(8)}…[truncated]`);
  });

  test("honors abort while reading a streaming HTTP error body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Keep the body read pending until the caller aborts.
      },
    });
    mockResponse(body, 503);
    const controller = new AbortController();
    const pending = provider.generate(
      "",
      "https://pollinations.test",
      request(64, controller.signal, 1024),
    );
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toThrow("Stopped");
  });

});

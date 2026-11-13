import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { GoogleProvider } from "./google";
import { GoogleVertexProvider, stopVertexTokenSweep } from "./google-vertex";
import { OpenAIProvider } from "./openai";
import { describeGenerationStop } from "../generation-stop";
import type { GenerationRequest, StreamChunk } from "../types";

const request: GenerationRequest = { model: "test-model", messages: [{ role: "user", content: "Hello" }] };
const openai = new OpenAIProvider();
const responses = { ...request, parameters: { use_responses_api: true } };
let fetchSpy: ReturnType<typeof spyOn>;
let vertexKey: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  vertexKey = JSON.stringify({ type: "service_account", project_id: "test", client_email: "outcomes@example.test", private_key: Buffer.from(pkcs8).toString("base64") });
});
afterEach(() => fetchSpy?.mockRestore());
afterAll(() => stopVertexTokenSweep());

function mockReply(body: string | object) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: RequestInfo | URL) => {
    if (String(url).includes("oauth2.googleapis.com")) return Response.json({ access_token: "mock", expires_in: 3600 });
    if (typeof body !== "string") return Response.json(body);
    const bytes = new TextEncoder().encode(body);
    // Split within UTF-8 characters and SSE boundaries, as real transports do.
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 17));
      offset = Math.min(offset + 17, bytes.length);
    } }));
  }) as unknown as typeof fetch);
}
const sse = (...events: object[]) => events.map(e => `data:${JSON.stringify(e)}\r\n\r\n`).join("");
async function collect(stream: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const chat = (delta: object, finish_reason?: string) => ({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] });

describe("OpenAI-compatible generation outcomes", () => {
  for (const reason of ["length", "content_filter", "error"]) {
    for (const streaming of [true, false]) {
      test(`${streaming ? "stream" : "JSON"} preserves ${reason} over partial tool arguments`, async () => {
        const message = { content: "", reasoning_content: "A thought.", tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"x":' } }] };
        mockReply(streaming ? sse(chat(message, reason)) + "data: [DONE]\n\n" : { choices: [{ message, finish_reason: reason }] });
        const result = streaming ? (await collect(openai.generateStream("key", "", request))).at(-1)! : await openai.generate("key", "", request);
        expect(result.finish_reason).toBe(reason);
        expect(result.tool_calls).toBeUndefined();
        expect(describeGenerationStop(result.finish_reason, result.stop_details)).toBeDefined();
      });
    }
  }
  test("keeps usage arriving after the finish reason and accepts a proxy without DONE", async () => {
    mockReply(": keepalive\r\n\r\n" + sse(chat({ reasoning: "Think" }), chat({ content: "Hello 🌍" }, "stop"), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } }));
    const chunks = await collect(openai.generateStream("key", "", request));
    expect(chunks.map(c => c.token).join("")).toBe("Hello 🌍");
    expect(chunks.filter(c => c.finish_reason)).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ finish_reason: "stop", usage: { total_tokens: 13 } });
  });
  for (const streaming of [true, false]) {
    test(`${streaming ? "stream" : "JSON"} exposes a refusal with a normal stop reason`, async () => {
      mockReply(streaming ? sse(chat({ refusal: "Cannot " }), chat({ refusal: "answer." }, "stop")) : { choices: [{ message: { refusal: "Cannot answer." }, finish_reason: "stop" }] });
      const chunks = streaming ? await collect(openai.generateStream("key", "", request)) : undefined;
      const result = chunks?.at(-1) || await openai.generate("key", "", request);
      expect(result.finish_reason).toBe("stop");
      expect(result.stop_details).toEqual({ type: "refusal", explanation: "Cannot answer." });
      expect(describeGenerationStop(result.finish_reason, result.stop_details)).toContain("declined");
      if (chunks) expect(chunks.map(c => c.token).join("")).toBe("Cannot answer.");
      else expect((result as any).content).toBe("Cannot answer.");
    });
  }
  test("preserves OpenRouter native finish metadata", async () => {
    mockReply(sse({ choices: [{ delta: {}, finish_reason: "content_filter", native_finish_reason: "SAFETY" }] }));
    expect((await collect(openai.generateStream("key", "", request))).at(-1)).toMatchObject({ finish_reason: "content_filter", stop_details: { category: "SAFETY" } });
  });
  test("accepts multiline JSON and a final event without a trailing newline", async () => {
    mockReply('data: {\n' + 'data: "choices": [{"delta": {"content": "Hello"}, "finish_reason": "stop"}]\n' + 'data: }');
    const chunks = await collect(openai.generateStream("key", "", request));
    expect(chunks.map(c => c.token).join("")).toBe("Hello");
    expect(chunks.at(-1)?.finish_reason).toBe("stop");
  });
  test("surfaces OpenRouter errors sent inside a 200 stream", async () => {
    mockReply(sse(chat({ reasoning: "Thinking" }), { error: { code: 503, message: "Provider overloaded" }, choices: [{ finish_reason: "error", delta: {} }] }));
    await expect(collect(openai.generateStream("key", "", request))).rejects.toMatchObject({ name: "ProviderRequestError", status: 503, detail: "Provider overloaded", retryable: true });
  });
});

describe("OpenAI Responses outcomes", () => {
  for (const [event, reason] of [["response.incomplete", "max_output_tokens"], ["response.incomplete", "content_filter"], ["response.failed", "server_error"]]) {
    for (const streaming of [true, false]) {
      test(`${streaming ? "stream" : "JSON"} exposes ${event}: ${reason}`, async () => {
        const response = {
          status: event.slice(9), incomplete_details: event.endsWith("incomplete") ? { reason } : null,
          error: event.endsWith("failed") ? { code: reason, message: "Upstream failed" } : null,
          usage: { input_tokens: 5, output_tokens: 128 },
          output: [{ type: "function_call", name: "lookup", arguments: '{"x":', call_id: "call_1" }],
        };
        mockReply(streaming ? sse({ type: "response.reasoning_summary_text.delta", delta: "Thinking" }, { type: event, response }) : response);
        const result = streaming ? (await collect(openai.generateStream("key", "", responses))).at(-1)! : await openai.generate("key", "", responses);
        expect(result.finish_reason).toBe(event.endsWith("failed") ? "failed" : reason);
        expect(result.tool_calls).toBeUndefined();
        expect(result.usage?.completion_tokens).toBe(128);
        expect(result.stop_details?.category).toBe(reason);
        expect(describeGenerationStop(result.finish_reason, result.stop_details)).toContain(event.endsWith("failed") ? "Upstream failed" : reason === "content_filter" ? "content filter" : "output token limit");
      });
    }
  }
  test("streams refusal text without duplicating the completed snapshot", async () => {
    mockReply(sse(
      { type: "response.refusal.delta", delta: "Cannot answer." },
      { type: "response.refusal.done", refusal: "Cannot answer." },
      { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot answer." }] }] } },
    ));
    const chunks = await collect(openai.generateStream("key", "", responses));
    expect(chunks.map(c => c.token).join("")).toBe("Cannot answer.");
    expect(chunks.at(-1)?.stop_details).toEqual({ type: "refusal", explanation: "Cannot answer." });
  });
  test("non-streaming refusal is visible even with output_text shorthand empty", async () => {
    mockReply({ status: "completed", output_text: "", output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot answer." }] }] });
    expect(await openai.generate("key", "", responses)).toMatchObject({ content: "Cannot answer.", stop_details: { type: "refusal" } });
  });
  test("completed tool calls remain executable", async () => {
    mockReply(sse(
      { type: "response.output_item.added", item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" } },
      { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"x":1}' },
      { type: "response.completed", response: { status: "completed" } },
    ));
    expect((await collect(openai.generateStream("key", "", responses))).at(-1)).toMatchObject({ finish_reason: "tool_calls", tool_calls: [{ name: "lookup", args: { x: 1 }, call_id: "call_1" }] });
  });
  test("a terminal Responses event closes the reader without waiting for EOF", async () => {
    let cancelled = false;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }))); },
      cancel() { cancelled = true; },
    }))) as unknown as typeof fetch);
    expect((await collect(openai.generateStream("key", "", responses))).at(-1)?.finish_reason).toBe("max_output_tokens");
    expect(cancelled).toBe(true);
  });
});

for (const provider of [new GoogleProvider(), new GoogleVertexProvider()]) {
  const key = () => provider.name === "google_vertex" ? vertexKey : "key";
  describe(`${provider.displayName} outcomes`, () => {
    for (const reason of ["MAX_TOKENS", "SAFETY", "RECITATION", "MALFORMED_FUNCTION_CALL", "NEW_PROVIDER_FAILURE"]) {
      for (const streaming of [true, false]) {
        test(`${streaming ? "stream" : "JSON"} retains ${reason} beside content/tool parts`, async () => {
          const data = { candidates: [{ content: { parts: [{ thought: true, text: "Thinking" }, { text: "Partial" }, { functionCall: { name: "lookup", args: {} } }] }, finishReason: reason, finishMessage: "Provider explanation" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 128, totalTokenCount: 133 } };
          mockReply(streaming ? sse(data) : data);
          const chunks = streaming ? await collect(provider.generateStream(key(), "", request)) : undefined;
          const result = chunks?.at(-1) || await provider.generate(key(), "", request);
          expect(result.finish_reason).toBe(reason);
          expect(result.stop_details?.explanation).toBe("Provider explanation");
          expect(result.tool_calls).toBeUndefined();
          expect(describeGenerationStop(result.finish_reason, result.stop_details)).toContain("Provider explanation");
          if (chunks) expect(chunks.flatMap(c => c.tool_calls || [])).toEqual([]);
        });
      }
    }
    for (const streaming of [true, false]) {
      test(`${streaming ? "stream" : "JSON"} surfaces a prompt block with no candidate`, async () => {
        const data = { promptFeedback: { blockReason: "SAFETY", safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", blocked: true }] } };
        mockReply(streaming ? sse(data) : data);
        const result = streaming ? (await collect(provider.generateStream(key(), "", request))).at(-1)! : await provider.generate(key(), "", request);
        expect(result.finish_reason).toBe("SAFETY");
        expect(result.stop_details).toMatchObject({ type: "blocked_prompt", category: "HARM_CATEGORY_DANGEROUS_CONTENT" });
        expect(describeGenerationStop(result.finish_reason, result.stop_details)).toContain("blocked the prompt");
      });
    }
    test("waits past an early STOP, preserves a later failure and trailing usage", async () => {
      mockReply(sse(
        { candidates: [{ finishReason: "STOP" }] },
        { candidates: [{ content: { parts: [{ thought: true, text: "Thinking" }] }, finishReason: "MAX_TOKENS" }] },
        { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 128, totalTokenCount: 133 } },
      ));
      const chunks = await collect(provider.generateStream(key(), "", request));
      expect(chunks.filter(c => c.finish_reason)).toHaveLength(1);
      expect(chunks.at(-1)).toMatchObject({ finish_reason: "MAX_TOKENS", usage: { total_tokens: 133 } });
    });
    test("keeps the explanation when a later envelope repeats the failure without details", async () => {
      mockReply(sse(
        { candidates: [{ finishReason: "SAFETY", finishMessage: "Provider explanation" }] },
        { candidates: [{ finishReason: "SAFETY" }] },
      ));
      expect((await collect(provider.generateStream(key(), "", request))).at(-1)?.stop_details?.explanation).toBe("Provider explanation");
    });
  });
}

for (const [name, provider, req] of [
  ["Chat Completions", openai, request], ["Responses", openai, responses], ["Gemini", new GoogleProvider(), request],
] as const) {
  describe(`${name} stream failures`, () => {
    for (const body of ["", "data: [DONE]\n\n", sse({ type: "ping" })]) {
      test(`rejects a stream with no terminal response (${JSON.stringify(body)})`, async () => {
        mockReply(body);
        await expect(collect(provider.generateStream("key", "", req))).rejects.toMatchObject({ code: "incomplete_stream" });
      });
    }
    test("does not swallow malformed stream events", async () => {
      mockReply("data: {broken\n\n");
      await expect(collect(provider.generateStream("key", "", req))).rejects.toMatchObject({ code: "invalid_stream_event" });
    });
    test("surfaces an in-band provider error", async () => {
      mockReply(sse({ type: "error", error: { code: "server_error", message: "Upstream failed" } }));
      await expect(collect(provider.generateStream("key", "", req))).rejects.toMatchObject({ detail: "Upstream failed", retryable: true });
    });
    test("user cancellation stays clean while waiting for terminal data", async () => {
      let cancelled = false;
      let connected!: () => void;
      const ready = new Promise<void>(resolve => { connected = resolve; });
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
        connected();
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      }) as unknown as typeof fetch);
      const controller = new AbortController();
      const consuming = collect(provider.generateStream("key", "", { ...req, signal: controller.signal }));
      await ready;
      await Bun.sleep(1);
      controller.abort();
      expect(await consuming).toEqual([]);
      expect(cancelled).toBe(true);
    });
  });
}

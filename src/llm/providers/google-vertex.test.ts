import { describe, expect, test } from "bun:test";
import type { GenerationResponse, StreamChunk } from "../types";
import { ProviderProtocolError, ProviderResponseTooLargeError, PROVIDER_STREAM_LIMITS } from "../stream-utils";
import { AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES } from "../../services/agent-runtime-accounting";
import { ProviderRequestError } from "../../utils/provider-errors";
import { INVALID_TOOL_ARGUMENTS } from "../tool-arguments";
import { GoogleVertexProvider } from "./google-vertex";

let serviceAccountSequence = 0;

async function createTestServiceAccount(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const encoded = Buffer.from(der).toString("base64");
  const pemBody = encoded.match(/.{1,64}/g)?.join("\n") ?? encoded;
  serviceAccountSequence += 1;

  return JSON.stringify({
    type: "service_account",
    project_id: "vertex-test-project",
    private_key_id: `key-${serviceAccountSequence}`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`,
    client_email: `vertex-test-${serviceAccountSequence}@example.com`,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

// Vertex mirrors the Gemini contents shape: Content.role is "user" or "model",
// functionCall is {name, args}, functionResponse is {name, response} with
// "output"/"error" keys per the docs.
describe("GoogleVertexProvider tool calling wire shape", () => {
  test("required mode uses ANY over exactly the admitted host tools", () => {
    const body = (new GoogleVertexProvider() as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "continue" }],
      parameters: { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
      toolMode: "required",
      tools: [{ name: "host_a", description: "A", parameters: { type: "object" } }],
    });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(body.tools).toEqual([{ functionDeclarations: [{
      name: "host_a",
      description: "A",
      parameters: { type: "object" },
    }] }]);
  });

  test("rejects required mode without an admitted function declaration", () => {
    expect(() => (new GoogleVertexProvider() as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "continue" }],
      toolMode: "required",
      tools: [],
    })).toThrow("at least one admitted host tool");
  });

  test("hoists only the leading system prefix and preserves later placement", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "prefix one" },
        { role: "system", content: "prefix two" },
        { role: "user", content: "old turn" },
        { role: "system", content: "depth instruction" },
        { role: "assistant", content: "reply" },
        { role: "system", content: "post-history instruction" },
      ],
      parameters: {},
      tools: [],
    });

    expect(body.systemInstruction).toEqual({
      parts: [{ text: "prefix one\n\nprefix two" }],
    });
    expect(body.contents.map((content: any) => [content.role, content.parts[0].text])).toEqual([
      ["user", "old turn"],
      ["user", "depth instruction"],
      ["model", "reply"],
      ["user", "post-history instruction"],
    ]);
  });

  test("tool_use part becomes a functionCall on a model-role Content", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up." },
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Looking it up." },
        { functionCall: { name: "get_weather", args: { city: "SF" } }, thoughtSignature: "context_engineering_is_the_way_to_go" },
      ],
    });
  });

  test("captured thought_signature is echoed verbatim on the functionCall", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" }, thought_signature: "REAL_SIG_A" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionCall: { name: "get_weather", args: { city: "SF" } },
      thoughtSignature: "REAL_SIG_A",
    });
  });

  test("replays an optional non-tool thought signature only when enabled", () => {
    const provider = new GoogleVertexProvider();
    const request = {
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "I checked the details.", thought_signature: "TEXT_SIG_A" },
      ],
    };

    const enabled = (provider as any).buildBody({
      ...request,
      parameters: { _replay_thought_signatures: true },
    });
    expect(enabled.contents[1].parts[0]).toEqual({
      text: "I checked the details.",
      thoughtSignature: "TEXT_SIG_A",
    });

    const disabled = (provider as any).buildBody({ ...request, parameters: {} });
    expect(disabled.contents[1].parts[0].thoughtSignature).toBeUndefined();
  });

  test("tool_result part becomes a functionResponse with output key", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_1", name: "get_weather", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: "72F" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { output: "72F" } } },
      ],
    });
  });

  test("tool_result with is_error uses error key", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_1", name: "get_weather", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: "boom", is_error: true },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: "get_weather", response: { error: "boom" } },
    });
  });

  test("functionResponse name resolves from prior functionCall id", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_xyz", name: "do_thing", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_xyz", content: "ok" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: "do_thing", response: { output: "ok" } },
    });
  });
});

describe("GoogleVertexProvider web search grounding", () => {
  test.each(["googleSearch", "google_search", "enable_web_search"])(
    "adds google_search for the %s parameter",
    (parameter) => {
      const provider = new GoogleVertexProvider();
      const body = (provider as any).buildBody({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "What's new today?" }],
        parameters: { [parameter]: true },
        tools: [],
      });

      expect(body.tools).toEqual([{ google_search: {} }]);
      expect(body.googleSearch).toBeUndefined();
      expect(body.google_search).toBeUndefined();
      expect(body.enable_web_search).toBeUndefined();
    },
  );

  test("does not combine google_search with inline function declarations", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hi" }],
      parameters: { enable_web_search: true },
      tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
    });

    expect(body.tools).toEqual([{
      functionDeclarations: [{ name: "lookup", description: "Lookup", parameters: {} }],
    }]);
  });

  test("skips unsupported Lite models", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.0-flash-lite",
      messages: [{ role: "user", content: "Hi" }],
      parameters: { enable_web_search: true },
      tools: [],
    });

    expect(body.tools).toBeUndefined();
  });

  test("does not duplicate an existing custom-body google_search tool", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hi" }],
      parameters: {
        enable_web_search: true,
        tools: [{ google_search: {} }],
      },
      tools: [],
    });

    expect(body.tools).toEqual([{ google_search: {} }]);
  });
});

describe("GoogleVertexProvider model-controlled tool argument parsing", () => {
  const responseBody = {
    candidates: [{
      content: {
        parts: [
          { functionCall: { name: "lore_list_books" } },
          { functionCall: { name: "lore_search_entries", args: { query: "x" } } },
        ],
      },
      finishReason: "STOP",
    }],
  };

  test("non-streaming missing arguments reject before execution", async () => {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await expect(new GoogleVertexProvider().generate(
        serviceAccount,
        "https://aiplatform.googleapis.com",
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "search" }],
          parameters: {},
          tools: [
            { name: "lore_list_books", description: "", parameters: {} },
            { name: "lore_search_entries", description: "", parameters: {} },
          ],
        },
      )).rejects.toThrow("Provider tool arguments are missing or invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("streaming missing arguments reject before execution", async () => {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    const sse = `data: ${JSON.stringify(responseBody)}\n\n`;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(sse, { status: 200 });
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      for await (const _chunk of new GoogleVertexProvider().generateStream(
        serviceAccount,
        "https://aiplatform.googleapis.com",
        {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "search" }],
          parameters: {},
          tools: [
            { name: "lore_list_books", description: "", parameters: {} },
            { name: "lore_search_entries", description: "", parameters: {} },
          ],
        },
      )) {
        // Missing function-call arguments must fail before a tool result can be consumed.
      }
    } catch (error) {
      caught = error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain("Vertex functionCall is missing arguments");
  });
});

describe("GoogleVertexProvider bounded response protocol", () => {
  const baseRequest = {
    model: "gemini-2.5-flash",
    messages: [{ role: "user" as const, content: "hello" }],
    parameters: {},
    tools: [],
  };

  function sseResponse(payloads: readonly Record<string, unknown>[]): Response {
    const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  function mergedArgumentFragments(totalBytes: number): [{ first: string }, { second: string }] {
    const fixedBytes = Buffer.byteLength(JSON.stringify({ first: "", second: "" }), "utf8");
    return [{ first: "x".repeat(totalBytes - fixedBytes) }, { second: "" }];
  }

  async function consumeVertexStream(
    request: typeof baseRequest,
    response: Response,
  ): Promise<StreamChunk[]> {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return response;
    }) as unknown as typeof fetch;
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of new GoogleVertexProvider().generateStream(
        serviceAccount,
        "https://aiplatform.googleapis.com",
        request,
      )) {
        chunks.push(chunk);
      }
      return chunks;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function generateVertex(
    request: typeof baseRequest,
    response: Response,
  ): Promise<GenerationResponse> {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return response;
    }) as unknown as typeof fetch;
    try {
      return await new GoogleVertexProvider().generate(
        serviceAccount,
        "https://aiplatform.googleapis.com",
        request,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("merged function-call arguments admit exact cap and reject cap plus one", async () => {
    const [exactFirst, exactSecond] = mergedArgumentFragments(PROVIDER_STREAM_LIMITS.maxArgumentsBytes);
    const exactSse = sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: exactFirst } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: exactSecond } }] }, finishReason: "STOP" }] },
    ]);
    const chunks = await consumeVertexStream(baseRequest, exactSse);
    const toolCall = chunks.at(-1)?.tool_calls?.[0];
    expect(toolCall).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(toolCall?.args), "utf8")).toBe(PROVIDER_STREAM_LIMITS.maxArgumentsBytes);

    const [overFirst, overSecond] = mergedArgumentFragments(PROVIDER_STREAM_LIMITS.maxArgumentsBytes + 1);
    const overSse = sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: overFirst } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "call-1", name: "merge", args: overSecond } }] }, finishReason: "STOP" }] },
    ]);
    await expect(consumeVertexStream(baseRequest, overSse)).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });

  test("thought signatures use a cumulative carrier cap before assignment", async () => {
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    const exactBody = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { id: "call-1", name: "one", args: {} }, thoughtSignature: "a".repeat(half) },
            { functionCall: { id: "call-2", name: "two", args: {} }, thoughtSignature: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half) },
          ],
        },
        finishReason: "STOP",
      }],
    };
    const response = await generateVertex(baseRequest, new Response(JSON.stringify(exactBody), { status: 200 }));
    expect(response.tool_calls?.map((call) => call.thought_signature?.length)).toEqual([
      half,
      AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half,
    ]);

    const overBody = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { id: "call-1", name: "one", args: {} }, thoughtSignature: "a".repeat(half) },
            { functionCall: { id: "call-2", name: "two", args: {} }, thoughtSignature: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) },
          ],
        },
        finishReason: "STOP",
      }],
    };
    await expect(generateVertex(baseRequest, new Response(JSON.stringify(overBody), { status: 200 })))
      .rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });
  test("reasoning text uses a cumulative carrier cap before append", async () => {
    const half = Math.floor(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES / 2);
    const exactBody = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "a".repeat(half) },
            { thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half) },
          ],
        },
        finishReason: "STOP",
      }],
    };
    const exact = await generateVertex(baseRequest, new Response(JSON.stringify(exactBody), { status: 200 }));
    expect(exact.reasoning?.length).toBe(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES);

    const overBody = {
      ...exactBody,
      candidates: [{
        ...exactBody.candidates[0],
        content: {
          parts: [
            { thought: true, text: "a".repeat(half) },
            { thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) },
          ],
        },
      }],
    };
    await expect(generateVertex(baseRequest, new Response(JSON.stringify(overBody), { status: 200 })))
      .rejects.toBeInstanceOf(ProviderResponseTooLargeError);

    const streamOver = sseResponse([
      { candidates: [{ content: { parts: [{ thought: true, text: "a".repeat(half) }] } }] },
      { candidates: [{ content: { parts: [{ thought: true, text: "b".repeat(AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES - half + 1) }] }, finishReason: "STOP" }] },
    ]);
    await expect(consumeVertexStream(baseRequest, streamOver)).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });


  test("malformed usage metadata rejects in non-stream responses", async () => {
    const malformedBody = {
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1.5, candidatesTokenCount: 2, totalTokenCount: 3 },
    };
    await expect(generateVertex(baseRequest, new Response(JSON.stringify(malformedBody), { status: 200 })))
      .rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("malformed usage metadata rejects on any streaming chunk", async () => {
    const malformedSse = sseResponse([{
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: "2", totalTokenCount: 3 },
    }]);
    await expect(consumeVertexStream(baseRequest, malformedSse)).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("thought signatures on non-call parts reject malformed protocol input", async () => {
    const malformedBody = {
      candidates: [{ content: { parts: [{ text: "ok", thoughtSignature: 123 }] }, finishReason: "STOP" }],
    };
    await expect(generateVertex(baseRequest, new Response(JSON.stringify(malformedBody), { status: 200 })))
      .rejects.toBeInstanceOf(ProviderProtocolError);
  });

  test("provider error reads honor the request receive cap", async () => {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    const tail = "tail-that-must-not-be-retained";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(`{"error":{"message":"${"x".repeat(256)}${tail}"}}`, {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      let caught: unknown;
      try {
        await new GoogleVertexProvider().generate(serviceAccount, "https://aiplatform.googleapis.com", {
          ...baseRequest,
          receiveLimitBytes: 32,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProviderRequestError);
      if (!(caught instanceof ProviderRequestError)) return;
      expect(caught.rawBody).not.toContain(tail);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider error reads honor request abort", async () => {
    const serviceAccount = await createTestServiceAccount();
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const pullStarted = Promise.withResolvers<void>();
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("partial error"));
      },
      pull() {
        pullStarted.resolve();
        return new Promise<void>((resolve) => {
          releasePull = resolve;
        });
      },
      cancel() {
        releasePull?.();
      },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "vertex-test-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(body, { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const pending = new GoogleVertexProvider().generate(serviceAccount, "https://aiplatform.googleapis.com", {
        ...baseRequest,
        signal: controller.signal,
      });
      await pullStarted.promise;
      controller.abort(new DOMException("stop", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      releasePull?.();
      globalThis.fetch = originalFetch;
    }
  });
});

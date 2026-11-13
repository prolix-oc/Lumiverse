import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  GoogleVertexProvider,
  resolveVertexModelRoute,
  stopVertexTokenSweep,
} from "./google-vertex";

let serviceAccountKey: string;
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  serviceAccountKey = JSON.stringify({
    type: "service_account",
    project_id: "garden-project",
    client_email: "model-garden-routing@example.test",
    private_key: Buffer.from(pkcs8).toString("base64"),
  });
});

afterEach(() => fetchSpy?.mockRestore());
afterAll(() => stopVertexTokenSweep());

// Vertex mirrors the Gemini contents shape: Content.role is "user" or "model",
// functionCall is {name, args}, functionResponse is {name, response} with
// "output"/"error" keys per the docs.
describe("GoogleVertexProvider tool calling wire shape", () => {
  test("serializes image, audio, and video bytes as documented inlineData parts", () => {
    const provider = new GoogleVertexProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe these files" },
          { type: "image", data: "IMAGE_BYTES", mime_type: "image/png" },
          { type: "audio", data: "AUDIO_BYTES", mime_type: "audio/mpeg" },
          { type: "video", data: "VIDEO_BYTES", mime_type: "video/quicktime" },
        ],
      }],
      parameters: {},
      tools: [],
    });

    expect(body.contents[0].parts).toEqual([
      { text: "Describe these files" },
      { inlineData: { mimeType: "image/png", data: "IMAGE_BYTES" } },
      { inlineData: { mimeType: "audio/mp3", data: "AUDIO_BYTES" } },
      { inlineData: { mimeType: "video/mov", data: "VIDEO_BYTES" } },
    ]);
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

describe("GoogleVertexProvider Model Garden routing", () => {
  test("recognizes documented Model Garden identifier forms", () => {
    expect(resolveVertexModelRoute("gemini-2.5-flash")).toEqual({
      protocol: "gemini",
      publisher: "google",
      model: "gemini-2.5-flash",
    });
    expect(resolveVertexModelRoute("claude-sonnet-4-5@20250929")).toEqual({
      protocol: "anthropic",
      publisher: "anthropic",
      model: "claude-sonnet-4-5@20250929",
    });
    expect(resolveVertexModelRoute(
      "projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1@20250805",
    )).toEqual({
      protocol: "anthropic",
      publisher: "anthropic",
      model: "claude-opus-4-1@20250805",
    });
    expect(resolveVertexModelRoute("meta/llama-3.3-70b-instruct-maas")).toEqual({
      protocol: "openai",
      publisher: "meta",
      model: "meta/llama-3.3-70b-instruct-maas",
      publisherEndpoint: false,
    });
    expect(resolveVertexModelRoute("llama-3.3-70b-instruct-maas")).toEqual({
      protocol: "openai",
      publisher: "meta",
      model: "meta/llama-3.3-70b-instruct-maas",
      publisherEndpoint: false,
    });
    expect(resolveVertexModelRoute("publishers/mistralai/models/mistral-medium-3")).toEqual({
      protocol: "openai",
      publisher: "mistralai",
      model: "mistralai/mistral-medium-3",
      publisherEndpoint: true,
    });
  });

  test("sends Claude through Anthropic's Vertex rawPredict protocol", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      return Response.json({
        content: [{ type: "text", text: "Hello from Claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 3 },
      });
    }) as unknown as typeof fetch);

    const result = await new GoogleVertexProvider().generate(
      serviceAccountKey,
      "https://us-east5-aiplatform.googleapis.com",
      {
        model: "anthropic/claude-sonnet-4-5@20250929",
        messages: [{ role: "user", content: "Hello" }],
        parameters: { max_tokens: 64, enable_web_search: true },
      },
    );

    const prediction = requests.find((request) => request.url.includes(":rawPredict"));
    expect(prediction?.url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/garden-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict",
    );
    expect(prediction?.init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer vertex-token",
    });
    const body = JSON.parse(String(prediction?.init?.body));
    expect(body).toMatchObject({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(body.model).toBeUndefined();
    expect(body.enable_web_search).toBeUndefined();
    expect(result).toMatchObject({ content: "Hello from Claude", finish_reason: "end_turn" });
  });

  test("sends open MaaS models through Vertex Chat Completions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Hello from Llama" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
      });
    }) as unknown as typeof fetch);

    const result = await new GoogleVertexProvider().generate(
      serviceAccountKey,
      "https://us-central1-aiplatform.googleapis.com",
      {
        model: "meta/llama-3.3-70b-instruct-maas",
        messages: [{ role: "user", content: "Hello" }],
        parameters: { max_tokens: 64, googleSearch: true },
      },
    );

    const prediction = requests.find((request) => request.url.includes("/chat/completions"));
    expect(prediction?.url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/garden-project/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(JSON.parse(String(prediction?.init?.body))).toMatchObject({
      model: "meta/llama-3.3-70b-instruct-maas",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(JSON.parse(String(prediction?.init?.body)).googleSearch).toBeUndefined();
    expect(result).toMatchObject({ content: "Hello from Llama", finish_reason: "stop" });
  });

  test("sends OpenAI-shaped partner models through publisher rawPredict", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Hello from Mistral" }, finish_reason: "stop" }],
      });
    }) as unknown as typeof fetch);

    await new GoogleVertexProvider().generate(
      serviceAccountKey,
      "https://europe-west4-aiplatform.googleapis.com",
      {
        model: "publishers/mistralai/models/mistral-medium-3",
        messages: [{ role: "user", content: "Hello" }],
      },
    );

    const prediction = requests.find((request) => request.url.includes(":rawPredict"));
    expect(prediction?.url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/garden-project/locations/europe-west4/publishers/mistralai/models/mistral-medium-3:rawPredict",
    );
    expect(JSON.parse(String(prediction?.init?.body)).model).toBe("mistral-medium-3");
  });

  test("streams Claude from Vertex's streamRawPredict endpoint", async () => {
    const requests: string[] = [];
    const sse = [
      { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Streamed Claude" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch);

    const chunks = [];
    for await (const chunk of new GoogleVertexProvider().generateStream(
      serviceAccountKey,
      "https://us-east5-aiplatform.googleapis.com",
      {
        model: "claude-sonnet-4-5@20250929",
        messages: [{ role: "user", content: "Hello" }],
      },
    )) chunks.push(chunk);

    expect(requests.find((url) => url.includes("streamRawPredict"))?.endsWith(
      "/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
    )).toBe(true);
    expect(chunks.map((chunk) => chunk.token).join("")).toBe("Streamed Claude");
    expect(chunks.at(-1)).toMatchObject({ finish_reason: "end_turn", usage: { total_tokens: 7 } });
  });

  test("streams open MaaS responses from Vertex Chat Completions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Streamed Llama" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch);

    const chunks = [];
    for await (const chunk of new GoogleVertexProvider().generateStream(
      serviceAccountKey,
      "https://us-central1-aiplatform.googleapis.com",
      {
        model: "meta/llama-3.3-70b-instruct-maas",
        messages: [{ role: "user", content: "Hello" }],
      },
    )) chunks.push(chunk);

    const prediction = requests.find((request) => request.url.includes("/chat/completions"));
    expect(JSON.parse(String(prediction?.init?.body)).stream).toBe(true);
    expect(chunks.map((chunk) => chunk.token).join("")).toBe("Streamed Llama");
    expect(chunks.at(-1)?.finish_reason).toBe("stop");
  });

  test("lists managed Claude and open MaaS catalog entries with publisher prefixes", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "vertex-token", expires_in: 3600 });
      }
      if (url.includes("/publishers/google/models")) {
        return Response.json({ publisherModels: [
          { name: "publishers/google/models/gemini-2.5-flash" },
          { name: "publishers/google/models/gemma-4-26b-a4b-it-maas" },
        ] });
      }
      if (url.includes("/publishers/anthropic/models")) {
        return Response.json({ publisherModels: [
          { name: "publishers/anthropic/models/claude-sonnet-4-5@20250929" },
        ] });
      }
      if (url.includes("/publishers/meta/models")) {
        return Response.json({ publisherModels: [
          { name: "publishers/meta/models/llama-3.3-70b-instruct-maas" },
          { name: "publishers/meta/models/llama-self-deploy-only" },
        ] });
      }
      return Response.json({ publisherModels: [] });
    }) as unknown as typeof fetch);

    expect(await new GoogleVertexProvider().listModels(serviceAccountKey, "")).toEqual([
      "anthropic/claude-sonnet-4-5@20250929",
      "gemini-2.5-flash",
      "google/gemma-4-26b-a4b-it-maas",
      "meta/llama-3.3-70b-instruct-maas",
    ]);
  });
});

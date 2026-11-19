import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearOpenRouterMetadataCache, normalizeOpenRouterEndpointModel, OpenRouterProvider } from "./openrouter";
import { injectConnectionMetadataFlags } from "../../services/generation/connection-metadata";
import type { GenerationRequest, StreamChunk } from "../types";

const provider = new OpenRouterProvider();
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); clearOpenRouterMetadataCache(); });

describe("OpenRouter multimodal attachments", () => {
  for (const stream of [false, true]) {
    for (const videoOnly of [false, true]) {
      test(`${stream ? "streaming" : "JSON"} sends ${videoOnly ? "a captionless video" : "mixed text, image, video, and audio"}`, async () => {
        let sent: any;
        fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
          sent = JSON.parse(String(init?.body));
          return stream
            ? new Response('data: {"choices":[{"delta":{"content":"A video."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
            : Response.json({ choices: [{ message: { content: "A video." }, finish_reason: "stop" }] });
        }) as typeof fetch);
        const video = { type: "video" as const, mime_type: "video/mp4", data: "dmlkZW8=" };
        const request: GenerationRequest = {
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "Describe the attachments." },
            { role: "user", content: videoOnly ? [video] : [
              { type: "text", text: "Compare these attachments." },
              { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
              video,
              { type: "audio", mime_type: "audio/wav", data: "YXVkaW8=" },
              { type: "text", text: "What happens in the video?" },
            ] },
          ],
        };
        const original = structuredClone(request);
        if (stream) {
          const chunks: StreamChunk[] = [];
          for await (const chunk of provider.generateStream("placeholder", "", request)) chunks.push(chunk);
          expect(chunks.map((chunk) => chunk.token).join("")).toBe("A video.");
        } else {
          expect((await provider.generate("placeholder", "", request)).content).toBe("A video.");
        }
        const expectedVideo = { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } };
        expect(sent.messages).toEqual([
          { role: "system", content: "Describe the attachments." },
          { role: "user", content: videoOnly ? [expectedVideo] : [
            { type: "text", text: "Compare these attachments." },
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            expectedVideo,
            { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } },
            { type: "text", text: "What happens in the video?" },
          ] },
        ]);
        expect(String(fetchSpy.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(sent.stream).toBe(stream);
        expect(request).toEqual(original);
      });
    }
  }

  for (const [mimeType, expectedMime] of [
    ["video/mp4", "video/mp4"],
    ["video/mpeg", "video/mpeg"],
    ["video/mov", "video/mov"],
    ["video/webm", "video/webm"],
    ["video/quicktime", "video/mov"],
    ["video/x-m4v", "video/mp4"],
    ["video/mpg", "video/mpeg"],
  ]) {
    test(`serializes ${mimeType} as an inline ${expectedMime} video`, () => {
      expect(provider.serializeMessages([{ role: "user", content: [
        { type: "video", mime_type: mimeType, data: "dmlkZW8=" },
      ] }])).toEqual([{ role: "user", content: [
        { type: "video_url", video_url: { url: `data:${expectedMime};base64,dmlkZW8=` } },
      ] }]);
    });
  }
});

describe("OpenRouter image input", () => {
  for (const stream of [false, true]) {
    test.each([
      ["image/png", "image/png"],
      ["image/jpeg", "image/jpeg"],
      ["image/webp", "image/webp"],
      ["image/gif", "image/gif"],
      ["image/jpg", "image/jpeg"],
      ["image/pjpeg", "image/jpeg"],
      ["image/x-png", "image/png"],
      ["image/png; charset=binary", "image/png"],
      [" IMAGE/JPEG ", "image/jpeg"],
    ])(`${stream ? "streaming" : "JSON"} sends %s as an inline %s image`, async (mimeType, expectedMime) => {
      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Two images."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Two images." }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const image = { type: "image" as const, mime_type: mimeType, data: "aW1hZ2Ux" };
      const request: GenerationRequest = { model: "google/gemini-2.5-flash", messages: [
        { role: "system", content: "Describe the images." },
        { role: "user", content: [image] },
        { role: "assistant", content: "Show me another." },
        { role: "user", content: [{ type: "text", text: "Compare these." }, image,
          { type: "image", mime_type: "image/png", data: "aW1hZ2Uy" }] },
      ] };
      const original = structuredClone(request);
      if (stream) {
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.generateStream("placeholder", "", request)) chunks.push(chunk);
        expect(chunks.map((chunk) => chunk.token).join("")).toBe("Two images.");
      } else {
        expect((await provider.generate("placeholder", "", request)).content).toBe("Two images.");
      }
      const expectedImage = { type: "image_url", image_url: { url: `data:${expectedMime};base64,${image.data}` } };
      expect(sent.messages).toEqual([
        { role: "system", content: "Describe the images." },
        { role: "user", content: [expectedImage] },
        { role: "assistant", content: "Show me another." },
        { role: "user", content: [{ type: "text", text: "Compare these." }, expectedImage,
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2Uy" } }] },
      ]);
      // detail is optional and defaults to auto; input images need no output modalities.
      expect(sent.modalities).toBeUndefined();
      expect(sent.stream).toBe(stream);
      expect(request).toEqual(original);
    });
  }

  test("preserves image-first ordering within a user message", () => {
    expect(provider.serializeMessages([{ role: "user", content: [
      { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
      { type: "text", text: "Describe this image." },
    ] }])).toEqual([{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      { type: "text", text: "Describe this image." },
    ] }]);
  });
});

describe("OpenRouter audio input", () => {
  for (const stream of [false, true]) {
    test.each([
      ["audio/wav", "wav"],
      ["audio/mp3", "mp3"],
      ["audio/aiff", "aiff"],
      ["audio/aac", "aac"],
      ["audio/ogg", "ogg"],
      ["audio/flac", "flac"],
      ["audio/mpeg", "mp3"],
      ["audio/x-mp3", "mp3"],
      ["audio/x-wav", "wav"],
      ["audio/wave", "wav"],
      ["audio/x-aiff", "aiff"],
      ["audio/x-flac", "flac"],
      ["audio/ogg; codecs=opus", "ogg"],
      [" AUDIO/WAV ", "wav"],
      ["audio/webm", "webm"],
    ])(`${stream ? "streaming" : "JSON"} sends %s as raw base64 with format %s`, async (mimeType, format) => {
      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Heard it."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Heard it." }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const audio = { type: "audio" as const, mime_type: mimeType, data: "YXVkaW8=" };
      const request: GenerationRequest = { model: "google/gemini-2.5-flash", messages: [
        { role: "user", content: [audio] },
        { role: "assistant", content: "What should I listen for?" },
        { role: "user", content: [{ type: "text", text: "Transcribe this." }, audio] },
      ] };
      const original = structuredClone(request);
      if (stream) {
        const chunks: StreamChunk[] = [];
        for await (const chunk of provider.generateStream("placeholder", "", request)) chunks.push(chunk);
        expect(chunks.map((chunk) => chunk.token).join("")).toBe("Heard it.");
      } else {
        expect((await provider.generate("placeholder", "", request)).content).toBe("Heard it.");
      }
      const expectedAudio = { type: "input_audio", input_audio: { data: audio.data, format } };
      expect(sent.messages).toEqual([
        { role: "user", content: [expectedAudio] },
        { role: "assistant", content: "What should I listen for?" },
        { role: "user", content: [{ type: "text", text: "Transcribe this." }, expectedAudio] },
      ]);
      expect(sent.modalities).toBeUndefined();
      expect(sent.audio).toBeUndefined();
      expect(sent.stream).toBe(stream);
      expect(request).toEqual(original);
    });
  }
});

describe("OpenRouter endpoint discovery", () => {
  test("retains exact tier and region tags and caches by model and API URL", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: { endpoints: [
      { provider_name: "OpenAI", tag: "openai" },
      { provider_name: "OpenAI", tag: "openai/flex" },
      { provider_name: "OpenAI", tag: "openai/flex" },
      { provider_name: "Azure", tag: "azure/eu" },
    ] } })) as typeof fetch);
    const endpoints = await provider.fetchModelEndpoints("placeholder", "", " openai/gpt-5.4:floor ");
    expect(endpoints).toEqual([
      { name: "OpenAI", slug: "openai" },
      { name: "OpenAI", slug: "openai/flex" },
      { name: "Azure", slug: "azure/eu" },
    ]);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/models/openai/gpt-5.4/endpoints");
    expect(fetchSpy.mock.calls[0][1]?.headers).toHaveProperty("Authorization");
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5.4:nitro");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5");
    await provider.fetchModelEndpoints("placeholder", "https://proxy.test/v1", "openai/gpt-5.4");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toBe("https://proxy.test/v1/models/openai/gpt-5.4/endpoints");
    clearOpenRouterMetadataCache();
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5.4");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test("normalizes routing variants without stripping catalog variants", () => {
    expect(normalizeOpenRouterEndpointModel("vendor/model:free")).toBe("vendor/model:free");
    expect(normalizeOpenRouterEndpointModel("vendor/model:free:floor")).toBe("vendor/model:free");
    for (const model of ["", "model", "vendor/", "../model", "vendor/..", "vendor/model?url=other", "vendor/model/extra"]) {
      expect(normalizeOpenRouterEndpointModel(model)).toBeNull();
    }
  });

  test("reports discovery failures and allows a subsequent retry", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: { message: "Unavailable" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: { endpoints: [] } }));
    await expect(provider.fetchModelEndpoints("placeholder", "", "vendor/model")).rejects.toThrow("Unavailable");
    expect(await provider.fetchModelEndpoints("placeholder", "", "vendor/model")).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("OpenRouter Flex routing at dispatch", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "JSON"} retains a saved Flex restriction`, async () => {
      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const parameters = {};
      injectConnectionMetadataFlags({ provider: "openrouter", metadata: { openrouter: {
        provider_routing: { only: ["openai/flex"], order: ["openai/flex"], allow_fallbacks: true },
      } } }, parameters);
      const request = { model: "openai/gpt-5.4", messages: [{ role: "user" as const, content: "Hello" }], parameters };
      if (stream) { for await (const _chunk of provider.generateStream("placeholder", "", request)) { /* drain */ } }
      else await provider.generate("placeholder", "", request);
      expect(sent.provider).toEqual({ only: ["openai/flex"], order: ["openai/flex"], allow_fallbacks: true });
      expect(sent._openrouter).toBeUndefined();
      expect(sent.stream).toBe(stream);
    });
  }
});

describe("OpenRouter reasoning_details on tool calls", () => {
  const question = { role: "user" as const, content: "Weather in SF?" };
  const reasoningDetails: Record<string, unknown>[] = [
    { type: "reasoning.text", text: "Look it up.", signature: "opaque-signature", format: "anthropic-claude-v1", index: 0 },
    { type: "reasoning.encrypted", data: "encrypted-reasoning", format: "anthropic-claude-v1", index: 1 },
  ];

  test("streamed reasoning_details are rebuilt per block onto the tool-call terminal chunk", async () => {
    const events = [
      { choices: [{ delta: { reasoning: "Look ", reasoning_details: [{ type: "reasoning.text", text: "Look ", format: "anthropic-claude-v1", index: 0 }] } }] },
      { choices: [{ delta: { reasoning: "it up.", reasoning_details: [{ type: "reasoning.text", text: "it up.", index: 0 }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", signature: "opaque-signature", index: 0 }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "encrypted-reasoning", format: "anthropic-claude-v1", index: 1 }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"SF"}' } }] }, finish_reason: "tool_calls" }] },
    ];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, _init) => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch);
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.generateStream("placeholder", "", { model: "anthropic/claude-sonnet-4.5", messages: [question] })) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.reasoning || "").join("")).toBe("Look it up.");
    expect(chunks.at(-1)).toMatchObject({ finish_reason: "tool_calls", tool_calls: [{ name: "lookup", args: { city: "SF" }, call_id: "call_1" }] });
    expect(chunks.at(-1)?.reasoning_details).toEqual(reasoningDetails);
  });

  test("assistant reasoning_details are sent back unchanged on the tool_calls message", () => {
    const body = provider["buildBody"]({
      model: "anthropic/claude-sonnet-4.5",
      messages: [
        question,
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { city: "SF" } }], reasoning_details: reasoningDetails },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }] },
      ],
      parameters: {},
    }, false);
    expect(body.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"SF"}' } }],
        reasoning_details: reasoningDetails,
      },
      { role: "tool", tool_call_id: "call_1", content: "72F" },
    ]);
  });
});

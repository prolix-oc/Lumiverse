import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearOpenRouterMetadataCache, normalizeOpenRouterEndpointModel, OpenRouterProvider } from "./openrouter";
import { injectConnectionMetadataFlags } from "../../services/generation/connection-metadata";
import type { StreamChunk } from "../types";

const provider = new OpenRouterProvider();
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); clearOpenRouterMetadataCache(); });

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

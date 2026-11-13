import { describe, expect, test } from "bun:test";
import { ZAIProvider } from "./zai";

describe("ZAIProvider interleaved thinking", () => {
  const provider = new ZAIProvider();

  test("preserves character turns, user text, images and inline video in both dispatch modes", () => {
    for (const stream of [false, true]) {
      const body = (provider as any).buildBody({ model: "glm-5.3-flash", parameters: {
        thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high",
      }, messages: [
        { role: "system", content: "You are a reserved scholar. Speak with dry precision." },
        { role: "user", content: "Ready?" }, { role: "assistant", content: "Proceed." },
        { role: "user", content: [{ type: "text", text: "Typed direction\n\nTranscribed question" },
          { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
          { type: "video", mime_type: "video/mp4", data: "dmlkZW8=" }] },
      ] }, stream);
      expect(body.stream).toBe(stream);
      expect(body.messages.slice(0, 3)).toEqual([
        { role: "system", content: "You are a reserved scholar. Speak with dry precision." },
        { role: "user", content: "Ready?" }, { role: "assistant", content: "Proceed." },
      ]);
      expect(body.messages.at(-1).content).toEqual([
        { type: "text", text: "Typed direction\n\nTranscribed question" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
      ]);
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.reasoning_effort).toBe("high");
    }
    expect(() => (provider as any).buildBody({ model: "glm-5.3-flash", parameters: {}, messages: [
      { role: "user", content: [{ type: "video", mime_type: "video/webm", data: "dmlkZW8=" }] },
    ] }, true)).toThrow("MP4, MOV, or MKV");
  });

  test("replays a GLM-4.5 reasoning turn with its tool result in OpenAI wire format", () => {
    const body = (provider as any).buildBody(
      {
        model: "glm-4.5",
        parameters: {
          thinking: { type: "enabled", clear_thinking: false },
        },
        tools: [
          {
            name: "get_weather",
            description: "Gets current weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        messages: [
          { role: "user", content: "What is the weather in Boston?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "weather_1",
                name: "get_weather",
                input: { city: "Boston" },
              },
            ],
            reasoning_content: "I need current weather data before answering.",
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "weather_1",
                content: '{"temperature":"22C","condition":"sunny"}',
              },
            ],
          },
        ],
      },
      false,
    );

    expect(provider.capabilities.interleavedThinking).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Gets current weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: "What is the weather in Boston?" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "I need current weather data before answering.",
        tool_calls: [
          {
            id: "weather_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Boston"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "weather_1",
        content: '{"temperature":"22C","condition":"sunny"}',
      },
    ]);
  });

  test("offers the GLM-5.3 family alongside the GLM-4.5 models that support interleaved thinking", async () => {
    const models = await provider.listModels("", "");

    expect(models).toEqual(expect.arrayContaining([
      "glm-5.3-flash",
      "glm-5.3",
      "glm-5.2",
      "glm-4.5",
      "glm-4.5-air",
    ]));
  });
});

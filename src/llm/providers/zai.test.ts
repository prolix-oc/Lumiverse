import { describe, expect, test } from "bun:test";
import { ZAIProvider } from "./zai";

describe("ZAIProvider interleaved thinking", () => {
  const provider = new ZAIProvider();

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

  test("offers GLM-5.3 alongside the GLM-4.5 models that support interleaved thinking", async () => {
    const models = await provider.listModels("", "");

    expect(models).toEqual(expect.arrayContaining([
      "glm-5.3",
      "glm-5.2",
      "glm-4.5",
      "glm-4.5-air",
    ]));
  });
});

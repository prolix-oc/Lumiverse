import { describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "./openai-compatible";

class TestOpenAICompatibleProvider extends OpenAICompatibleProvider {
  readonly name = "test";
  readonly displayName = "Test";
  readonly defaultUrl = "https://example.com";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "openai" as const,
  };

  public inspect(content: unknown, reasoning: unknown) {
    return this.splitMirroredReasoning(content, reasoning);
  }
}

describe("OpenAICompatibleProvider reasoning mirroring", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("drops content when it exactly mirrors reasoning", () => {
    expect(provider.inspect("planning", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("drops content when it only differs by surrounding whitespace", () => {
    expect(provider.inspect("  planning\n", "planning")).toEqual({
      content: "",
      reasoning: "planning",
    });
  });

  test("preserves normal visible content when it differs from reasoning", () => {
    expect(provider.inspect("Answer", "planning")).toEqual({
      content: "Answer",
      reasoning: "planning",
    });
  });
});

// Shapes per github.com/openai/openai-node ChatCompletionAssistantMessageParam +
// ChatCompletionToolMessageParam:
//   assistant: { role:"assistant", content?, tool_calls?:[{id,type:"function",function:{name,arguments:string}}] }
//   tool:      { role:"tool", tool_call_id, content:string|Array<TextPart> }
describe("OpenAICompatibleProvider tool calling wire shape", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("assistant tool_use parts become tool_calls with stringified arguments", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "weather please" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking it up." },
              { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "SF" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_abc", content: "72F" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "Looking it up.",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "72F",
    });
  });

  test("assistant with only tool_use parts sets content to null", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "ping", input: {} },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    });
  });

  test("parallel tool_calls in one assistant message", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "a", input: { i: 1 } },
              { type: "tool_use", id: "call_2", name: "b", input: { i: 2 } },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1].tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "a", arguments: '{"i":1}' } },
      { id: "call_2", type: "function", function: { name: "b", arguments: '{"i":2}' } },
    ]);
  });

  test("multiple tool_results split into separate role:tool messages", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "A" },
              { type: "tool_result", tool_use_id: "call_2", content: "B" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ]);
  });

  test("string-content messages still work alongside structured ones", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
        parameters: {},
      },
      false,
    );
    expect(body.messages).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ]);
  });
});

// DeepSeek thinking-mode (deepseek-reasoner, deepseek-chat with thinking
// enabled) requires the previous turn's reasoning_content to be echoed back
// on the assistant message when continuing a conversation that involved a
// tool call. Without this, the API rejects the request with:
//   "The `reasoning_content` in the thinking mode must be passed back to
//   the API." (deepseek 400 invalid_request_error)
// Per DeepSeek's docs (api-docs.deepseek.com/guides/thinking_mode), the
// requirement applies ONLY to tool-call continuations — plain-text
// continuations don't need the field. Tests pin that scope deliberately.
describe("OpenAICompatibleProvider reasoning_content roundtrip", () => {
  const provider = new TestOpenAICompatibleProvider();

  test("assistant + tool_use parts + reasoning_content → field on assistant body", () => {
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_x", name: "lookup", input: { q: "SF" } },
            ],
            reasoning_content: "I should look up SF weather.",
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_x", content: "72F" },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_x", type: "function", function: { name: "lookup", arguments: '{"q":"SF"}' } },
      ],
      reasoning_content: "I should look up SF weather.",
    });
  });

  test("assistant + tool_use without reasoning_content → field absent (no undefined / null pollution)", () => {
    const body = (provider as any).buildBody(
      {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "ping", input: {} },
            ],
          },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
      ],
    });
    expect("reasoning_content" in body.messages[1]).toBe(false);
  });

  test("assistant + text-only parts (no tool_use) + reasoning_content → field NOT propagated", () => {
    // DeepSeek's docs are explicit: reasoning_content is required only on
    // tool-call continuations, NOT on plain-text continuations. We honour
    // that scope and deliberately do not propagate the field for non-tool
    // assistant turns, even when the script supplies it. If a future
    // provider requires broader propagation, expand this then — but pinning
    // the current narrow scope prevents accidental over-propagation.
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "what's 2+2?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "The answer is 4." },
            ],
            reasoning_content: "2+2 is basic arithmetic; the answer is 4.",
          },
          { role: "user", content: "thanks" },
        ],
        parameters: {},
      },
      false,
    );

    expect("reasoning_content" in body.messages[1]).toBe(false);
  });

  test("user-role message with reasoning_content → field ignored (only assistant tool-call turns carry reasoning)", () => {
    // Defensive: reasoning_content on a non-assistant message is meaningless
    // and shouldn't leak into the request body — DeepSeek's API doesn't
    // accept reasoning_content on user/system messages.
    const body = (provider as any).buildBody(
      {
        model: "deepseek-reasoner",
        messages: [
          { role: "user", content: "hello", reasoning_content: "WRONG SHOULD NOT APPEAR" },
        ],
        parameters: {},
      },
      false,
    );

    expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect("reasoning_content" in body.messages[0]).toBe(false);
  });
});

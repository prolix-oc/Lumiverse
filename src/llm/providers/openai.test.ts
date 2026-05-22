import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "./openai";

// Shapes per openai/openai-node src/resources/responses/responses.ts
//   ResponseFunctionToolCall  : { type:"function_call", call_id, name, arguments:string }
//   FunctionCallOutput        : { type:"function_call_output", call_id, output:string }
// Regular message items: { role, content:[{type:"input_text"|"input_image"|...}] }
describe("OpenAIProvider Responses API tool calling wire shape", () => {
  test("tool_use part becomes a function_call input item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as any).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "user", content: "weather please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking it up." },
            { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { role: "user", content: "weather please" },
      { role: "assistant", content: [{ type: "input_text", text: "Looking it up." }] },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: JSON.stringify({ city: "SF" }),
      },
    ]);
  });

  test("tool_result part becomes a function_call_output input item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as any).buildResponsesBody({
      model: "gpt-5",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "72F" },
    ]);
  });

  test("assistant with only tool_use emits no message item", () => {
    const provider = new OpenAIProvider();
    const body = (provider as any).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "ping", input: {} }],
        },
      ],
      parameters: {},
    });

    expect(body.input).toEqual([
      { role: "user", content: "x" },
      { type: "function_call", call_id: "call_1", name: "ping", arguments: "{}" },
    ]);
  });

  test("system messages extracted into instructions, not input", () => {
    const provider = new OpenAIProvider();
    const body = (provider as any).buildResponsesBody({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      parameters: {},
    });

    expect(body.instructions).toBe("be nice");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  });
});

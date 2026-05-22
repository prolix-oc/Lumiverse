import { describe, expect, test } from "bun:test";
import { GoogleProvider } from "./google";

// Shapes per googleapis/js-genai types.ts (Content, Part, FunctionCall,
// FunctionResponse). Content.role must be "user" or "model". FunctionCall is
// {name, args}. FunctionResponse is {name, response: Record<string, unknown>}
// where response uses "output"/"error" keys per the API docs.
describe("GoogleProvider tool calling wire shape", () => {
  test("tool_use part becomes a functionCall part on a model-role Content", () => {
    const provider = new GoogleProvider();
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
    const provider = new GoogleProvider();
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

  test("tool_result part becomes a functionResponse with output key", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "get_weather", input: { city: "SF" } },
          ],
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
    const provider = new GoogleProvider();
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

  test("functionResponse name is resolved from prior functionCall via tool_use_id", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "fc_1", name: "first", input: {} },
            { type: "tool_use", id: "fc_2", name: "second", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_2", content: "B" },
            { type: "tool_result", tool_use_id: "fc_1", content: "A" },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts).toEqual([
      { functionResponse: { name: "second", response: { output: "B" } } },
      { functionResponse: { name: "first", response: { output: "A" } } },
    ]);
  });

  test("JSON-shaped tool result is parsed and wrapped under output", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "fc_1", name: "lookup", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fc_1", content: '{"temp":72,"unit":"F"}' },
          ],
        },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents[1].parts[0]).toEqual({
      functionResponse: { name: "lookup", response: { output: { temp: 72, unit: "F" } } },
    });
  });

  test("string-only messages still serialize as { text } parts", () => {
    const provider = new GoogleProvider();
    const body = (provider as any).buildBody({
      model: "gemini-2.5-flash",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      parameters: {},
      tools: [{ name: "get_weather", description: "weather", parameters: {} }],
    });

    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be nice" }] });
  });
});

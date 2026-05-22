import { describe, expect, test } from "bun:test";
import { GoogleVertexProvider } from "./google-vertex";

// Vertex mirrors the Gemini contents shape: Content.role is "user" or "model",
// functionCall is {name, args}, functionResponse is {name, response} with
// "output"/"error" keys per the docs.
describe("GoogleVertexProvider tool calling wire shape", () => {
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

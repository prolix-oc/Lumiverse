import { expect, test } from "bun:test";
import { finalizeProviderResponse } from "./finalize-response";
import { redactResponseBody } from "../utils/redact-response";

const sse = (events: unknown[]) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

test("Chat Completions joins choices, reasoning, refusals, and indexed tool arguments while retaining final usage", () => {
  const events = [
    { id: "chat-1", object: "chat.completion.chunk", model: "example", choices: [
      { index: 0, delta: { role: "assistant", content: "Hello ", reasoning_content: "Think ", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "look", arguments: '{"city":' } }] }, finish_reason: null },
      { index: 1, delta: { role: "assistant", refusal: "Cannot " } },
    ] },
    { choices: [
      { index: 0, delta: { content: "world", reasoning_content: "carefully", tool_calls: [{ index: 0, function: { name: "up", arguments: '"Paris"}' } }] }, finish_reason: "tool_calls", native_finish_reason: "tool_use" },
      { index: 1, delta: { refusal: "answer" }, finish_reason: "stop" },
    ] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 } } },
    "[DONE]",
  ];
  const original = structuredClone(events);
  expect(finalizeProviderResponse(events)).toEqual({ terminal: true, failed: false, body: {
    id: "chat-1", object: "chat.completion", model: "example",
    choices: [
      { index: 0, message: { role: "assistant", content: "Hello world", reasoning_content: "Think carefully", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } }] }, finish_reason: "tool_calls", native_finish_reason: "tool_use" },
      { index: 1, message: { role: "assistant", refusal: "Cannot answer" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 } },
  } });
  expect(events).toEqual(original);
});

test("Responses uses the provider's final snapshot without duplicating streamed text or tools", () => {
  const response = { id: "resp-1", object: "response", status: "completed", output: [
    { id: "msg-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world", annotations: [] }] },
    { type: "function_call", name: "lookup", call_id: "call-1", arguments: '{"x":1}' },
  ], usage: { input_tokens: 10, output_tokens: 20 } };
  const result = finalizeProviderResponse([
    { type: "response.output_text.delta", delta: "Hello " },
    { type: "response.output_text.delta", delta: "world" },
    { type: "response.output_text.done", text: "Hello world" },
    { type: "response.completed", response },
  ]);
  expect(result).toEqual({ body: response, terminal: true, failed: false });
});

test("OpenRouter reasoning detail blocks join their streamed fields without collapsing unindexed blocks", () => {
  const body = finalizeProviderResponse([
    { choices: [{ delta: { reasoning_details: [{ index: 0, type: "reasoning.summary", summary: "Think " }] } }] },
    { choices: [{ delta: { reasoning_details: [{ index: 0, type: "reasoning.summary", summary: "carefully" }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "block-1" }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "block-2" }] }, finish_reason: "stop" }] },
  ]).body as any;
  expect(body.choices[0].message.reasoning_details).toEqual([
    { index: 0, type: "reasoning.summary", summary: "Think carefully" },
    { type: "reasoning.encrypted", data: "block-1" },
    { type: "reasoning.encrypted", data: "block-2" },
  ]);
});

test("Responses reconstructs partial text, summaries, and tool arguments when no final output snapshot is available", () => {
  const result = finalizeProviderResponse([
    { type: "response.created", response: { id: "resp-1", object: "response", status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 7, content_index: 8, delta: "Hello " },
    { type: "response.output_text.delta", output_index: 7, content_index: 8, delta: "world" },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Think " },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "carefully" },
    { type: "response.output_item.added", output_index: 9, item: { id: "item-1", type: "function_call", name: "lookup", call_id: "call-1", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"x":' },
    { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '1}' },
  ]);
  expect(result.terminal).toBe(false);
  expect(result.body).toEqual({ id: "resp-1", object: "response", status: "in_progress", output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Think carefully" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] },
    { id: "item-1", type: "function_call", name: "lookup", call_id: "call-1", arguments: '{"x":1}' },
  ] });
});

test("Responses done snapshots replace accumulated parts and arguments", () => {
  const result = finalizeProviderResponse([
    { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
    { type: "response.output_text.done", output_index: 0, text: "Hello" },
    { type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text: "Hello", annotations: [{ type: "url_citation", url: "https://example.test" }] } },
    { type: "response.output_item.added", output_index: 1, item: { id: "fn-1", type: "function_call", name: "test", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fn-1", delta: '{"x":' },
    { type: "response.function_call_arguments.done", item_id: "fn-1", arguments: '{"x":1}' },
    { type: "response.done", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } },
  ]);
  expect(result.terminal).toBe(true);
  expect((result.body as any).output[0].content[0]).toEqual({ type: "output_text", text: "Hello", annotations: [{ type: "url_citation", url: "https://example.test" }] });
  expect((result.body as any).output[1].arguments).toBe('{"x":1}');
});

test("Anthropic assembles message blocks, signatures, tool input, stop details, and usage", () => {
  const result = finalizeProviderResponse([
    { type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: "example", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider this." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "1" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 25 } },
    { type: "message_stop" },
  ]);
  expect(result).toEqual({ terminal: true, failed: false, body: {
    id: "msg-1", type: "message", role: "assistant", model: "example",
    content: [{ type: "thinking", thinking: "Consider this.", signature: "sig-1" }, { type: "text", text: "Hello world" }, { type: "tool_use", id: "tool-1", name: "lookup", input: { city: "Paris" } }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 25, cache_read_input_tokens: 5 },
  } });
});

test("Gemini and Vertex join text while keeping reasoning, tool signatures, grounding, and late usage", () => {
  const result = finalizeProviderResponse([
    { modelVersion: "gemini-example", responseId: "resp-1", candidates: [{ index: 0, content: { role: "model", parts: [{ thought: true, text: "Think " }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [{ thought: true, text: "carefully" }, { text: "Hello " }] } }] },
    { candidates: [{ index: 0, content: { parts: [{ text: "world", thoughtSignature: "text-signature" }, { functionCall: { name: "lookup", args: { city: "Paris" } }, thoughtSignature: "tool-signature" }] }, finishReason: "MAX_TOKENS", finishMessage: "Limit reached", groundingMetadata: { webSearchQueries: ["Paris"] } }] },
    { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } },
  ]);
  expect(result.terminal).toBe(true);
  expect(result.body).toEqual({ modelVersion: "gemini-example", responseId: "resp-1", candidates: [{ index: 0, content: { role: "model", parts: [
    { thought: true, text: "Think carefully" }, { text: "Hello world", thoughtSignature: "text-signature" }, { functionCall: { name: "lookup", args: { city: "Paris" } }, thoughtSignature: "tool-signature" },
  ] }, finishReason: "MAX_TOKENS", finishMessage: "Limit reached", groundingMetadata: { webSearchQueries: ["Paris"] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
});

test("redacts credentials assembled across text deltas and secret fields from discarded events", () => {
  const events = [
    { api_key: "discarded-secret" },
    { choices: [{ delta: { content: "provider-" } }] },
    { choices: [{ delta: { content: "credential discarded-" } }] },
    { choices: [{ delta: { content: "secret" }, finish_reason: "stop" }] },
    "[DONE]",
  ];
  const result = redactResponseBody(sse(events), ["provider-credential"]);
  expect(result.format).toBe("json");
  expect(JSON.parse(result.text).choices[0].message.content).toBe("[REDACTED] [REDACTED]");
  expect(result.text).not.toContain("data:");
  expect(result.redacted).toBe(true);
});

test("keeps the final provider error payload instead of a list of preceding events", () => {
  const error = { type: "error", error: { type: "overloaded_error", message: "Try later" } };
  expect(finalizeProviderResponse([{ choices: [{ delta: { content: "Partial" } }] }, error])).toEqual({ body: error, terminal: true, failed: true });
  const response = { id: "resp-1", status: "failed", error: { message: "Try later" }, output: [] };
  expect(finalizeProviderResponse([{ type: "response.failed", response }])).toEqual({ body: response, terminal: true, failed: true });
});

test("unknown delta streams and malformed event JSON cannot fall back to displaying chunks", () => {
  expect(() => redactResponseBody('data: {"delta":"hello"}\n\n', [])).toThrow();
  expect(() => redactResponseBody('data: {"api_key":"unfinished\n\n', [])).toThrow();
});

import { describe, expect, test } from "bun:test";
import { GoogleProvider } from "../src/llm/providers/google";
import { GoogleVertexProvider } from "../src/llm/providers/google-vertex";
import { buildInlineToolContinuation } from "../src/services/inline-tool-continuation";
import type { GenerationRequest, LlmMessage } from "../src/llm/types";

const google = new GoogleProvider();

/** Mock global fetch: capture the outgoing request body, return a canned response. */
function withMockedFetch(
  responseBody: object,
  fn: (getRequestBody: () => any) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  let captured: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = init?.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  return fn(() => captured).finally(() => {
    globalThis.fetch = original;
  });
}

describe("Gemini / Vertex capability", () => {
  test("both Google providers declare interleavedThinking", () => {
    expect(new GoogleProvider().capabilities.interleavedThinking).toBe(true);
    expect(new GoogleVertexProvider().capabilities.interleavedThinking).toBe(true);
  });
});

describe("Gemini captures thought_signature from responses", () => {
  test("non-streaming generate() puts thoughtSignature on the tool call", async () => {
    await withMockedFetch(
      {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "I should search" },
                {
                  functionCall: { name: "search", args: { q: "x" } },
                  thoughtSignature: "THOUGHT-SIG-123",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
      },
      async () => {
        const res = await google.generate("key", "https://x", {
          messages: [{ role: "user", content: "find x" }],
          model: "gemini-3-pro",
          parameters: { thinkingConfig: { thinkingBudget: 1024 } },
          tools: [{ name: "search", description: "", parameters: {} }],
        });
        expect(res.reasoning).toBe("I should search");
        expect(res.tool_calls).toHaveLength(1);
        expect(res.tool_calls![0]).toMatchObject({
          name: "search",
          args: { q: "x" },
          thought_signature: "THOUGHT-SIG-123",
        });
      },
    );
  });
});

describe("Gemini replays thought_signature on continuation", () => {
  test("a tool_use part with thought_signature → functionCall with that thoughtSignature", async () => {
    // Build a structured continuation as the loop would (tool_use carries the sig).
    const [assistantMsg, toolMsg] = buildInlineToolContinuation({
      structured: true,
      legacyAssistantOutput: "",
      roundContent: "",
      roundReasoning: "",
      toolCalls: [
        { name: "search", args: { q: "x" }, call_id: "call_1", thought_signature: "SIG-XYZ" },
      ],
      results: [
        {
          callId: "call_1",
          qualifiedName: "search",
          toolName: "search",
          toolDisplayName: "Search",
          result: "the answer",
        },
      ],
    });

    expect((assistantMsg.content as any[]).some((p) => p.thought_signature === "SIG-XYZ")).toBe(true);

    await withMockedFetch(
      { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] },
      async (getRequestBody) => {
        await google.generate("key", "https://x", {
          messages: [
            { role: "user", content: "find x" },
            assistantMsg,
            toolMsg,
          ],
          model: "gemini-3-pro",
          parameters: { thinkingConfig: { thinkingBudget: 1024 } },
          tools: [{ name: "search", description: "", parameters: {} }],
        });

        const body = getRequestBody();
        // Find the model turn carrying the functionCall.
        const modelTurn = body.contents.find(
          (c: any) => c.role === "model" && c.parts.some((p: any) => p.functionCall),
        );
        expect(modelTurn).toBeDefined();
        const fcPart = modelTurn.parts.find((p: any) => p.functionCall);
        expect(fcPart.functionCall).toMatchObject({ name: "search", args: { q: "x" } });
        // The captured opaque signature is replayed verbatim (NOT the dummy fallback).
        expect(fcPart.thoughtSignature).toBe("SIG-XYZ");

        // Tool result is a functionResponse keyed by the resolved tool name.
        const userTurn = body.contents.find(
          (c: any) => c.role === "user" && c.parts.some((p: any) => p.functionResponse),
        );
        expect(userTurn).toBeDefined();
        const frPart = userTurn.parts.find((p: any) => p.functionResponse);
        expect(frPart.functionResponse.name).toBe("search");
        expect(frPart.functionResponse.response).toMatchObject({ output: "the answer" });
      },
    );
  });
});

describe("Gemini streaming captures thought_signature", () => {
  test("streamed functionCall carries thoughtSignature on the tool call", async () => {
    const sse =
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "search", args: { q: "x" } }, thoughtSignature: "STREAM-SIG" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n`;

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
    try {
      const chunks: any[] = [];
      for await (const c of google.generateStream("key", "https://x", {
        messages: [{ role: "user", content: "find x" }],
        model: "gemini-3-pro",
        parameters: { thinkingConfig: { thinkingBudget: 1024 } },
        tools: [{ name: "search", description: "", parameters: {} }],
      })) {
        chunks.push(c);
      }
      const withTools = chunks.find((c) => c.tool_calls);
      expect(withTools.tool_calls[0].thought_signature).toBe("STREAM-SIG");
    } finally {
      globalThis.fetch = original;
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { GenerationResponse } from "../llm/types";
import {
  AGENT_ARGUMENT_MAX_BYTES,
  AGENT_JSON_DEPTH_MAX,
  AGENT_JSON_NODE_MAX,
  AgentAccountingFailure,
  assertJsonTextBounds,
  evaluateOutputTokens,
  settleOutputTokens,
} from "./agent-runtime-accounting";

describe("agent runtime accounting", () => {
  test("rejects arguments before parsing when byte, depth, or node bounds are exceeded", () => {
    expect(() => assertJsonTextBounds(`"${"x".repeat(AGENT_ARGUMENT_MAX_BYTES)}"`, {
      maxBytes: AGENT_ARGUMENT_MAX_BYTES,
      maxDepth: AGENT_JSON_DEPTH_MAX,
      maxNodes: AGENT_JSON_NODE_MAX,
    })).toThrow(AgentAccountingFailure);
    expect(() => assertJsonTextBounds(`${"[".repeat(AGENT_JSON_DEPTH_MAX + 2)}0${"]".repeat(AGENT_JSON_DEPTH_MAX + 2)}`, {
      maxDepth: AGENT_JSON_DEPTH_MAX,
    })).toThrow(AgentAccountingFailure);
    expect(() => assertJsonTextBounds(`[${Array.from({ length: AGENT_JSON_NODE_MAX + 1 }, () => "0").join(",")}]`, {
      maxNodes: AGENT_JSON_NODE_MAX,
    })).toThrow(AgentAccountingFailure);
  });

  test("charges the greater of valid provider usage and observed output", () => {
    const response = { content: "observed", finish_reason: "stop" } as any;
    expect(settleOutputTokens({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, response, 64).tokens)
      .toBeGreaterThanOrEqual(8);
    expect(() => settleOutputTokens(
      { prompt_tokens: 1, completion_tokens: -1, total_tokens: 0 },
      response,
      64,
    )).toThrow("provider_protocol_error");
    expect(() => settleOutputTokens(
      { prompt_tokens: 1, completion_tokens: 65, total_tokens: 66 },
      response,
      64,
    )).toThrow("child_output_token_limit_exceeded");

    for (const malformed of [null, false, "invalid", []]) {
      expect(() => settleOutputTokens(malformed, response, 64))
        .toThrow("provider_protocol_error");
    }
  });

  test("uses a precomputed tokenizer count for provider-shaped reasoning output", () => {
    const allowance = 128;
    const response = {
      content: "",
      reasoning: "r".repeat(397),
      finish_reason: "stop",
    } satisfies GenerationResponse;
    const usage = { prompt_tokens: 1, completion_tokens: allowance, total_tokens: allowance + 1 };
    expect(settleOutputTokens(usage, response, allowance, { observedTokens: allowance }))
      .toMatchObject({ tokens: allowance, observed: allowance });
    expect(() => settleOutputTokens(usage, response, allowance))
      .toThrow("child_output_token_limit_exceeded");
  });

  test("rejects invalid or over-allowance precomputed counts", () => {
    const response = { content: "ok", finish_reason: "stop" } satisfies GenerationResponse;
    const usage = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 };
    const invalidCounts = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];

    for (const observedTokens of invalidCounts) {
      expect(() => settleOutputTokens(usage, response, 128, { observedTokens }))
        .toThrow("provider_protocol_error");
    }
    expect(() => settleOutputTokens(usage, response, 128, { observedTokens: 129 }))
      .toThrow("child_output_token_limit_exceeded");
  });

  test("retains the actual observed count in an over-allowance settlement", () => {
    const settlement = evaluateOutputTokens(
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      { content: "", finish_reason: "stop" },
      4,
      { observedTokens: 7 },
    );

    expect(settlement).toMatchObject({
      tokens: 7,
      observed: 7,
      failure: {
        code: "child_output_token_limit_exceeded",
        budget: "child_output_tokens",
        limit: 4,
        observed: 7,
      },
    });
  });
});

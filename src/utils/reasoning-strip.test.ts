import { describe, expect, test } from "bun:test";
import {
  GuidedReasoningStreamParser,
  closeUnterminatedDelimitedReasoning,
  extractDelimitedReasoning,
  resolveReasoningDelimiters,
  separateDelimitedReasoning,
  wrapDelimitedReasoningStream,
} from "./reasoning-strip";

describe("GuidedReasoningStreamParser", () => {
  test("splits reasoning at the start across chunk boundaries and closes on split suffix", () => {
    const parser = new GuidedReasoningStreamParser({ prefix: "<think>", suffix: "</think>" }, true);

    expect(parser.push("<thi")).toEqual({ content: "", reasoning: "" });
    expect(parser.push("nk>plan")).toEqual({ content: "", reasoning: "" });
    expect(parser.push("</thi")).toEqual({ content: "", reasoning: "pl" });
    expect(parser.push("nk>Hello")).toEqual({ content: "Hello", reasoning: "an" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });

  test("detects mid-response reasoning re-entry without swallowing surrounding content", () => {
    const parser = new GuidedReasoningStreamParser({ prefix: "<think>", suffix: "</think>" }, true);

    expect(parser.push("Visible <thi")).toEqual({ content: "Visible ", reasoning: "" });
    expect(parser.push("nk>plan</think> done")).toEqual({ content: " done", reasoning: "plan" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });

  test("drops structural leading blank lines after stripped reasoning at the start of a stream", () => {
    const parser = new GuidedReasoningStreamParser({ prefix: "<think>", suffix: "</think>" }, true);

    expect(parser.push("<think>plan</think>")).toEqual({ content: "", reasoning: "plan" });
    expect(parser.push("\n\nAnswer")).toEqual({ content: "Answer", reasoning: "" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });

  test("heals newline seams when visible content resumes after reasoning in a later chunk", () => {
    const parser = new GuidedReasoningStreamParser({ prefix: "<think>", suffix: "</think>" }, true);

    expect(parser.push("Visible line\n<think>plan</think>")).toEqual({
      content: "Visible line\n",
      reasoning: "plan",
    });
    expect(parser.push("\nNext line")).toEqual({ content: "Next line", reasoning: "" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });

  test("stays in content mode when delimiters are incomplete", () => {
    const parser = new GuidedReasoningStreamParser({ prefix: "<think>", suffix: "" }, true);
    expect(parser.push("<think>not parsed")).toEqual({ content: "<think>not parsed", reasoning: "" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });
});

describe("reasoning delimiter helpers", () => {
  test("normalizes configured delimiter newlines", () => {
    expect(resolveReasoningDelimiters({ prefix: "\n<think>\n", suffix: "\n</think>\n" })).toEqual({
      prefix: "<think>",
      suffix: "</think>",
    });
  });

  test("extracts closed and trailing unclosed reasoning blocks", () => {
    const delimiters = { prefix: "<think>", suffix: "</think>" };
    expect(extractDelimitedReasoning("A<think>one</think>B<think>two", delimiters)).toEqual({
      cleaned: "AB",
      reasoning: "onetwo",
    });
  });

  test("heals newline seams left behind after reasoning extraction", () => {
    const delimiters = { prefix: "<think>", suffix: "</think>" };
    expect(extractDelimitedReasoning("A\n<think>one</think>\nB", delimiters)).toEqual({
      cleaned: "A\nB",
      reasoning: "one",
    });
  });

  test("drops structural blank lines when reasoning wraps the start or end of visible content", () => {
    const delimiters = { prefix: "<think>", suffix: "</think>" };

    expect(extractDelimitedReasoning("<think>one</think>\n\nB", delimiters)).toEqual({
      cleaned: "B",
      reasoning: "one",
    });

    expect(extractDelimitedReasoning("A\n\n<think>one</think>", delimiters)).toEqual({
      cleaned: "A",
      reasoning: "one",
    });
  });

  test("closes unterminated reasoning only when a valid delimiter pair exists", () => {
    expect(closeUnterminatedDelimitedReasoning("<think>half", { prefix: "<think>", suffix: "</think>" })).toBe("<think>half</think>");
    expect(closeUnterminatedDelimitedReasoning("<think>half", { prefix: "<think>", suffix: "" })).toBe("<think>half");
  });

  test("separates tagged CoT from visible content and preserves provider reasoning", () => {
    expect(
      separateDelimitedReasoning("Answer<think>plan</think>", "native", { prefix: "<think>", suffix: "</think>" }, true),
    ).toEqual({
      content: "Answer",
      reasoning: "native\nplan",
    });
  });

  test("wraps streamed tagged CoT into reasoning chunks", async () => {
    async function* source() {
      yield { token: "<thi" };
      yield { token: "nk>plan</think>Answer", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
      yield { token: "", finish_reason: "stop" as const };
    }

    const chunks = [];
    for await (const chunk of wrapDelimitedReasoningStream(source(), { prefix: "<think>", suffix: "</think>" }, true)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        token: "Answer",
        reasoning: "plan",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      {
        token: "",
        finish_reason: "stop",
      },
    ]);
  });
});

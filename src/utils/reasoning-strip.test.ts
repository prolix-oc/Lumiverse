import { describe, expect, test } from "bun:test";
import {
  GuidedReasoningStreamParser,
  closeUnterminatedDelimitedReasoning,
  extractDelimitedReasoning,
  resolveReasoningDelimiters,
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

  test("closes unterminated reasoning only when a valid delimiter pair exists", () => {
    expect(closeUnterminatedDelimitedReasoning("<think>half", { prefix: "<think>", suffix: "</think>" })).toBe("<think>half</think>");
    expect(closeUnterminatedDelimitedReasoning("<think>half", { prefix: "<think>", suffix: "" })).toBe("<think>half");
  });
});

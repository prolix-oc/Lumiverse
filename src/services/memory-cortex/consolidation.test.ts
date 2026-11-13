import { describe, expect, test } from "bun:test";

import {
  getSummaryQualityIssue,
  parseGeneratedSummary,
  parseGeneratedSummaryResponse,
} from "./consolidation";

describe("semantic consolidation quality gate", () => {
  const source = [
    "Mara entered the observatory and found the star map missing from its locked case.",
    "Tovin admitted that he had sold the map to the Glass Syndicate before the expedition began.",
    "Mara refused to abandon the expedition and promised to recover the map before dawn.",
    "The pair left the observatory together for the Syndicate's river warehouse.",
  ].join(" ");

  test("rejects a transcript-like candidate with copied source wording", () => {
    const candidate = [
      "Mara entered the observatory and found the star map missing from its locked case.",
      "Tovin admitted that he had sold the map to the Glass Syndicate before the expedition began.",
    ].join(" ");

    expect(getSummaryQualityIssue(candidate, source, 120)).toContain("copies too much source wording");
  });

  test("accepts a concise synthesis of durable changes", () => {
    const candidate = "Mara learned that Tovin had betrayed the expedition by selling its star map to the Glass Syndicate. Despite the betrayal, they joined forces to recover it from the river warehouse before dawn.";

    expect(getSummaryQualityIssue(candidate, source, 120)).toBeNull();
  });

  test("enforces the configured word budget", () => {
    const candidate = Array.from({ length: 41 }, () => "continuity").join(" ");

    expect(getSummaryQualityIssue(candidate, source, 40)).toContain("40-word limit");
  });

  test("accepts a usable plain-text note when a provider does not return JSON", () => {
    const response = "Mara learned that Tovin had sold the expedition's map, but they agreed to recover it from the Glass Syndicate before dawn.";

    expect(parseGeneratedSummary(response)).toEqual({ summary: response, title: null });
  });

  test("does not misread malformed JSON as a plain-text summary", () => {
    expect(parseGeneratedSummary('{"summary":"unfinished"')).toBeNull();
  });

  test("reads a scene continuity note from its dedicated tool call", () => {
    expect(parseGeneratedSummaryResponse({
      content: "",
      tool_calls: [{
        name: "write_scene_continuity",
        args: {
          title: "The Missing Map",
          summary: "Mara discovered Tovin's betrayal, but they agreed to recover the sold map together before dawn.",
          changes: ["Mara learned Tovin sold the map"],
        },
      }],
    }, "scene")).toEqual({
      title: "The Missing Map",
      summary: "Mara discovered Tovin's betrayal, but they agreed to recover the sold map together before dawn.",
    });
  });

  test("ignores unrelated extraction tool calls", () => {
    expect(parseGeneratedSummaryResponse({
      content: "",
      tool_calls: [{ name: "score_salience", args: { importance: 8 } }],
    }, "scene")).toBeNull();
  });
});

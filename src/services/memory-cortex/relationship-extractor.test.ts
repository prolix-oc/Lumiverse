import { describe, expect, test } from "bun:test";
import { extractRelationshipsHeuristic } from "./relationship-extractor";

describe("extractRelationshipsHeuristic", () => {
  test("keeps extracting directed relationships when many unrelated entity names are present", () => {
    const fillerNames = Array.from({ length: 40 }, (_, i) => `Extra${i}`);
    const relationships = extractRelationshipsHeuristic(
      "Alice kissed Bob before the crowd could react.",
      ["Alice", "Bob", ...fillerNames],
    );

    expect(relationships).toContainEqual(
      expect.objectContaining({
        source: "Alice",
        target: "Bob",
        type: "lover",
      }),
    );
  });

  test("deduplicates repeated entity names before generating relationships", () => {
    const relationships = extractRelationshipsHeuristic(
      "Alice and Bob fought side by side until dawn.",
      ["Alice", "Bob", "alice", "Bob"],
    ).filter((rel) => rel.source === "Alice" && rel.target === "Bob" && rel.type === "ally");

    expect(relationships).toHaveLength(1);
  });

  test("falls back to emotional context when explicit pair scans are skipped", () => {
    const spacer = " ".repeat(320);
    const relationships = extractRelationshipsHeuristic(
      `Alice${spacer}Bob`,
      ["Alice", "Bob"],
      ["joy"],
    );

    expect(relationships).toEqual([
      expect.objectContaining({
        source: "Alice",
        target: "Bob",
        type: "ally",
        label: "shared joy",
      }),
    ]);
  });
});

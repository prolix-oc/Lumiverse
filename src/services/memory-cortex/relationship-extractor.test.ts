import { describe, expect, test } from "bun:test";
import { extractRelationshipsHeuristic } from "./relationship-extractor";

describe("extractRelationshipsHeuristic", () => {
  test("hierarchical verbs point from the subordinate to the superior", () => {
    const relationships = extractRelationshipsHeuristic("Alice commanded Bob. Bob obeyed Alice.", ["Alice", "Bob"]);
    expect(relationships.filter((rel) => rel.type === "serves")).toEqual([
      expect.objectContaining({ source: "Bob", target: "Alice", type: "serves", label: "serves" }),
    ]);
  });

  test("professional roles keep their direction and do not become family relationships", () => {
    for (const content of ["Bob is Alice's apprentice.", "Bob is an apprentice of Alice."]) {
      const relationships = extractRelationshipsHeuristic(content, ["Alice", "Bob"]);
      expect(relationships).toContainEqual(expect.objectContaining({ source: "Alice", target: "Bob", type: "mentor" }));
      expect(relationships.some((rel) => rel.type === "child")).toBe(false);
    }
    expect(extractRelationshipsHeuristic("Bob is Alice's commander.", ["Alice", "Bob"]))
      .toContainEqual(expect.objectContaining({ source: "Alice", target: "Bob", type: "serves" }));
    expect(extractRelationshipsHeuristic("Bob is Alice's father.", ["Alice", "Bob"]))
      .toContainEqual(expect.objectContaining({ source: "Bob", target: "Alice", type: "parent" }));
  });

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

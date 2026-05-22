import { describe, expect, test } from "bun:test";

import { parseToolCallResults } from "./salience-sidecar";

describe("parseToolCallResults", () => {
  test("filters low-signal sidecar junk while preserving supported extraction", () => {
    const result = parseToolCallResults([
      {
        name: "score_salience",
        args: {
          importance: 7,
          emotional_tones: ["tension", "joy"],
          narrative_flags: ["discovery"],
          key_facts: ["betrayal", "Melina promised to return", "THE MOOD"],
        },
      },
      {
        name: "extract_entities",
        args: {
          entities: [
            { name: "Melina", type: "character", role: "subject" },
            { name: "Barely", type: "character" },
            { name: "The Pale", type: "location" },
          ],
          discovered_aliases: [
            { canonical_name: "Melina", alias: "Mel", evidence: "Call me Mel" },
            { canonical_name: "AI", alias: "Guide" },
            { canonical_name: "Melina", alias: "Personal cost", evidence: "called her personal cost" },
            { canonical_name: "Melina", alias: "Among the crowd", evidence: "known as among the crowd" },
            { canonical_name: "Melina", alias: "Guide" },
          ],
          status_changes: [
            { entity: "Melina", change: "arrived", detail: "Melina arrived in Dustwell" },
            { entity: "Personal", change: "injured", detail: "Invalid noise" },
          ],
        },
      },
      {
        name: "extract_relationships",
        args: {
          relationships: [
            { source: "Melina", target: "Kael", type: "ally", label: "trusted allies", sentiment: 0.8 },
            { source: "Strange", target: "Kael", type: "ally", label: "hallucinated pair" },
            { source: "Melina", target: "Melina", type: "ally", label: "self reference" },
          ],
        },
      },
      {
        name: "extract_font_colors",
        args: {
          color_attributions: [
            { hex_color: "#ff9999", character_name: "Melina", usage_type: "speech" },
            { hex_color: "#aaaaaa", character_name: "Personal", usage_type: "thought" },
          ],
        },
      },
    ]);

    expect(result.score).toBe(0.7);
    expect(result.keyFacts).toEqual(["Melina promised to return"]);
    expect(result.entitiesPresent.map((entity) => entity.name)).toEqual(["Melina", "The Pale"]);
    expect(result.discoveredAliases).toEqual([
      { canonicalName: "Melina", alias: "Mel", evidence: "Call me Mel" },
    ]);
    expect(result.statusChanges).toEqual([
      { entity: "Melina", change: "arrived", detail: "Melina arrived in Dustwell" },
    ]);
    expect(result.relationshipsShown).toEqual([
      { source: "Melina", target: "Kael", type: "ally", label: "trusted allies", sentiment: 0.8 },
    ]);
    expect(result.fontColors).toEqual([
      { hexColor: "#ff9999", characterName: "Melina", usageType: "speech" },
    ]);
  });
});

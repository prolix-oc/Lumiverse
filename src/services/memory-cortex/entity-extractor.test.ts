import { describe, expect, test } from "bun:test";
import { extractEntitiesHeuristic } from "./entity-extractor";
import type { MemoryEntity } from "./types";
import { getDefaultEntityExtractionFilters } from "./entity-extraction-filters";

const KNOWN_ENTITIES: MemoryEntity[] = [];

describe("extractEntitiesHeuristic entity extraction filters", () => {
  test("creates a clean protected location and suppresses extra entities from the same header line", () => {
    const filters = getDefaultEntityExtractionFilters();
    filters.location.protectedTerms = ["📍"];
    filters.location.cleanupPatterns = [
      "/^.*📍\\s*/",
      "/\\s*\\|.*$/",
      "/\\s*\\].*$/",
    ];
    filters.character.rejectedTerms = ["📍"];
    filters.item.rejectedTerms = ["📍"];
    filters.faction.rejectedTerms = ["📍"];
    filters.concept.rejectedTerms = ["📍"];
    filters.event.rejectedTerms = ["📍"];

    const content = [
      "[ 🕰️ Time 8:49 AM | 🗓️ Monday, September 4, 2023 AD | 📍 University - Dormitory Stairwell, Between 3rd and 2nd Floor | ☀️ Clear, 72F ]",
      "Melina looked toward the landing and steadied her breath.",
    ].join("\n");

    const entities = extractEntitiesHeuristic(
      content,
      KNOWN_ENTITIES,
      ["Melina"],
      [],
      0,
      filters,
    );

    expect(entities.map((entity) => entity.name)).toEqual([
      "University - Dormitory Stairwell, Between 3rd and 2nd Floor",
      "Melina",
    ]);
    expect(entities[0].type).toBe("location");
  });
});

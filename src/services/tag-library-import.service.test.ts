import { describe, expect, test } from "bun:test";
import {
  buildTagLibraryImportPlan,
  parseTagLibraryBackupText,
  normalizeLooseCharacterKey,
  normalizeTagLibraryFilename,
  parseTagLibraryBackupJson,
} from "./tag-library-import.service";

describe("TagLibrary backup parsing", () => {
  test("maps tag ids to names and skips empty assignments", () => {
    const parsed = parseTagLibraryBackupJson({
      tags: [
        { id: "one", name: "Tag One" },
        { id: "two", name: "Tag Two" },
      ],
      tag_map: {
        "Alpha.png": ["one", "two", "missing"],
        "Beta.png": [],
      },
    });

    expect(parsed.tagDefinitions).toBe(2);
    expect(parsed.characterMappings).toBe(1);
    expect(parsed.assignmentsByFilename.get("alpha.png")).toEqual(["Tag One", "Tag Two"]);
    expect(parsed.assignmentsByFilename.has("beta.png")).toBe(false);
  });

  test("accepts tagMap alias and BOM-prefixed JSON payloads", async () => {
    const result = parseTagLibraryBackupText(`\uFEFF${JSON.stringify({
      tags: [{ id: "one", name: "Tag One" }],
      tagMap: { "Alpha.png": ["one"] },
    })}`);

    expect(result.tagDefinitions).toBe(1);
    expect(result.characterMappings).toBe(1);
  });
});

describe("TagLibrary matching", () => {
  test("prefers source filename matches before looser fallbacks", () => {
    const backup = parseTagLibraryBackupJson({
      tags: [{ id: "one", name: "Imported Tag" }],
      tag_map: {
        "Alpha.png": ["one"],
        "gamma-card.png": ["one"],
      },
    });

    const { plans, matchedBy, unmatchedFilenames } = buildTagLibraryImportPlan(
      [
        {
          id: "char-1",
          name: "Alpha Renamed",
          tags: ["Existing"],
          sourceFilename: "Alpha.png",
          imageOriginalFilename: null,
        },
        {
          id: "char-2",
          name: "Gamma Card",
          tags: [],
          sourceFilename: null,
          imageOriginalFilename: null,
        },
      ],
      backup,
    );

    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.characterId === "char-1")).toMatchObject({
      addedTags: ["Imported Tag"],
      matchedVia: "source_filename",
    });
    expect(plans.find((plan) => plan.characterId === "char-2")).toMatchObject({
      addedTags: ["Imported Tag"],
      matchedVia: "normalized_name",
    });
    expect(matchedBy.source_filename).toBe(1);
    expect(matchedBy.normalized_name).toBe(1);
    expect(unmatchedFilenames).toEqual([]);
  });

  test("keeps existing tags and reports unmatched filenames", () => {
    const backup = parseTagLibraryBackupJson({
      tags: [{ id: "one", name: "Tag One" }],
      tag_map: {
        "Alpha.png": ["one"],
        "Missing.png": ["one"],
      },
    });

    const { plans, unmatchedFilenames } = buildTagLibraryImportPlan(
      [
        {
          id: "char-1",
          name: "Alpha",
          tags: ["Tag One", "Existing"],
          sourceFilename: "Alpha.png",
          imageOriginalFilename: null,
        },
      ],
      backup,
    );

    expect(plans).toEqual([
      {
        characterId: "char-1",
        nextTags: ["Tag One", "Existing"],
        addedTags: [],
        matchedVia: "source_filename",
      },
    ]);
    expect(unmatchedFilenames).toEqual(["missing.png"]);
  });
});

describe("TagLibrary normalization helpers", () => {
  test("normalizes filenames and loose character keys conservatively", () => {
    expect(normalizeTagLibraryFilename("Folder/Alpha.PNG")).toBe("alpha.png");
    expect(normalizeLooseCharacterKey("Sirius_Symboli___A_Quaint_Fuchu_Meeting.png")).toBe("sirius symboli a quaint fuchu meeting");
  });
});

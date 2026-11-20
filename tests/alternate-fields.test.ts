/**
 * SillyTavern alternate-field compatibility.
 *
 * ST's CharacterLibrary stores variants under `extensions.alternate_fields`
 * keyed by `alt_*` names with `{ title, content }` entries; Lumiverse keys by
 * field name with `{ id, label, content }`. These tests pin the conversion, the
 * merge rules, and the three import paths that must agree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { env } from "../src/env";
import { embedPngTextChunk } from "../src/services/character-export.service";
import type { Character, CreateCharacterInput } from "../src/types/character";
import { buildCardReplacementInput } from "../src/routes/characters.routes";
import {
  convertAlternateEntries,
  extractCardFromPng,
  mergeSillyTavernAlternateFields,
  parseCardJson,
} from "../src/services/character-card.service";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

const ST_ALL_SIX = {
  alt_descriptions: [{ title: "Vampire AU", content: "A vampire description." }],
  alt_personalities: [{ title: "Cold", content: "Distant and formal." }],
  alt_scenarios: [{ title: "Winter", content: "A snowbound village." }],
  alt_example_dialogue: [{ title: "Formal", content: "<START>\n{{char}}: Good evening." }],
  alt_main_prompts: [{ title: "Strict", content: "Stay in character." }],
  alt_post_history: [{ title: "Terse", content: "Answer briefly." }],
};

const NATIVE_KEYS = [
  "description",
  "personality",
  "scenario",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
];

function cardData(extensions: Record<string, unknown>): Record<string, unknown> {
  return { name: "Test", extensions };
}

/**
 * ST writes `alternate_fields` inside `data.extensions.alternate_fields`, so the
 * alt_* keys live one level below the extension object itself.
 */
function stCard(alternateFields: Record<string, unknown>): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: cardData({ alternate_fields: alternateFields }),
  };
}

describe("convertAlternateEntries", () => {
  test("maps title to label, keeps content, and mints an id", () => {
    const [entry] = convertAlternateEntries([{ title: "Vampire AU", content: "text" }]);
    expect(entry!.label).toBe("Vampire AU");
    expect(entry!.content).toBe("text");
    expect(typeof entry!.id).toBe("string");
    expect(entry!.id.length).toBeGreaterThan(0);
  });

  test("accepts legacy bare-string entries and labels them positionally", () => {
    const converted = convertAlternateEntries(["first", "second"]);
    expect(converted.map((entry) => entry.label)).toEqual(["Alternate 1", "Alternate 2"]);
    expect(converted.map((entry) => entry.content)).toEqual(["first", "second"]);
  });

  test("accepts `description` as the text field", () => {
    const [entry] = convertAlternateEntries([{ description: "from description" }]);
    expect(entry!.content).toBe("from description");
  });

  test("reuses an existing id and label when present", () => {
    const [entry] = convertAlternateEntries([{ id: "stable-id", label: "Named", content: "x" }]);
    expect(entry!.id).toBe("stable-id");
    expect(entry!.label).toBe("Named");
  });

  test("drops entries with no usable text and non-arrays", () => {
    expect(convertAlternateEntries([{ title: "no content" }, 42, null])).toEqual([]);
    expect(convertAlternateEntries("not an array")).toEqual([]);
    expect(convertAlternateEntries(undefined)).toEqual([]);
  });

  test("keeps an empty-string variant rather than dropping it", () => {
    expect(convertAlternateEntries([{ title: "Blank", content: "" }])).toHaveLength(1);
  });
});

describe("mergeSillyTavernAlternateFields", () => {
  test("converts all six SillyTavern keys", () => {
    const extensions: Record<string, any> = { alternate_fields: { ...ST_ALL_SIX } };
    mergeSillyTavernAlternateFields(extensions);

    for (const key of NATIVE_KEYS) {
      expect(Array.isArray(extensions.alternate_fields[key])).toBe(true);
      expect(extensions.alternate_fields[key]).toHaveLength(1);
      expect(typeof extensions.alternate_fields[key][0].id).toBe("string");
    }
    expect(extensions.alternate_fields.description[0].label).toBe("Vampire AU");
    expect(extensions.alternate_fields.system_prompt[0].content).toBe("Stay in character.");
    // Source keys survive for portability.
    expect(extensions.alternate_fields.alt_descriptions).toHaveLength(1);
  });

  test("preserves existing native entries and appends converted ones", () => {
    const existing = { id: "keep", label: "Existing", content: "keep me" };
    const extensions: Record<string, any> = {
      alternate_fields: {
        description: [existing],
        alt_descriptions: [{ title: "Vampire AU", content: "new" }],
      },
    };
    mergeSillyTavernAlternateFields(extensions);

    const list = extensions.alternate_fields.description;
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(existing);
    expect(list[1].label).toBe("Vampire AU");
  });

  test("does not duplicate an identical label+content pair", () => {
    const extensions: Record<string, any> = {
      alternate_fields: {
        description: [{ id: "a", label: "Same", content: "same text" }],
        alt_descriptions: [{ title: "Same", content: "same text" }],
      },
    };
    mergeSillyTavernAlternateFields(extensions);
    expect(extensions.alternate_fields.description).toHaveLength(1);
  });

  test("retains mixed SillyTavern and native alternates without duplication", () => {
    const extensions: Record<string, any> = {
      alternate_fields: {
        description: [{ id: "n1", label: "Native", content: "native text" }],
        alt_descriptions: [
          { title: "Native", content: "native text" },
          { title: "From ST", content: "st text" },
        ],
      },
    };
    mergeSillyTavernAlternateFields(extensions);
    const labels = extensions.alternate_fields.description.map((entry: any) => entry.label);
    expect(labels).toEqual(["Native", "From ST"]);
  });

  test("leaves extensions without alternate_fields untouched", () => {
    const extensions: Record<string, any> = { fav: true };
    mergeSillyTavernAlternateFields(extensions);
    expect(extensions.alternate_fields).toBeUndefined();
  });

  test("is idempotent", () => {
    const extensions: Record<string, any> = { alternate_fields: { ...ST_ALL_SIX } };
    mergeSillyTavernAlternateFields(extensions);
    const once = JSON.stringify(extensions.alternate_fields.description);
    mergeSillyTavernAlternateFields(extensions);
    expect(JSON.stringify(extensions.alternate_fields.description)).toBe(once);
  });
});

describe("import paths", () => {
  test("JSON import converts all six fields", () => {
    const input = parseCardJson(stCard({ ...ST_ALL_SIX }));
    for (const key of NATIVE_KEYS) {
      expect(input.extensions?.alternate_fields?.[key]).toHaveLength(1);
    }
  });

  test("V1 flat JSON import converts too", () => {
    const input = parseCardJson({ name: "Flat", extensions: { alternate_fields: { ...ST_ALL_SIX } } });
    expect(input.extensions?.alternate_fields?.description).toHaveLength(1);
  });

  test("PNG import converts all six fields", async () => {
    const card = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: cardData({ alternate_fields: { ...ST_ALL_SIX } }),
    });
    const png = embedPngTextChunk(
      Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
      "ccv3",
      Buffer.from(card).toString("base64"),
    );
    const input = await extractCardFromPng(png);
    for (const key of NATIVE_KEYS) {
      expect(input.extensions?.alternate_fields?.[key]).toHaveLength(1);
    }
    expect(input.extensions?.alternate_fields?.scenario[0].label).toBe("Winter");
  });

  test("a Lumiverse card with native alternates passes through unchanged", () => {
    const native = {
      description: [{ id: "x", label: "Native", content: "native text" }],
    };
    const input = parseCardJson(stCard(native));
    expect(input.extensions?.alternate_fields?.description).toEqual(native.description);
  });
});

describe("replacement precedence", () => {
  /** Minimal Character row; only `extensions` is read by the replacement builder. */
  function charWith(extensions: Record<string, unknown>): Character {
    return { id: "char-1", extensions } as unknown as Character;
  }

  let workDir = "";
  const originalDataDir = env.dataDir;

  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run("PRAGMA foreign_keys = OFF");
    workDir = mkdtempSync(join(tmpdir(), "lumiverse-alt-fields-"));
    env.dataDir = workDir;
  });

  afterEach(() => {
    closeDatabase();
    env.dataDir = originalDataDir;
    rmSync(workDir, { recursive: true, force: true });
  });

  test("incoming alternates replace existing ones", () => {
    const existing = charWith({ alternate_fields: { description: [{ id: "old", label: "Old", content: "old" }] } });
    const incoming: CreateCharacterInput = {
      name: "Test",
      extensions: { alternate_fields: { description: [{ id: "new", label: "New", content: "new" }] } },
    };
    const merged = buildCardReplacementInput(existing, incoming).extensions!;
    expect(merged.alternate_fields.description[0].label).toBe("New");
  });

  test("existing alternates survive when the card has none", () => {
    const existing = charWith({ alternate_fields: { description: [{ id: "keep", label: "Keep", content: "keep" }] } });
    const incoming: CreateCharacterInput = { name: "Test", extensions: { fav: true } };
    const merged = buildCardReplacementInput(existing, incoming).extensions!;
    expect(merged.alternate_fields.description[0].label).toBe("Keep");
  });

  test("local-only keys are still preserved", () => {
    const existing = charWith({
      risu_asset_map: { "gallery://image-1": "img" },
      _lumiverse_source_filename: "x.png",
      alternate_fields: { description: [] },
    });
    const incoming: CreateCharacterInput = { name: "Test", extensions: { fav: true } };
    const merged = buildCardReplacementInput(existing, incoming).extensions!;
    expect(merged.risu_asset_map).toEqual({ "gallery://image-1": "img" });
    expect(merged._lumiverse_source_filename).toBe("x.png");
    expect(merged.fav).toBe(true);
  });

  test("a real temp file is writable in the isolated data dir", () => {
    // Keeps the fixture honest: the DB and env are isolated per test.
    const probe = join(workDir, "probe.txt");
    writeFileSync(probe, "ok");
    expect(Bun.file(probe).size).toBe(2);
  });
});

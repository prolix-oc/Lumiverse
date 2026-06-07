import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createCharacter } from "./characters.service";
import { parseCardJson } from "./character-card.service";
import {
  PORTABLE_LORA_EXTENSION_KEY,
  readPortableLoraReference,
  setCharacterLora,
} from "./character-lora.service";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    image_id TEXT,
    avatar_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/**
 * The portable LoRA reference (lumiverse_image_gen_lora) travels with a
 * character card in `extensions`. These tests pin the *import* side: a CCSv3
 * card carrying the reference must round-trip into the imported character so
 * the import response can surface it (we never auto-create the binding).
 */
describe("portable LoRA reference — import round-trip", () => {
  beforeEach(initTestDb);
  afterEach(closeDatabase);

  test("survives parseCardJson + createCharacter and is readable for surfacing", () => {
    // A source character with a LoRA binding mirrors a portable reference into
    // its extensions — this is exactly what the exporter serializes into card.json.
    const source = createCharacter("user-1", { name: "Aerith" });
    setCharacterLora("user-1", source.id, {
      lora_name: "aerith_v3.safetensors",
      weight_model: 0.85,
      base_tags: "1girl, pink dress",
      source_url: "https://civitai.com/models/example",
    });
    const sourceRow = getDb()
      .query("SELECT extensions FROM characters WHERE id = ?")
      .get(source.id) as { extensions: string };
    const exportedExtensions = JSON.parse(sourceRow.extensions);

    // Build the CCSv3 card.json an export would produce (extensions carried through).
    const cardJson = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Aerith",
        description: "",
        extensions: exportedExtensions,
      },
    };

    // Import it on the receiving side.
    const input = parseCardJson(cardJson);
    const imported = createCharacter("user-2", input);

    // The reference made it through and is readable for the import response.
    const surfaced = readPortableLoraReference(imported);
    expect(surfaced).toMatchObject({
      version: 1,
      lora_filename: "aerith_v3.safetensors",
      weight: 0.85,
      base_tags: "1girl, pink dress",
      source_url: "https://civitai.com/models/example",
    });
  });

  test("does NOT auto-create a runtime binding for the importing user", () => {
    const cardJson = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Cloud",
        extensions: {
          [PORTABLE_LORA_EXTENSION_KEY]: {
            version: 1,
            lora_filename: "cloud.safetensors",
            weight: 0.7,
          },
        },
      },
    };

    const input = parseCardJson(cardJson);
    const imported = createCharacter("user-2", input);

    // Reference is surfaced…
    expect(readPortableLoraReference(imported)?.lora_filename).toBe("cloud.safetensors");
    // …but no per-user binding was written to settings (no auto-bind).
    const binding = getDb()
      .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
      .get(`characterLora:${imported.id}`, "user-2");
    expect(binding).toBeNull();
  });

  test("import without a LoRA reference surfaces nothing", () => {
    const input = parseCardJson({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "Tifa" },
    });
    const imported = createCharacter("user-2", input);
    expect(readPortableLoraReference(imported)).toBeNull();
  });
});

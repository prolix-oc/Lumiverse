import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createCharacter } from "./characters.service";
import {
  deleteCharacterLora,
  getCharacterLora,
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

describe("character-lora service", () => {
  beforeEach(initTestDb);
  afterEach(closeDatabase);

  test("setCharacterLora stores the binding and mirrors a portable reference", () => {
    const char = createCharacter("user-1", { name: "Aerith" });
    const binding = setCharacterLora("user-1", char.id, {
      lora_name: "aerith_v3.safetensors",
      weight_model: 0.85,
      weight_clip: 0.7,
      base_tags: "1girl, pink dress, long brown hair",
      source_url: "https://civitai.com/models/example",
    });
    expect(binding.lora_name).toBe("aerith_v3.safetensors");
    expect(binding.weight_model).toBeCloseTo(0.85);
    expect(binding.weight_clip).toBeCloseTo(0.7);
    expect(binding.base_tags).toBe("1girl, pink dress, long brown hair");

    // Round-trips
    const stored = getCharacterLora("user-1", char.id);
    expect(stored).toMatchObject({
      lora_name: "aerith_v3.safetensors",
      weight_model: 0.85,
      weight_clip: 0.7,
    });

    // Portable mirror lives on the character row
    const row = getDb()
      .query("SELECT extensions FROM characters WHERE id = ?")
      .get(char.id) as { extensions: string };
    const extensions = JSON.parse(row.extensions);
    expect(extensions[PORTABLE_LORA_EXTENSION_KEY]).toMatchObject({
      version: 1,
      lora_filename: "aerith_v3.safetensors",
      weight: 0.85,
      base_tags: "1girl, pink dress, long brown hair",
      source_url: "https://civitai.com/models/example",
    });
  });

  test("defaults weight_clip to weight_model when not provided", () => {
    const char = createCharacter("user-1", { name: "Cloud" });
    const binding = setCharacterLora("user-1", char.id, {
      lora_name: "cloud.safetensors",
      weight_model: 0.6,
    });
    expect(binding.weight_clip).toBeCloseTo(0.6);
  });

  test("rejects empty lora_name", () => {
    const char = createCharacter("user-1", { name: "Tifa" });
    expect(() => setCharacterLora("user-1", char.id, { lora_name: "   " })).toThrow();
  });

  test("rejects unknown character", () => {
    expect(() => setCharacterLora("user-1", "missing-id", { lora_name: "x.safetensors" })).toThrow();
  });

  test("bindings are isolated per user", () => {
    const char = createCharacter("user-1", { name: "Shared" });
    // user-2 binds a different LoRA to the same character_id (e.g. shared
    // character imported into both accounts)
    setCharacterLora("user-1", char.id, { lora_name: "u1.safetensors" });

    // Insert the same char into user-2's namespace too so setCharacterLora succeeds
    const char2 = createCharacter("user-2", { name: "Shared" });
    setCharacterLora("user-2", char2.id, { lora_name: "u2.safetensors" });

    expect(getCharacterLora("user-1", char.id)?.lora_name).toBe("u1.safetensors");
    expect(getCharacterLora("user-2", char2.id)?.lora_name).toBe("u2.safetensors");
  });

  test("deleteCharacterLora removes both the binding and the portable mirror", () => {
    const char = createCharacter("user-1", { name: "Yuffie" });
    setCharacterLora("user-1", char.id, { lora_name: "yuffie.safetensors", weight_model: 1 });
    expect(getCharacterLora("user-1", char.id)).not.toBeNull();

    expect(deleteCharacterLora("user-1", char.id)).toBe(true);
    expect(getCharacterLora("user-1", char.id)).toBeNull();

    const row = getDb()
      .query("SELECT extensions FROM characters WHERE id = ?")
      .get(char.id) as { extensions: string };
    const extensions = JSON.parse(row.extensions);
    expect(extensions[PORTABLE_LORA_EXTENSION_KEY]).toBeUndefined();
  });

  test("readPortableLoraReference returns null for missing/invalid blobs", () => {
    expect(readPortableLoraReference({})).toBeNull();
    expect(readPortableLoraReference({ extensions: {} })).toBeNull();
    expect(readPortableLoraReference({
      extensions: { [PORTABLE_LORA_EXTENSION_KEY]: { lora_filename: "x.safetensors" } },
    })).toBeNull(); // weight missing
    expect(readPortableLoraReference({
      extensions: {
        [PORTABLE_LORA_EXTENSION_KEY]: {
          version: 1,
          lora_filename: "ok.safetensors",
          weight: 0.5,
        },
      },
    })).toMatchObject({ lora_filename: "ok.safetensors", weight: 0.5 });
  });
});

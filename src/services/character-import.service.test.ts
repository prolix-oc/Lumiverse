import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { importCharacterFile } from "./character-import.service";
import { buildCCSv3Json } from "./character-export.service";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_path TEXT,
    image_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    library_scope TEXT NOT NULL DEFAULT 'mine',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleting INTEGER NOT NULL DEFAULT 0
  )`);
}

function jsonCard(filename: string, name: string, extensions: Record<string, unknown> = {}): File {
  return new File([JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name, description: "Imported through the shared service", extensions },
  })], filename, { type: "application/json" });
}

beforeEach(initTestDb);
afterEach(closeDatabase);

describe("importCharacterFile", () => {
  test.each([
    "https://lumi.spot/@creator",
    "https://lumi.spot/characters/card-id",
    "https://illarin.com/a/card-id/card-name",
  ])("preserves original source %s through card export and reimport", async (url) => {
    const extensions = { _lumiverse_source_url: url, unrelated: { keep: true } };
    const imported = await importCharacterFile("user-1", jsonCard("source.json", "Source Test", extensions), {
      emitEvent: false,
    });
    expect(imported.success).toBe(true);
    expect(imported.character?.extensions).toMatchObject(extensions);

    const exported = buildCCSv3Json("user-1", imported.character!);
    const reimported = await importCharacterFile("user-1", new File([JSON.stringify(exported)], "exported.json", {
      type: "application/json",
    }), { emitEvent: false });
    expect(reimported.success).toBe(true);
    expect(reimported.character?.extensions).toMatchObject(extensions);
  });

  test("imports JSON cards without a per-character event and deduplicates by staged filename", async () => {
    let createdEvents = 0;
    const off = eventBus.on(EventType.CHARACTER_CREATED, () => { createdEvents++; });
    try {
      const imported = await importCharacterFile("user-1", jsonCard("card.json", "First"), {
        emitEvent: false,
      });
      expect(imported.success).toBe(true);
      expect(imported.character?.name).toBe("First");
      expect(imported.character?.extensions?._lumiverse_source_filename).toBe("card.json");

      const duplicate = await importCharacterFile("user-1", jsonCard("card.json", "Changed name"), {
        emitEvent: false,
        skipDuplicates: true,
      });
      expect(duplicate.skipped).toBe(true);
      expect(duplicate.character?.id).toBe(imported.character?.id);
      await Bun.sleep(5);
      expect(createdEvents).toBe(0);
    } finally {
      off();
    }
  });
});

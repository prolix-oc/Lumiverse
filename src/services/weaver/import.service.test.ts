import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  cardImportProvenance,
  parseGalleryCharacter,
  startGalleryCharacterImport,
} from "./import.service";

const USER_ID = "author";
const CHARACTER_ID = "source-character";

function initImportTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`
    CREATE TABLE characters (
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
    );
    CREATE TABLE weaver_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_number INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      seed_type TEXT NOT NULL DEFAULT 'dream',
      seed_text TEXT NOT NULL DEFAULT '',
      seed_provenance TEXT NOT NULL DEFAULT '{}',
      stage TEXT NOT NULL DEFAULT 'dream',
      status TEXT NOT NULL DEFAULT 'draft',
      connection_id TEXT,
      model TEXT,
      persona_id TEXT,
      character_id TEXT,
      launch_chat_id TEXT,
      interview_started_at INTEGER,
      interview_completed_at INTEGER,
      build_type TEXT NOT NULL DEFAULT 'character',
      narration_mode TEXT,
      persona_plan TEXT,
      taste_profile TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE weaver_bible (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      spine TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE weaver_extraction (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      committed_facts TEXT NOT NULL DEFAULT '[]'
    );
  `);
  getDb().query(`
    INSERT INTO characters (
      id, user_id, name, avatar_path, image_id, description, personality,
      scenario, first_mes, mes_example, creator, creator_notes, system_prompt,
      post_history_instructions, tags, alternate_greetings, extensions,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    CHARACTER_ID,
    USER_ID,
    "Aster Vale",
    "aster.png",
    "aster-image",
    "A clockmaker who remembers discarded timelines.",
    "Precise, warm, and evasive.",
    "A workshop outside ordinary time.",
    "The last clock stops as {{user}} enters.",
    "<START>\n{{char}}: You are early. Or very late.",
    "Test Creator",
    "Keep the temporal mystery unresolved.",
    "",
    "",
    JSON.stringify(["clockwork"]),
    JSON.stringify(["The clocks begin to run backward."]),
    JSON.stringify({ custom_portable_field: true }),
    1,
    1,
  );
}

beforeEach(initImportTestDb);
afterEach(() => closeDatabase());

describe("Weaver gallery character imports", () => {
  test("adapts an owned gallery character into the normal card artifact", () => {
    const parsed = parseGalleryCharacter(USER_ID, CHARACTER_ID);

    expect(parsed).toMatchObject({
      artifact: "card",
      format: "gallery",
      name: "Aster Vale",
      hasPortrait: true,
      sourceCharacterId: CHARACTER_ID,
      avatarImageId: "aster-image",
      boundWorldBookIds: [],
    });
    expect(parsed?.source).toContain("NAME: Aster Vale");
    expect(parsed?.source).toContain("DESCRIPTION:\nA clockmaker who remembers discarded timelines.");
    expect(parsed?.card?.alternate_greetings).toEqual(["The clocks begin to run backward."]);
    expect(parseGalleryCharacter("another-user", CHARACTER_ID)).toBeNull();
  });

  test("starts a separate rebuild without duplicating or targeting the source character", async () => {
    const before = getDb().query("SELECT * FROM characters WHERE id = ?").get(CHARACTER_ID);
    const result = await startGalleryCharacterImport(USER_ID, CHARACTER_ID, { action: "rebuild" });
    const after = getDb().query("SELECT * FROM characters WHERE id = ?").get(CHARACTER_ID);

    expect(result.session).toBeDefined();
    expect(result.session?.character_id).toBeNull();
    expect(result.session?.seed.type).toBe("card");
    expect(result.session?.seed.provenance).toMatchObject({
      import_kind: "card",
      original_name: "Aster Vale",
      original_format: "gallery",
      original_character_id: CHARACTER_ID,
      avatar_image_id: "aster-image",
    });
    expect(getDb().query("SELECT COUNT(*) AS count FROM characters").get()).toEqual({ count: 1 });
    expect(after).toEqual(before);
  });

  test("deduplicates every lorebook carried in provenance", () => {
    expect(cardImportProvenance({
      originalName: "Aster Vale",
      originalFormat: "gallery",
      originalCharacterId: CHARACTER_ID,
      boundWorldBookIds: ["book-a", "book-b", "book-a"],
      embeddedBookId: "book-b",
    })).toMatchObject({
      bind_world_book_ids: ["book-a", "book-b"],
    });
  });
});

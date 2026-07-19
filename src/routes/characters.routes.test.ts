import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { embedPngTextChunk } from "../services/character-export.service";
import { charactersRoutes } from "./characters.routes";

const CHARACTER_ID = "character-1";
const USER_ID = "user-1";
const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

function initCharactersTestDb(): void {
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
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleting INTEGER NOT NULL DEFAULT 0
  )`);
}

function seedCharacter(): void {
  getDb().query(`INSERT INTO characters (
    id, user_id, name, avatar_path, image_id, description, personality, scenario,
    first_mes, mes_example, creator, creator_notes, system_prompt,
    post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at
  ) VALUES (?, ?, 'Keep this name', 'avatar.png', 'avatar-image', 'old description',
    'old personality', 'old scenario', 'old greeting', 'old examples', 'Old creator',
    'old notes', 'old system', 'old post history', '["old-tag"]', '["old alternate"]',
    ?, 1, 1)`).run(
    CHARACTER_ID,
    USER_ID,
    JSON.stringify({
      ttsVoice: { connectionId: "voice-connection", voice: "Original voice" },
      avatar_crop_image_id: "avatar-crop",
      original_image_id: "avatar-original",
      world_book_ids: ["world-book-1"],
      oldCardExtension: true,
    }),
  );
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", charactersRoutes);

beforeEach(() => {
  initCharactersTestDb();
  seedCharacter();
});

afterEach(() => closeDatabase());

describe("POST /:id/replace-card", () => {
  test("replaces JSON card fields while preserving the character name, avatar, and local assets", async () => {
    const form = new FormData();
    form.set("file", new File([JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Do not use this imported name",
        description: "replacement description",
        first_mes: "replacement greeting",
        creator: "Replacement creator",
        tags: ["new-tag"],
        alternate_greetings: ["new alternate"],
        extensions: { importedExtension: "kept" },
      },
    })], "replacement.json", { type: "application/json" }));

    const response = await app.request(`http://localhost/${CHARACTER_ID}/replace-card`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const character = await response.json();
    expect(character).toMatchObject({
      id: CHARACTER_ID,
      name: "Keep this name",
      avatar_path: "avatar.png",
      image_id: "avatar-image",
      description: "replacement description",
      personality: "",
      scenario: "",
      first_mes: "replacement greeting",
      mes_example: "",
      creator: "Replacement creator",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags: ["new-tag"],
      alternate_greetings: ["new alternate"],
    });
    expect(character.extensions).toEqual({
      importedExtension: "kept",
      ttsVoice: { connectionId: "voice-connection", voice: "Original voice" },
      avatar_crop_image_id: "avatar-crop",
      original_image_id: "avatar-original",
      world_book_ids: ["world-book-1"],
    });
  });

  test("accepts PNG cards with embedded character data", async () => {
    const cardJson = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Do not use this imported name",
        personality: "PNG replacement personality",
      },
    });
    const pngWithCard = embedPngTextChunk(
      Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
      "ccv3",
      Buffer.from(cardJson, "utf-8").toString("base64"),
    );
    const form = new FormData();
    form.set("file", new File([new Uint8Array(pngWithCard)], "replacement.png", { type: "image/png" }));

    const response = await app.request(`http://localhost/${CHARACTER_ID}/replace-card`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    const character = await response.json();
    expect(character.name).toBe("Keep this name");
    expect(character.avatar_path).toBe("avatar.png");
    expect(character.image_id).toBe("avatar-image");
    expect(character.personality).toBe("PNG replacement personality");
  });
});

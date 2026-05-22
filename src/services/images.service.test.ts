import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getImage, listImages } from "./images.service";

function initImagesTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  getDb().run(`CREATE TABLE images (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    owner_extension_identifier TEXT,
    owner_character_id TEXT,
    owner_chat_id TEXT,
    created_at INTEGER NOT NULL
  )`);
}

function seedImage(
  id: string,
  createdAt: number,
  ownership?: {
    owner_extension_identifier?: string;
    owner_character_id?: string;
    owner_chat_id?: string;
  },
): void {
  getDb()
    .query(
      `INSERT INTO images (
        id,
        user_id,
        filename,
        original_filename,
        mime_type,
        width,
        height,
        has_thumbnail,
        owner_extension_identifier,
        owner_character_id,
        owner_chat_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "u1",
      `${id}.png`,
      `${id}.png`,
      "image/png",
      100,
      100,
      1,
      ownership?.owner_extension_identifier ?? null,
      ownership?.owner_character_id ?? null,
      ownership?.owner_chat_id ?? null,
      createdAt,
    );
}

beforeEach(() => {
  initImagesTestDb();
});

afterEach(() => {
  closeDatabase();
});

describe("images.service ownership filters", () => {
  test("lists only extension-owned images and returns specificity-aware URLs", () => {
    seedImage("img-1", 300, { owner_extension_identifier: "ext.gallery", owner_chat_id: "chat-1" });
    seedImage("img-2", 200, { owner_extension_identifier: "ext.gallery", owner_character_id: "char-1" });
    seedImage("img-3", 100, { owner_extension_identifier: "ext.other" });

    const result = listImages("u1", {
      owner_extension_identifier: "ext.gallery",
      specificity: "sm",
    });

    expect(result.total).toBe(2);
    expect(result.data.map((image) => image.id)).toEqual(["img-1", "img-2"]);
    expect(result.data[0].url).toBe("/api/v1/images/img-1?size=sm");
    expect(result.data[0].specificity).toBe("sm");
    expect(result.data[1].owner_character_id).toBe("char-1");
  });

  test("applies owner filters to single-image lookups", () => {
    seedImage("img-1", 100, {
      owner_extension_identifier: "ext.gallery",
      owner_character_id: "char-1",
      owner_chat_id: "chat-1",
    });

    const match = getImage("u1", "img-1", {
      owner_extension_identifier: "ext.gallery",
      owner_character_id: "char-1",
      specificity: "lg",
    });
    const mismatch = getImage("u1", "img-1", {
      owner_extension_identifier: "ext.other",
    });

    expect(match?.url).toBe("/api/v1/images/img-1?size=lg");
    expect(match?.owner_chat_id).toBe("chat-1");
    expect(mismatch).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chatsSvc from "./chats.service";
import * as settingsSvc from "./settings.service";
import {
  WALLPAPER_LIBRARY_OWNER,
  deleteImageIfUnreferenced,
  deleteWallpaperLibraryImage,
  getImage,
  listImages,
} from "./images.service";

function initImagesTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  getDb().run(`CREATE TABLE images (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    owner_extension_identifier TEXT,
    owner_character_id TEXT,
    owner_chat_id TEXT,
    created_at INTEGER NOT NULL
  )`);

  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);

  getDb().run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
        byte_size,
        width,
        height,
        has_thumbnail,
        owner_extension_identifier,
        owner_character_id,
        owner_chat_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "u1",
      `${id}.png`,
      `${id}.png`,
      "image/png",
      4096,
      100,
      100,
      1,
      ownership?.owner_extension_identifier ?? null,
      ownership?.owner_character_id ?? null,
      ownership?.owner_chat_id ?? null,
      createdAt,
    );
}

function seedSetting(key: string, value: unknown, updatedAt = 100): void {
  getDb()
    .query("INSERT INTO settings (key, value, updated_at, user_id) VALUES (?, ?, ?, ?)")
    .run(key, JSON.stringify(value), updatedAt, "u1");
}

function seedChat(id: string, metadata: Record<string, unknown>, updatedAt = 100): void {
  getDb()
    .query(
      `INSERT INTO chats (
        id,
        user_id,
        character_id,
        name,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "u1", "char-1", "Test Chat", JSON.stringify(metadata), updatedAt, updatedAt);
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

  test("treats wallpaper-library images as long-term references", () => {
    seedImage("img-1", 100, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });

    const deleted = deleteImageIfUnreferenced("u1", "img-1");

    expect(deleted).toBe(false);
    expect(getImage("u1", "img-1")).not.toBeNull();
  });

  test("deletes wallpaper-library images and clears global plus chat assignments", () => {
    seedImage("img-1", 100, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });
    seedImage("img-2", 90, { owner_extension_identifier: WALLPAPER_LIBRARY_OWNER });
    seedSetting("wallpaper", {
      global: { image_id: "img-1", type: "image" },
      opacity: 0.35,
      fit: "cover",
      blur: 2,
    });
    seedChat("chat-1", {
      wallpaper: { image_id: "img-1", type: "image" },
      topic: "keep me",
    });
    seedChat("chat-2", {
      wallpaper: { image_id: "img-2", type: "image" },
      topic: "leave me alone",
    });

    const deleted = deleteWallpaperLibraryImage("u1", "img-1");

    expect(deleted).toBe(true);
    expect(getImage("u1", "img-1")).toBeNull();
    expect(settingsSvc.getSetting("u1", "wallpaper")?.value).toEqual({
      global: null,
      opacity: 0.35,
      fit: "cover",
      blur: 2,
    });
    expect(chatsSvc.getChat("u1", "chat-1")?.metadata).toEqual({
      wallpaper: null,
      topic: "keep me",
    });
    expect(chatsSvc.getChat("u1", "chat-2")?.metadata).toEqual({
      wallpaper: { image_id: "img-2", type: "image" },
      topic: "leave me alone",
    });
  });

  test("does not delete non-wallpaper images through the wallpaper delete path", () => {
    seedImage("img-1", 100);

    const deleted = deleteWallpaperLibraryImage("u1", "img-1");

    expect(deleted).toBe(false);
    expect(getImage("u1", "img-1")).not.toBeNull();
  });
});

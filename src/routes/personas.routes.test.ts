import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { personasRoutes } from "./personas.routes";

const USER_ID = "user-1";

function initPersonasTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  getDb().run(`CREATE TABLE images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  getDb().run(`CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    subjective_pronoun TEXT NOT NULL DEFAULT '',
    objective_pronoun TEXT NOT NULL DEFAULT '',
    possessive_pronoun TEXT NOT NULL DEFAULT '',
    reflexive_pronoun TEXT NOT NULL DEFAULT '',
    possessive_pronoun_standalone TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
    attached_world_book_id TEXT REFERENCES world_books(id) ON DELETE SET NULL,
    folder TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    is_narrator INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  getDb().query(`INSERT INTO world_books (
    id, user_id, name, description, folder, metadata, created_at, updated_at
  ) VALUES (?, ?, 'Local lorebook', '', '', '{}', 1, 1)`).run("world-book-1", USER_ID);
  getDb().query(`INSERT INTO images (
    id, user_id, filename, original_filename, mime_type, created_at
  ) VALUES (?, ?, 'avatar.webp', 'avatar.webp', 'image/webp', 1)`).run("image-1", USER_ID);
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", personasRoutes);

beforeEach(initPersonasTestDb);
afterEach(() => closeDatabase());

describe("POST /bulk-import", () => {
  test("imports the persona export shape and preserves supported fields", async () => {
    const response = await app.request("http://localhost/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personas: [
          {
            id: "source-id-is-not-reused",
            name: "  The Archivist  ",
            title: "Keeper",
            description: "Keeps careful records.",
            subjective_pronoun: "she",
            objective_pronoun: "her",
            possessive_pronoun: "her",
            reflexive_pronoun: "herself",
            possessive_pronoun_standalone: "hers",
            folder: "Library",
            is_default: true,
            is_narrator: true,
            attached_world_book_id: "world-book-1",
            image_id: "image-1",
            metadata: {
              addons: [{
                id: "addon-1",
                label: "Glasses",
                content: "Wears reading glasses.",
                enabled: true,
                sort_order: 0,
                avatar_image_id: "image-1",
              }],
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const result = await response.json() as any;
    expect(result).toMatchObject({
      count: 1,
      failed: 0,
      warnings: {
        detached_world_books: 0,
        skipped_asset_references: 0,
      },
    });
    expect(result.imported[0]).toMatchObject({
      name: "The Archivist",
      title: "Keeper",
      description: "Keeps careful records.",
      subjective_pronoun: "she",
      objective_pronoun: "her",
      possessive_pronoun: "her",
      reflexive_pronoun: "herself",
      possessive_pronoun_standalone: "hers",
      folder: "Library",
      is_default: true,
      is_narrator: true,
      attached_world_book_id: "world-book-1",
      image_id: "image-1",
    });
    expect(result.imported[0].id).not.toBe("source-id-is-not-reused");
    expect(result.imported[0].metadata.addons[0].avatar_image_id).toBe("image-1");
  });

  test("continues past invalid personas and removes unavailable local references", async () => {
    const response = await app.request("http://localhost/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personas: [
          { name: "   " },
          {
            name: "Traveler",
            attached_world_book_id: "world-book-from-another-install",
            image_id: "image-from-another-install",
            metadata: {
              avatar_crop_image_id: "missing-crop",
              addons: [{
                id: "addon-1",
                label: "Hat",
                content: "Wears a hat.",
                enabled: true,
                sort_order: 0,
                avatar_image_id: "missing-addon-avatar",
              }],
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const result = await response.json() as any;
    expect(result).toMatchObject({
      count: 1,
      failed: 1,
      warnings: {
        detached_world_books: 1,
        skipped_asset_references: 3,
      },
    });
    expect(result.errors[0]).toMatchObject({ index: 0, name: "(unnamed)", error: "name is required" });
    expect(result.imported[0].attached_world_book_id).toBeNull();
    expect(result.imported[0].image_id).toBeNull();
    expect(result.imported[0].metadata.avatar_crop_image_id).toBeUndefined();
    expect(result.imported[0].metadata.addons[0].avatar_image_id).toBeUndefined();
  });

  test("rejects a missing or empty persona array", async () => {
    const missing = await app.request("http://localhost/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const empty = await app.request("http://localhost/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personas: [] }),
    });

    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
  });
});

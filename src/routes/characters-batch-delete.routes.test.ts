import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabaseAsync, getDb, initDatabase } from "../db/connection";
import * as embeddingsSvc from "../services/embeddings.service";
import { charactersRoutes } from "./characters.routes";

const USER_ID = "batch-delete-user";
const TARGET_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_IMAGE_ID = "00000000-0000-4000-8000-000000000011";
const SHARED_IMAGE_ID = "00000000-0000-4000-8000-000000000012";

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", charactersRoutes);

beforeEach(async () => {
  spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined);
  await closeDatabaseAsync();
  initDatabase(":memory:");
  getDb().run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  getDb().query(`INSERT INTO "user" (id, name, email) VALUES (?, 'Batch User', 'batch@example.com')`).run(USER_ID);

  for (const [id, name] of [[TARGET_ID, "Target"], [MEMBER_ID, "Member"], [OTHER_ID, "Other"]]) {
    getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(id, USER_ID, name);
  }
  getDb().query(
    "INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, ?, ?, ?)",
  ).run(TARGET_IMAGE_ID, USER_ID, "target.webp", "target.webp");
  getDb().query(
    "INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, ?, ?, ?)",
  ).run(SHARED_IMAGE_ID, USER_ID, "shared.webp", "shared.webp");
  getDb().query("UPDATE characters SET image_id = ? WHERE id = ?").run(TARGET_IMAGE_ID, TARGET_ID);

  getDb().query(
    "INSERT INTO character_gallery (id, user_id, character_id, image_id, created_at) VALUES (?, ?, ?, ?, 1)",
  ).run("target-gallery", USER_ID, TARGET_ID, SHARED_IMAGE_ID);
  getDb().query(
    "INSERT INTO character_gallery (id, user_id, character_id, image_id, created_at) VALUES (?, ?, ?, ?, 1)",
  ).run("member-gallery", USER_ID, MEMBER_ID, SHARED_IMAGE_ID);

  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name) VALUES ('solo-chat', ?, ?, 'Solo')",
  ).run(USER_ID, TARGET_ID);
  getDb().query(
    `INSERT INTO chats (id, user_id, character_id, name, metadata)
     VALUES ('group-chat', ?, ?, 'Group', ?)`,
  ).run(USER_ID, MEMBER_ID, JSON.stringify({ group: true, character_ids: [TARGET_ID, MEMBER_ID, OTHER_ID] }));
});

afterEach(async () => closeDatabaseAsync());

describe("POST /batch-delete", () => {
  test("deletes owned characters and cleans dependent records without removing shared images", async () => {
    const response = await app.request("http://localhost/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [TARGET_ID, TARGET_ID, "missing"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: [TARGET_ID], failed: ["missing"] });
    expect(getDb().query("SELECT id FROM characters WHERE id = ?").get(TARGET_ID)).toBeNull();
    expect(getDb().query("SELECT id FROM chats WHERE id = 'solo-chat'").get()).toBeNull();
    expect(getDb().query("SELECT id FROM images WHERE id = ?").get(TARGET_IMAGE_ID)).toBeNull();
    expect(getDb().query("SELECT id FROM images WHERE id = ?").get(SHARED_IMAGE_ID)).toEqual({ id: SHARED_IMAGE_ID });

    const group = getDb().query("SELECT metadata FROM chats WHERE id = 'group-chat'").get() as { metadata: string };
    expect(JSON.parse(group.metadata).character_ids).toEqual([MEMBER_ID, OTHER_ID]);
  });

  test("validates the request instead of falling through to a character route", async () => {
    const response = await app.request("http://localhost/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(response.status).toBe(400);
  });
});

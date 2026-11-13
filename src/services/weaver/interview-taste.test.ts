import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { addSteer, getTaste } from "./interview.service";

describe("Weaver taste isolation", () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run(`
      CREATE TABLE weaver_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        taste_profile TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE weaver_taste (
        user_id TEXT PRIMARY KEY,
        profile TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO weaver_sessions (id, user_id) VALUES
        ('world-1', 'author'),
        ('world-2', 'author'),
        ('other-world', 'other-author');
    `);
  });

  afterEach(() => closeDatabase());

  test("a steer is visible only inside the session where it was given", () => {
    addSteer("author", "world-1", "Character A does action B");

    expect(getTaste("author", "world-1")).toEqual({
      steers: ["Character A does action B"],
    });
    expect(getTaste("author", "world-2")).toEqual({ steers: [] });
    expect(getTaste("other-author", "other-world")).toEqual({ steers: [] });
  });

  test("legacy user-wide taste is not injected into any session", () => {
    getDb()
      .prepare("INSERT INTO weaver_taste (user_id, profile) VALUES (?, ?)")
      .run("author", JSON.stringify({ steers: ["Character A does action B"] }));

    expect(getTaste("author", "world-1")).toEqual({ steers: [] });
    expect(getTaste("author", "world-2")).toEqual({ steers: [] });
  });

  test("a user cannot add taste to another user's session", () => {
    addSteer("author", "other-world", "foreign steer");

    expect(getTaste("other-author", "other-world")).toEqual({ steers: [] });
  });
});

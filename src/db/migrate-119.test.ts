import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const MIGRATION_PATH = `${import.meta.dir}/migrations/119_desktop_oauth_origin_independent_resource.sql`;

describe("119 desktop OAuth resource audience", () => {
  test("removes only legacy origin-bound desktop resources", async () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(`
        CREATE TABLE "oauthResource" (
          id TEXT PRIMARY KEY NOT NULL,
          identifier TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL
        );
        CREATE TABLE "oauthClientResource" (
          id TEXT PRIMARY KEY NOT NULL,
          resourceId TEXT NOT NULL REFERENCES "oauthResource"(identifier) ON DELETE CASCADE
        );
        INSERT INTO "oauthResource" VALUES
          ('legacy', 'https://app.example.test/api/desktop/v1', 'Lumiverse Desktop API'),
          ('unrelated', 'https://app.example.test/api/other', 'Another API');
        INSERT INTO "oauthClientResource" VALUES
          ('legacy-link', 'https://app.example.test/api/desktop/v1');
      `);
      db.run(await Bun.file(MIGRATION_PATH).text());

      expect(db.query(`SELECT id FROM "oauthResource" ORDER BY id`).all())
        .toEqual([{ id: "unrelated" }]);
      expect(db.query(`SELECT id FROM "oauthClientResource"`).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createPreBundleDatabase } from "./test-helpers";
const legacySql = await Bun.file(new URL("071_import_consumed_tickets.sql", import.meta.url)).text();
const strictSql = await Bun.file(new URL("119_ticket_consumption_strict.sql", import.meta.url)).text();
const correctionSql = await Bun.file(new URL("122_ticket_consumption_account_delete.sql", import.meta.url)).text();

let db: Database;

beforeEach(() => {
  db = createPreBundleDatabase();
  db.run(legacySql);
  db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run("ticket-owner", "Ticket owner", "ticket-owner@example.test");
  db.query(
    "INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses) VALUES (?, ?, ?, 1)",
  ).run("archive-once", 100, "ticket-owner");
  db.run(strictSql);
  db.run(correctionSql);
  db.run("PRAGMA foreign_keys = ON");
});

afterEach(() => db.close());

describe("ticket tombstone account-delete migration", () => {
  test("keeps the globally unique tombstone and nulls only audit ownership", () => {
    const foreignKey = db.query("PRAGMA foreign_key_list(import_consumed_tickets)").all()
      .find((row) => (row as { table?: string }).table === "user") as { on_delete?: string } | undefined;
    expect(foreignKey?.on_delete?.toUpperCase()).toBe("SET NULL");

    db.query('DELETE FROM "user" WHERE id = ?').run("ticket-owner");
    expect(db.query("SELECT archive_id, user_id, uses FROM import_consumed_tickets WHERE archive_id = ?").get("archive-once"))
      .toEqual({ archive_id: "archive-once", user_id: null, uses: 1 });

    expect(() => db.query(
      "INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses) VALUES (?, ?, NULL, 1)",
    ).run("archive-once", 200)).toThrow();
    expect(() => db.query(
      "INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses) VALUES (NULL, ?, NULL, 1)",
    ).run(200)).toThrow();
  });
});

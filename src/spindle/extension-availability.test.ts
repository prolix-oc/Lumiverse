import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { readEditAndSendAlwaysUseActiveConnection } from "../services/settings.service";

const USER = "suite-user";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("CREATE TABLE extensions (identifier TEXT PRIMARY KEY, enabled INTEGER, install_scope TEXT, installed_by_user_id TEXT)");
  db.run('CREATE TABLE "user" (id TEXT PRIMARY KEY, role TEXT)');
  db.run("CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER)");
  db.query('INSERT INTO "user" VALUES (?, ?)').run(USER, "user");
  db.query("INSERT INTO settings VALUES (?, ?, ?, 1)").run(
    "quickToolbarSettings", USER, JSON.stringify({ editAndSendAlwaysUseActiveConnection: true }),
  );
});

afterEach(closeDatabase);

describe("Suite-owned active-connection preference", () => {
  test("saved true stays off without Suite, after disable, and after uninstall", () => {
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(false);
    getDb().run("INSERT INTO extensions VALUES ('lumiverse_suite', 1, 'operator', NULL)");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(true);
    getDb().run("UPDATE extensions SET enabled = 0");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(false);
    getDb().run("UPDATE extensions SET enabled = 1");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(true);
    getDb().run("DELETE FROM extensions");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(false);
    const saved = getDb().query("SELECT value FROM settings").get() as { value: string };
    expect(JSON.parse(saved.value).editAndSendAlwaysUseActiveConnection).toBe(true);
  });

  test("another user's installation does not enable Suite behavior", () => {
    getDb().run("INSERT INTO extensions VALUES ('lumiverse_suite', 1, 'user', 'another-user')");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(false);
    getDb().query("UPDATE extensions SET installed_by_user_id = ?").run(USER);
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(true);
  });

  test("privileged users see enabled installations, while disabled ones stay off", () => {
    getDb().run("INSERT INTO extensions VALUES ('lumiverse_suite', 1, 'user', 'another-user')");
    for (const role of ["admin", "owner"]) {
      getDb().query('UPDATE "user" SET role = ?').run(role);
      expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(true);
    }
    getDb().run("UPDATE extensions SET enabled = 0");
    expect(readEditAndSendAlwaysUseActiveConnection(USER)).toBe(false);
  });
});

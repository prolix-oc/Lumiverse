import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createCharacter, bulkUpdateCharacterTags } from "./characters.service";

const USER_A = "bulk-tags-user-a";
const USER_B = "bulk-tags-user-b";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function getTags(userId: string, id: string): string[] {
  const row = getDb().query("SELECT tags FROM characters WHERE id = ? AND user_id = ?").get(id, userId) as { tags: string | null } | null;
  try {
    const parsed: unknown = JSON.parse(row?.tags || "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

describe("bulkUpdateCharacterTags", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });
  afterEach(() => {
    closeDatabase();
  });

  test("add appends tags across multiple characters", () => {
    const a = createCharacter(USER_A, { name: "A", tags: ["existing"] });
    const b = createCharacter(USER_A, { name: "B" });
    const res = bulkUpdateCharacterTags(USER_A, { ids: [a.id, b.id], operation: "add", tags: ["new"] });
    expect(res.updated).toBe(2);
    expect(res.unchanged).toBe(0);
    expect(getTags(USER_A, a.id)).toEqual(["existing", "new"]);
    expect(getTags(USER_A, b.id)).toEqual(["new"]);
  });

  test("add dedupes and reports unchanged when no delta", () => {
    const a = createCharacter(USER_A, { name: "A", tags: ["x"] });
    const res = bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "add", tags: ["x"] });
    expect(res.updated).toBe(0);
    expect(res.unchanged).toBe(1);
    expect(getTags(USER_A, a.id)).toEqual(["x"]);
  });

  test("remove filters tags out", () => {
    const a = createCharacter(USER_A, { name: "A", tags: ["keep", "drop"] });
    const res = bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "remove", tags: ["drop"] });
    expect(res.updated).toBe(1);
    expect(getTags(USER_A, a.id)).toEqual(["keep"]);
  });

  test("replace sets exactly the provided tags", () => {
    const a = createCharacter(USER_A, { name: "A", tags: ["old1", "old2"] });
    const res = bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "replace", tags: ["only"] });
    expect(res.updated).toBe(1);
    expect(getTags(USER_A, a.id)).toEqual(["only"]);
  });

  test("only affects the calling user's characters", () => {
    const a = createCharacter(USER_A, { name: "A", tags: ["shared"] });
    const b = createCharacter(USER_B, { name: "B", tags: ["shared"] });
    bulkUpdateCharacterTags(USER_A, { ids: [a.id, b.id], operation: "remove", tags: ["shared"] });
    expect(getTags(USER_A, a.id)).toEqual([]);
    expect(getTags(USER_B, b.id)).toEqual(["shared"]); // untouched
  });

  test("rejects empty ids / bad operation / empty tags", () => {
    const a = createCharacter(USER_A, { name: "A" });
    expect(() => bulkUpdateCharacterTags(USER_A, { ids: [], operation: "add", tags: ["x"] })).toThrow();
    // "bad" is intentionally invalid; service validates and throws. Unchecked cast
    // is safe because the runtime branch under test rejects it.
    expect(() => bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "bad" as unknown as "add", tags: ["x"] })).toThrow();
    expect(() => bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "add", tags: [] })).toThrow();
    expect(() => bulkUpdateCharacterTags(USER_A, { ids: [a.id], operation: "add", tags: ["  "] })).toThrow();
  });
});

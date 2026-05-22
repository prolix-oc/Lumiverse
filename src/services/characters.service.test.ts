import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { listCharacterSummaries } from "./characters.service";

function initCharactersTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  const db = getDb();
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    image_id TEXT,
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`);
}

function makeUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function seedCharacter(index: number, namePrefix: string, updatedAt: number): string {
  const id = makeUuid(index);
  getDb()
    .query(
      `INSERT INTO characters (
        id, user_id, name, creator, tags, image_id, alternate_greetings, created_at, updated_at
      ) VALUES (?, ?, ?, '', '[]', NULL, '[]', ?, ?)`
    )
    .run(id, "u1", `${namePrefix} ${index}`, updatedAt, updatedAt);
  return id;
}

function seedChat(chatId: string, characterId: string, updatedAt: number, metadata = "{}"): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, metadata, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, "u1", characterId, metadata, updatedAt);
}

beforeEach(() => {
  initCharactersTestDb();
});

afterEach(() => {
  closeDatabase();
});

describe("character discover shuffle", () => {
  test("changes first-page ordering when the seed changes", () => {
    for (let i = 0; i < 160; i += 1) {
      seedCharacter(i, "Character", 10_000 + i);
    }

    const first = listCharacterSummaries("u1", { limit: 80, offset: 0 }, { sort: "discover", seed: 11 });
    const second = listCharacterSummaries("u1", { limit: 80, offset: 0 }, { sort: "discover", seed: 29 });
    const overlap = new Set(first.data.map((item) => item.id).filter((id) => second.data.some((item) => item.id === id)));

    expect(first.data.map((item) => item.id)).not.toEqual(second.data.map((item) => item.id));
    expect(overlap.size).toBeLessThan(first.data.length);
  });

  test("reshuffle can pull characters from later pages into the first page", () => {
    for (let i = 0; i < 1_200; i += 1) {
      seedCharacter(i, "Character", 20_000 + i);
    }

    const beforePageOne = listCharacterSummaries("u1", { limit: 500, offset: 0 }, { sort: "discover", seed: 17 });
    const beforePageTwo = listCharacterSummaries("u1", { limit: 500, offset: 500 }, { sort: "discover", seed: 17 });
    const beforePageThree = listCharacterSummaries("u1", { limit: 200, offset: 1_000 }, { sort: "discover", seed: 17 });
    const afterPageOne = listCharacterSummaries("u1", { limit: 500, offset: 0 }, { sort: "discover", seed: 29 });

    const beforeFirstPageIds = new Set(beforePageOne.data.map((item) => item.id));
    const laterPageIds = new Set([...beforePageTwo.data, ...beforePageThree.data].map((item) => item.id));
    const promotedCount = afterPageOne.data.filter((item) => !beforeFirstPageIds.has(item.id) && laterPageIds.has(item.id)).length;

    expect(promotedCount).toBeGreaterThan(0);
  });
});

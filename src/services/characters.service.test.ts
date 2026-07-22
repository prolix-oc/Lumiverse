import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { listCharacterSummaries, listCharacterSummariesByTokens } from "./characters.service";
import { _resetForTests as resetTokenizerForTests } from "./tokenizer.service";

function initCharactersTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  const db = getDb();
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    image_id TEXT,
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleting INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE tokenizer_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE tokenizer_model_patterns (
    id TEXT PRIMARY KEY,
    tokenizer_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
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

function seedCharacterDetails(input: {
  index: number;
  name: string;
  creator?: string;
  description?: string;
  personality?: string;
  scenario?: string;
}): string {
  const id = makeUuid(input.index);
  getDb()
    .query(
      `INSERT INTO characters (
        id, user_id, name, creator, description, personality, scenario,
        tags, image_id, alternate_greetings, created_at, updated_at
      ) VALUES (?, 'u1', ?, ?, ?, ?, ?, '[]', NULL, '[]', 1, 1)`
    )
    .run(
      id,
      input.name,
      input.creator || "",
      input.description || "",
      input.personality || "",
      input.scenario || "",
    );
  return id;
}

function configureApproximateTokenizer(charsPerToken: number): void {
  getDb()
    .query(
      "INSERT INTO tokenizer_configs (id, name, type, config) VALUES ('test-tokenizer', 'Test tokenizer', 'approximate', ?)"
    )
    .run(JSON.stringify({ charsPerToken }));
  getDb()
    .query(
      "INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern, priority) VALUES ('test-pattern', 'test-tokenizer', '^test-model$', 100)"
    )
    .run();
  resetTokenizerForTests();
}

function seedChat(chatId: string, characterId: string, updatedAt: number, metadata = "{}"): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, metadata, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, "u1", characterId, metadata, updatedAt);
}

beforeEach(() => {
  initCharactersTestDb();
  resetTokenizerForTests();
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

describe("character author sorting", () => {
  test("sorts case-insensitively in both directions while keeping blank authors last", () => {
    seedCharacterDetails({ index: 1, name: "Zeta", creator: "alice" });
    seedCharacterDetails({ index: 2, name: "Beta", creator: "Bob" });
    seedCharacterDetails({ index: 3, name: "Alpha", creator: "bob" });
    seedCharacterDetails({ index: 4, name: "No author", creator: "" });
    seedCharacterDetails({ index: 5, name: "Whitespace", creator: "   " });

    const asc = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "author", direction: "asc" });
    const desc = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "author", direction: "desc" });

    expect(asc.data.map((character) => character.name)).toEqual([
      "Zeta",
      "Alpha",
      "Beta",
      "No author",
      "Whitespace",
    ]);
    expect(desc.data.map((character) => character.name)).toEqual([
      "Alpha",
      "Beta",
      "Zeta",
      "No author",
      "Whitespace",
    ]);
  });

  test("uses name and id tie-breakers for stable pagination", () => {
    const firstId = seedCharacterDetails({ index: 8, name: "Same", creator: "Author" });
    const secondId = seedCharacterDetails({ index: 9, name: "Same", creator: "author" });
    seedCharacterDetails({ index: 10, name: "Alpha", creator: "Author" });

    const all = listCharacterSummaries("u1", { limit: 3, offset: 0 }, { sort: "author", direction: "asc" });
    const pageOne = listCharacterSummaries("u1", { limit: 2, offset: 0 }, { sort: "author", direction: "asc" });
    const pageTwo = listCharacterSummaries("u1", { limit: 2, offset: 2 }, { sort: "author", direction: "asc" });

    expect([...pageOne.data, ...pageTwo.data].map((character) => character.id)).toEqual(
      all.data.map((character) => character.id),
    );
    expect(all.data.slice(1).map((character) => character.id)).toEqual([firstId, secondId]);
  });
});

describe("character token sorting", () => {
  test("sums Description, Personality, and Scenario separately with the char/4 fallback", async () => {
    seedCharacterDetails({ index: 20, name: "Three fields", description: "x", personality: "x", scenario: "x" });
    seedCharacterDetails({ index: 21, name: "One field", description: "xxxxx" });
    seedCharacterDetails({ index: 22, name: "Ignored content", creator: "x".repeat(200) });

    const asc = await listCharacterSummariesByTokens(
      "u1",
      { limit: 10, offset: 0 },
      { sort: "tokens", direction: "asc" },
    );
    const desc = await listCharacterSummariesByTokens(
      "u1",
      { limit: 10, offset: 0 },
      { sort: "tokens", direction: "desc" },
    );

    expect(asc.data.map((character) => character.name)).toEqual(["Ignored content", "One field", "Three fields"]);
    expect(desc.data.map((character) => character.name)).toEqual(["Three fields", "One field", "Ignored content"]);
  });

  test("uses the tokenizer resolved for model_id", async () => {
    configureApproximateTokenizer(2);
    seedCharacterDetails({ index: 30, name: "Alpha", description: "xxx", personality: "xxx", scenario: "xxx" });
    seedCharacterDetails({ index: 31, name: "Zed", description: "xxxxxxxxxx" });

    const result = await listCharacterSummariesByTokens(
      "u1",
      { limit: 10, offset: 0 },
      { sort: "tokens", direction: "asc" },
      "test-model",
    );

    expect(result.data.map((character) => character.name)).toEqual(["Zed", "Alpha"]);
  });

  test("paginates only after stable token ordering", async () => {
    seedCharacterDetails({ index: 40, name: "Beta", description: "xxxx" });
    const firstId = seedCharacterDetails({ index: 41, name: "Same", description: "xxxx" });
    const secondId = seedCharacterDetails({ index: 42, name: "Same", description: "xxxx" });
    seedCharacterDetails({ index: 43, name: "Alpha", description: "xxxxxxxx" });

    const all = await listCharacterSummariesByTokens("u1", { limit: 4, offset: 0 }, { direction: "asc" });
    const pageOne = await listCharacterSummariesByTokens("u1", { limit: 2, offset: 0 }, { direction: "asc" });
    const pageTwo = await listCharacterSummariesByTokens("u1", { limit: 2, offset: 2 }, { direction: "asc" });

    expect([...pageOne.data, ...pageTwo.data].map((character) => character.id)).toEqual(
      all.data.map((character) => character.id),
    );
    expect(all.data.slice(1, 3).map((character) => character.id)).toEqual([firstId, secondId]);
  });
});

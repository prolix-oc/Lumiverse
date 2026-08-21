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
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    image_id TEXT,
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    library_scope TEXT NOT NULL DEFAULT 'mine',
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

function seedChat(chatId: string, characterId: string, updatedAt: number, metadata = "{}", userId = "u1"): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, metadata, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, userId, characterId, metadata, updatedAt);
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

describe("character recent chat sorting", () => {
  test("ranks recently messaged characters above unchatted characters", () => {
    const char1 = seedCharacter(1, "Alpha", 1_000);
    const char2 = seedCharacter(2, "Beta", 1_000);

    let summaries = listCharacterSummaries("u1", { limit: 1, offset: 0 }, { sort: "recent" });
    expect(summaries.data[0]?.id).toBe(char1);
    expect(summaries.total).toBe(2);

    seedChat("chat-beta", char2, 5_000);

    summaries = listCharacterSummaries("u1", { limit: 1, offset: 0 }, { sort: "recent" });
    expect(summaries.data[0]?.id).toBe(char2);
    expect(summaries.total).toBe(2);
  });

  test("ranks every group chat participant by the latest group activity", () => {
    const char1 = seedCharacter(10, "GroupMember1", 1_000);
    const char2 = seedCharacter(11, "GroupMember2", 1_000);

    const groupMeta = JSON.stringify({ group: true, character_ids: [char1, char2] });
    seedChat("group-chat-1", char1, 8_000, groupMeta);

    const summaries = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "recent" });
    const topTwoIds = summaries.data.slice(0, 2).map((character) => character.id);

    expect(topTwoIds).toContain(char1);
    expect(topTwoIds).toContain(char2);
  });

  test("ignores chats marked as hidden_from_recent", () => {
    const char1 = seedCharacter(20, "VisibleChar", 2_000);
    const char2 = seedCharacter(21, "HiddenChar", 1_000);

    const hiddenMeta = JSON.stringify({ hidden_from_recent: true });
    seedChat("chat-hidden", char2, 10_000, hiddenMeta);

    const summaries = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "recent" });
    expect(summaries.data[0]?.id).toBe(char1);
  });
});

describe("character most-chats sorting", () => {
  test("ranks cards by their one-on-one chat count and excludes group chats", () => {
    const mostChatted = seedCharacter(30, "Most Chatted", 1_000);
    const someChats = seedCharacter(31, "Some Chats", 2_000);
    const groupOnly = seedCharacter(32, "Group Only", 3_000);
    const noChats = seedCharacter(33, "No Chats", 4_000);

    seedChat("most-1", mostChatted, 1_000);
    seedChat("most-2", mostChatted, 2_000);
    seedChat("most-3", mostChatted, 3_000);
    seedChat("some-1", someChats, 4_000);
    seedChat("group-1", groupOnly, 5_000, JSON.stringify({ group: true, character_ids: [groupOnly] }));

    const summaries = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "most_chats" });

    expect(summaries.data.map((character) => character.id)).toEqual([
      mostChatted,
      someChats,
      noChats,
      groupOnly,
    ]);
  });

  test("counts only chats belonging to the requesting user", () => {
    const character = seedCharacter(40, "Private", 1_000);
    const otherCharacter = seedCharacter(41, "Other", 2_000);

    seedChat("mine", character, 1_000);
    seedChat("someone-else-1", otherCharacter, 2_000, "{}", "u2");
    seedChat("someone-else-2", otherCharacter, 3_000, "{}", "u2");

    const summaries = listCharacterSummaries("u1", { limit: 10, offset: 0 }, { sort: "most_chats" });

    expect(summaries.data.map((item) => item.id)).toEqual([character, otherCharacter]);
  });
});

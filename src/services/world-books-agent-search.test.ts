import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  AGENT_LORE_SEARCH_SCAN_MAX_BYTES,
  AGENT_LORE_SEARCH_SCAN_MAX_ROWS,
} from "./agent-runtime-accounting";
import {
  AgentLoreQueryLimitError,
  createEntry,
  createWorldBook,
  searchOwnedAgentLoreEntries,
} from "./world-books.service";

async function initDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function addEntry(
  userId: string,
  bookId: string,
  input: Parameters<typeof createEntry>[2],
) {
  const result = createEntry(userId, bookId, input);
  if (!result) throw new Error("expected entry to be created");
  return result;
}

beforeEach(initDb);
afterEach(() => closeDatabase());

describe("owned agent lore search relevance", () => {
  test("weighted FTS ranks identity matches before secondary and content mentions", () => {
    const ownerBook = createWorldBook("user-a", { name: "Owner" });
    const foreignBook = createWorldBook("user-b", { name: "Foreign" });
    const content = addEntry("user-a", ownerBook.id, {
      comment: "Background",
      key: ["other"],
      content: "A long unrelated passage mentioning Clark once.",
      order_value: 1,
    });
    const title = addEntry("user-a", ownerBook.id, {
      comment: "Clark",
      key: ["other"],
      content: "A title match.",
      order_value: 2,
    });
    const primaryKey = addEntry("user-a", ownerBook.id, {
      comment: "Other",
      key: ["Clark"],
      content: "A primary-key match.",
      order_value: 3,
    });
    const secondary = addEntry("user-a", ownerBook.id, {
      comment: "Secondary",
      key: ["other"],
      keysecondary: ["Clark"],
      content: "A secondary-key match.",
      order_value: 4,
    });
    addEntry("user-a", ownerBook.id, {
      comment: "Disabled Clark",
      key: ["Clark"],
      content: "Must not be returned.",
      disabled: true,
      order_value: 5,
    });
    addEntry("user-b", foreignBook.id, {
      comment: "Foreign Clark",
      key: ["Clark"],
      content: "Must not cross tenants.",
    });

    const first = searchOwnedAgentLoreEntries("user-a", {
      query: "Clark",
      limit: 50,
      offset: 0,
    });
    const second = searchOwnedAgentLoreEntries("user-a", {
      query: "Clark",
      limit: 50,
      offset: 0,
    });
    const firstIds = first.data.map((entry) => entry.id);
    expect(firstIds).toEqual(second.data.map((entry) => entry.id));
    expect(first).toMatchObject({ total: 4, limit: 50, offset: 0 });
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(new Set(firstIds.slice(0, 2))).toEqual(new Set([title.id, primaryKey.id]));
    expect(firstIds.slice(2)).toEqual([secondary.id, content.id]);

    const page = searchOwnedAgentLoreEntries("user-a", {
      query: "Clark",
      limit: 1,
      offset: 1,
    });
    expect(page).toMatchObject({
      total: 4,
      limit: 1,
      offset: 1,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).toBe(firstIds[1]);
  });

  test("short-query LIKE fallback keeps exact, prefix, substring, and field precedence", () => {
    const book = createWorldBook("user-a", { name: "Short" });
    const exact = addEntry("user-a", book.id, {
      comment: "Cl",
      key: ["other"],
      content: "Exact title.",
      order_value: 1,
    });
    const prefix = addEntry("user-a", book.id, {
      comment: "Clark",
      key: ["other"],
      content: "Prefix title.",
      order_value: 2,
    });
    const substring = addEntry("user-a", book.id, {
      comment: "The Clark record",
      key: ["other"],
      content: "Substring title.",
      order_value: 3,
    });
    const secondary = addEntry("user-a", book.id, {
      comment: "Other",
      key: ["other"],
      keysecondary: ["Cl"],
      content: "Secondary match.",
      order_value: 4,
    });
    const content = addEntry("user-a", book.id, {
      comment: "Other content",
      key: ["other"],
      content: "A long passage mentioning Cl once.",
      order_value: 5,
    });

    const result = searchOwnedAgentLoreEntries("user-a", {
      query: "Cl",
      limit: 50,
      offset: 0,
    });
    expect(result).toMatchObject({ total: 5, limit: 50, offset: 0 });
    expect(result.data.map((entry) => entry.id)).toEqual([
      exact.id,
      prefix.id,
      substring.id,
      secondary.id,
      content.id,
    ]);
  });

  test("keeps owned ordering independent from foreign FTS statistics", () => {
    const ownerBook = createWorldBook("user-a", { name: "Owner" });
    const foreignBook = createWorldBook("user-b", { name: "Foreign" });
    const first = addEntry("user-a", ownerBook.id, {
      comment: "First",
      key: ["other"],
      content: "prefix alpha beta alpha alpha alpha",
      order_value: 1,
    });
    const second = addEntry("user-a", ownerBook.id, {
      comment: "Second",
      key: ["other"],
      content: "prefix alpha beta beta beta beta",
      order_value: 2,
    });
    const before = searchOwnedAgentLoreEntries("user-a", {
      query: "alpha beta",
      limit: 1,
      offset: 0,
    });

    for (let index = 0; index < 40; index += 1) {
      addEntry("user-b", foreignBook.id, {
        comment: `Foreign ${index}`,
        key: ["other"],
        content: "alpha alpha alpha alpha alpha",
        order_value: index,
      });
    }

    const afterFirst = searchOwnedAgentLoreEntries("user-a", {
      query: "alpha beta",
      limit: 1,
      offset: 0,
    });
    const afterSecond = searchOwnedAgentLoreEntries("user-a", {
      query: "alpha beta",
      limit: 1,
      offset: 1,
    });
    expect(before.data.map((entry) => entry.id)).toEqual([first.id]);
    expect(afterFirst.data.map((entry) => entry.id)).toEqual([first.id]);
    expect(afterSecond.data.map((entry) => entry.id)).toEqual([second.id]);
  });

  test("Unicode-folds identity tiers for FTS and short-query searches", () => {
    const book = createWorldBook("user-a", { name: "Unicode" });
    const exactIdentity = addEntry("user-a", book.id, {
      comment: "åke",
      key: ["other"],
      content: "Identity entry.",
      order_value: 2,
    });
    const contentOnly = addEntry("user-a", book.id, {
      comment: "Background",
      key: ["other"],
      content: "Åke",
      order_value: 1,
    });

    const fts = searchOwnedAgentLoreEntries("user-a", {
      query: "Åke",
      limit: 50,
      offset: 0,
    });
    expect(fts.data.map((entry) => entry.id)).toEqual([
      exactIdentity.id,
      contentOnly.id,
    ]);

    const short = searchOwnedAgentLoreEntries("user-a", {
      query: "Å",
      limit: 50,
      offset: 0,
    });
    expect(short.data.map((entry) => entry.id)).toEqual([
      exactIdentity.id,
      contentOnly.id,
    ]);
  });

  test("rejects an oversized relevance scan before a second corpus pass", () => {
    const book = createWorldBook("user-a", { name: "Bounded" });
    for (let index = 0; index <= AGENT_LORE_SEARCH_SCAN_MAX_ROWS; index += 1) {
      addEntry("user-a", book.id, {
        comment: `needle ${index}`,
        key: ["other"],
        content: "Small candidate",
        order_value: index,
      });
    }

    expect(() => searchOwnedAgentLoreEntries("user-a", {
      query: "needle",
      limit: 1,
      offset: 0,
    })).toThrow(AgentLoreQueryLimitError);
  });

  test("accounts cumulative UTF-8 bytes for ranked content", () => {
    const book = createWorldBook("user-a", { name: "Byte bounded" });
    const content = "é".repeat(Math.floor(AGENT_LORE_SEARCH_SCAN_MAX_BYTES / 4) + 1);
    addEntry("user-a", book.id, {
      comment: "Cl first",
      key: ["other"],
      content,
      order_value: 1,
    });
    addEntry("user-a", book.id, {
      comment: "Cl second",
      key: ["other"],
      content,
      order_value: 2,
    });

    expect(() => searchOwnedAgentLoreEntries("user-a", {
      query: "Cl",
      limit: 1,
      offset: 0,
    })).toThrow(AgentLoreQueryLimitError);
  });

  test("accounts UTF-8 bytes for oversized comments before ranking", () => {
    const book = createWorldBook("user-a", { name: "Comment bounded" });
    const comment = `Cl ${"é".repeat(Math.floor(AGENT_LORE_SEARCH_SCAN_MAX_BYTES / 2) + 1)}`;
    addEntry("user-a", book.id, {
      comment,
      key: ["other"],
      content: "Small candidate",
    });

    expect(() => searchOwnedAgentLoreEntries("user-a", {
      query: "Cl",
      limit: 1,
      offset: 0,
    })).toThrow(AgentLoreQueryLimitError);
  });

  test("accounts serialized primary and secondary keys in the preflight", () => {
    const book = createWorldBook("user-a", { name: "Key bounded" });
    const key = `needle${"é".repeat(Math.floor(AGENT_LORE_SEARCH_SCAN_MAX_BYTES / 4) + 1)}`;
    addEntry("user-a", book.id, {
      comment: "Other",
      key: [key],
      keysecondary: [key],
      content: "Small candidate",
    });

    expect(() => searchOwnedAgentLoreEntries("user-a", {
      query: "needle",
      limit: 1,
      offset: 0,
    })).toThrow(AgentLoreQueryLimitError);
  });

});

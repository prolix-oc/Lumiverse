import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import type { DatabankDocument } from "./types";
import {
  __mentionResolveCacheTest,
  clearAllResolveCache,
  extractMentionSlugs,
  formatMentionsAsAppendix,
  resolveSlugContent,
  stripMentions,
} from "./mention-resolver.service";

describe("extractMentionSlugs", () => {
  test("extracts a basic slug", () => {
    const slugs = extractMentionSlugs("please read #foo and respond");
    expect(slugs.has("foo")).toBe(true);
    expect(slugs.size).toBe(1);
  });

  test("returns empty set when message has no '#' character", () => {
    expect(extractMentionSlugs("nothing to see here").size).toBe(0);
  });

  test("dedupes repeated slugs in the same message", () => {
    const slugs = extractMentionSlugs("#foo and #foo and #foo again");
    expect(slugs.size).toBe(1);
    expect(slugs.has("foo")).toBe(true);
  });

  test("captures multiple distinct slugs", () => {
    const slugs = extractMentionSlugs("compare #alpha-doc with #beta and #gamma-3");
    expect(slugs.size).toBe(3);
    expect(slugs.has("alpha-doc")).toBe(true);
    expect(slugs.has("beta")).toBe(true);
    expect(slugs.has("gamma-3")).toBe(true);
  });

  test("matches at start of string", () => {
    const slugs = extractMentionSlugs("#first-thing then talk");
    expect(slugs.has("first-thing")).toBe(true);
  });

  test("ignores hash characters not preceded by whitespace", () => {
    // "C#" or "abc#foo" are not mentions
    const slugs = extractMentionSlugs("I love C#programming and abc#foo");
    expect(slugs.size).toBe(0);
  });

  test("lowercases captured slugs", () => {
    const slugs = extractMentionSlugs("look at #FooBar");
    expect(slugs.has("foobar")).toBe(true);
  });
});

describe("stripMentions", () => {
  test("removes resolved slug while preserving surrounding text", () => {
    const out = stripMentions("please read #foo and respond", new Set(["foo"]));
    expect(out).toBe("please read and respond");
  });

  test("leaves unresolved slugs alone", () => {
    const out = stripMentions("read #foo but not #bar", new Set(["foo"]));
    expect(out).toBe("read but not #bar");
  });

  test("removes multiple instances of the same slug", () => {
    const out = stripMentions("#foo and #foo again", new Set(["foo"]));
    expect(out).toBe("and again");
  });

  test("returns input unchanged when no '#' is present", () => {
    const out = stripMentions("nothing here", new Set(["foo"]));
    expect(out).toBe("nothing here");
  });

  test("returns input unchanged when validSlugs is empty", () => {
    const out = stripMentions("read #foo please", new Set());
    expect(out).toBe("read #foo please");
  });

  test("strips longer slug exactly when present in validSlugs", () => {
    const out = stripMentions("read #foo-bar please", new Set(["foo-bar"]));
    expect(out).toBe("read please");
  });
});

describe("mention resolution cache", () => {
  test("caps retained results and clears them under memory pressure", () => {
    clearAllResolveCache();
    for (let index = 0; index <= 256; index++) {
      __mentionResolveCacheTest.set(`key-${index}`, [{
        slug: `doc-${index}`,
        documentName: `Document ${index}`,
        content: "content",
        truncated: false,
      }]);
    }

    expect(__mentionResolveCacheTest.size()).toBe(256);
    expect(__mentionResolveCacheTest.keys()).not.toContain("key-0");

    clearAllResolveCache();
    expect(__mentionResolveCacheTest.size()).toBe(0);
  });

  test("does not retain a second copy of oversized full documents", () => {
    clearAllResolveCache();
    __mentionResolveCacheTest.set("oversized", [{
      slug: "large-doc",
      documentName: "Large Document",
      content: "x".repeat(256 * 1024 + 1),
      truncated: false,
    }]);

    expect(__mentionResolveCacheTest.size()).toBe(0);
  });
});

describe("resolveSlugContent", () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run(`CREATE TABLE databank_chunks (
      document_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    )`);
    clearAllResolveCache();
  });

  afterEach(() => {
    clearAllResolveCache();
    closeDatabase();
  });

  test("injects every stored chunk for documents above the former token cutoff", async () => {
    const firstHalf = Array.from({ length: 1_600 }, (_, index) => `first-${index}`).join(" ");
    const secondHalf = Array.from({ length: 700 }, (_, index) => `second-${index}`).join(" ");
    const fullText = `${firstHalf}\n${secondHalf}`;
    const db = getDb();
    db.run(
      "INSERT INTO databank_chunks (document_id, user_id, chunk_index, content) VALUES (?, ?, ?, ?)",
      ["doc-large", "user-1", 0, firstHalf],
    );
    db.run(
      "INSERT INTO databank_chunks (document_id, user_id, chunk_index, content) VALUES (?, ?, ?, ?)",
      ["doc-large", "user-1", 1, secondHalf],
    );

    const doc: DatabankDocument = {
      id: "doc-large",
      databankId: "bank-1",
      userId: "user-1",
      name: "Large Document",
      slug: "large-document",
      filePath: "large.md",
      mimeType: "text/markdown",
      fileSize: fullText.length,
      contentHash: "large-document-v1",
      totalChunks: 2,
      status: "ready",
      errorMessage: null,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };

    const resolved = await resolveSlugContent(
      "user-1",
      "chat-1",
      [doc.slug],
      new Map([[doc.slug, doc]]),
    );

    expect(resolved).toEqual([{
      slug: doc.slug,
      documentName: doc.name,
      content: fullText,
      truncated: false,
    }]);
    expect(resolved[0].content.length).toBeGreaterThan(3_000);
    expect(formatMentionsAsAppendix(resolved)).not.toContain("most relevant excerpts");
  });
});

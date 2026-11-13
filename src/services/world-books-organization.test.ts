import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

const queued: string[] = [];
const deleted: string[] = [];
mock.module("./embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async (_userId: string, id: string) => { deleted.push(id); },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(_userId: string, _ids: string[], operation: () => T) => operation(),
}));
mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: (_userId: string, id: string) => { queued.push(id); },
}));
const svc = await import("./world-books.service");
const owner = "organization-owner";
beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  queued.length = 0;
  deleted.length = 0;
});
afterEach(closeDatabase);

describe("native lorebook entry organization", () => {
  test("normalizes metadata, supports clearing, and preserves it in duplicate and bulk copy", async () => {
    const book = svc.createWorldBook(owner, { name: "Book" });
    const entry = svc.createEntry(owner, book.id, { folder: " Characters ", tags: [" villain ", "villain", "Villain", ""], content: "Lore" })!;
    expect(entry).toMatchObject({ folder: "Characters", tags: ["villain", "Villain"] });
    expect(svc.createEntry(owner, book.id, {})!).toMatchObject({ folder: "", tags: [] });
    expect(svc.duplicateEntry(owner, entry.id)).toMatchObject({ folder: entry.folder, tags: entry.tags });
    const target = svc.createWorldBook(owner, { name: "Target" });
    await svc.bulkOperateEntries(owner, book.id, { action: "copy", target_book_id: target.id, entry_ids: [entry.id], expected_revisions: { [entry.id]: entry.revision } });
    expect(svc.listEntries(owner, target.id)[0]).toMatchObject({ folder: entry.folder, tags: entry.tags });
    const updated = svc.updateEntry(owner, entry.id, { folder: "", tags: [], expected_revision: entry.revision })!;
    expect(updated).toMatchObject({ folder: "", tags: [], revision: entry.revision + 1 });
    expect(() => svc.updateEntry(owner, entry.id, { folder: "Stale", expected_revision: entry.revision })).toThrow(svc.WorldBookEntryConflictError);
  });

  test("organization-only individual and bulk edits preserve genuinely indexed vectors and order", async () => {
    const book = svc.createWorldBook(owner, { name: "Book" });
    const entry = svc.createEntry(owner, book.id, { vectorized: true, content: "Lore", order_value: 321 })!;
    getDb().query("UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 123 WHERE id = ?").run(entry.id);
    queued.length = 0;
    let updated = svc.updateEntry(owner, entry.id, { folder: "Characters", tags: ["villain"], expected_revision: entry.revision })!;
    expect(updated).toMatchObject({ vector_index_status: "indexed", vector_indexed_at: 123, order_value: 321, content: "Lore" });
    await svc.bulkOperateEntries(owner, book.id, { action: "set_fields", fields: { folder: "Systems", tags: ["rule"] }, entry_ids: [entry.id], expected_revisions: { [entry.id]: updated.revision } });
    updated = svc.getEntry(owner, entry.id)!;
    expect(updated).toMatchObject({ folder: "Systems", tags: ["rule"], vector_index_status: "indexed", vector_indexed_at: 123, order_value: 321 });
    expect(queued).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("claims organization only for known native imports and flattens standard exports", async () => {
    const raw = { folder: "Characters", tags: ["villain"], keys: ["alpha"], content: "Lore", insertion_order: 19 };
    expect(svc.normalizeImportedEntryInput(raw, 0)).toMatchObject({ folder: "", tags: [], extensions: { folder: "Characters", tags: ["villain"] } });
    const original = svc.importWorldBook(owner, { type: "lumiverse_world_book", name: "Native", entries: [raw] }).worldBook;
    const entry = svc.listEntries(owner, original.id)[0];
    expect(entry).toMatchObject({ folder: "Characters", tags: ["villain"], extensions: {} });
    const native = svc.exportWorldBook(owner, original.id, "lumiverse")!;
    const roundTrip = svc.importWorldBook(owner, native).worldBook;
    expect(svc.listEntries(owner, roundTrip.id)[0]).toMatchObject({ folder: "Characters", tags: ["villain"] });
    const embedded = svc.importLumiverseWorldBook(owner, "character", native).worldBook;
    expect(svc.listEntries(owner, embedded.id)[0]).toMatchObject({ folder: "Characters", tags: ["villain"] });
    for (const format of ["character_book", "sillytavern"] as const) {
      const payload = svc.exportWorldBook(owner, original.id, format)!;
      const exported = Array.isArray(payload.entries) ? payload.entries[0] : payload.entries["0"];
      expect(exported).toMatchObject(format === "sillytavern" ? { uid: 0, content: "Lore", order: 19, key: ["alpha"] } : { content: "Lore", insertion_order: 19, keys: ["alpha"] });
      expect(exported.folder).toBeUndefined();
      expect(exported.tags).toBeUndefined();
      expect(exported.extensions?.folder).toBeUndefined();
      expect(exported.extensions?.tags).toBeUndefined();
    }
    const bulk = await svc.importWorldBookBulk(owner, native);
    expect(svc.listEntries(owner, bulk.worldBook.id)[0]).toMatchObject({ folder: "Characters", tags: ["villain"] });
  });

  test("ST export renders every UUID-backed row and preserves canonical settings despite legacy extension aliases", () => {
    const book = svc.createWorldBook(owner, { name: "ST compatibility fixture" });
    for (let index = 0; index < 44; index++) svc.createEntry(owner, book.id, {
      content: `Lore ${index}`, comment: `Entry ${index}`, key: [`key ${index}`], keysecondary: ["secondary"],
      folder: "Characters", tags: ["a,b"], disabled: index % 2 === 0, order_value: 77,
      role: index % 3 === 0 ? "assistant" : index % 3 === 1 ? "user" : "system",
      group_override: true, group_weight: 23, case_sensitive: true, match_whole_words: true,
      scan_depth: 6, automation_id: "automation", prevent_recursion: true, exclude_recursion: true,
      delay_until_recursion: true, use_probability: false, probability: 37,
      extensions: { uid: "stale-uuid", key: ["stale"], keys: ["stale alias"], order: -1,
        insertion_order: -2, disable: false, enabled: true, case_sensitive: false,
        groupWeight: -3, displayIndex: 999, revision: 99, characterFilter: { names: ["fixture"], isExclude: false } },
    });
    const source = svc.listEntries(owner, book.id);
    const exported = svc.exportWorldBook(owner, book.id, "sillytavern")!;
    // Minimal ST consumer: enumerate entries, then locate each row by its UID.
    const rendered = Object.values(exported.entries).map((entry: any) => {
      expect(Number.isInteger(entry.uid)).toBe(true);
      expect(exported.entries[entry.uid]).toBe(entry);
      expect(Array.isArray(entry.key)).toBe(true);
      expect(Array.isArray(entry.keysecondary)).toBe(true);
      return entry;
    });
    expect(rendered.length).toBe(44);
    rendered.forEach((entry, index) => {
      expect(entry).toMatchObject({ uid: index, displayIndex: index, key: source[index].key,
        keysecondary: ["secondary"], disable: source[index].disabled, order: 77,
        role: source[index].role === "assistant" ? 2 : source[index].role === "user" ? 1 : 0,
        groupOverride: true, groupWeight: 23, caseSensitive: true, matchWholeWords: true,
        scanDepth: 6, automationId: "automation", preventRecursion: true, excludeRecursion: true,
        delayUntilRecursion: 1, useProbability: false, probability: 37,
        characterFilter: { names: ["fixture"], isExclude: false } });
      for (const key of ["folder", "tags", "revision", "keys", "secondary_keys", "enabled", "insertion_order", "case_sensitive"]) expect(entry[key]).toBeUndefined();
      expect(svc.normalizeImportedEntryInput(entry, index)).toMatchObject({ key: source[index].key,
        disabled: source[index].disabled, order_value: index, role: source[index].role,
        group_weight: 23, case_sensitive: true, folder: "", tags: [] });
    });
    expect(svc.exportWorldBook(owner, book.id, "lumiverse")!.entries[0].uid).toBe(source[0].uid);
  });

  test("combines scope, tags, text, type and sort before pagination; facets cover the whole book", () => {
    const book = svc.createWorldBook(owner, { name: "Book" });
    for (let i = 0; i < 12; i++) svc.createEntry(owner, book.id, { folder: i < 9 ? "Characters" : "", tags: i % 2 ? ["villain", "historical"] : ["historical"], constant: i === 1, content: "alpha lore", comment: `Row ${i}`, order_value: i });
    const options = { folder: "Characters", tags: ["villain", "historical"], type: "trigger" as const, search: "alpha", sortDir: "desc" as const };
    const page = svc.listEntriesPaginated(owner, book.id, { limit: 2, offset: 1 }, options);
    expect(page.total).toBe(3);
    expect(page.data.map(entry => entry.order_value)).toEqual([5, 3]);
    expect(svc.listEntriesPaginated(owner, book.id, { limit: 2, offset: 0 }, { folder: "" }).total).toBe(3);
    expect(svc.listEntriesPaginated(owner, book.id, { limit: 2, offset: 0 }, { folder: "Characters", search: "al" }).total).toBe(9);
    expect(svc.listEntriesPaginated(owner, book.id, { limit: 2, offset: 0 }, { tags: ["absent"] }).total).toBe(0);
    expect(svc.getEntryOrganizationSummary(owner, book.id)).toEqual({ total: 12, unfiled: 3, folders: [{ name: "Characters", count: 9 }], tags: [{ name: "historical", count: 12 }, { name: "villain", count: 6 }] });
    expect(svc.getEntryOrganizationSummary("other", book.id)).toBeNull();
    expect(svc.listEntriesPaginated("other", book.id, { limit: 2, offset: 0 }, options).total).toBe(0);
  });

  test("malformed stored tags do not break reads or filtering", () => {
    const book = svc.createWorldBook(owner, { name: "Book" });
    const entry = svc.createEntry(owner, book.id, {})!;
    getDb().query("UPDATE world_book_entries SET tags = 'broken' WHERE id = ?").run(entry.id);
    expect(svc.getEntry(owner, entry.id)?.tags).toEqual([]);
    expect(svc.getEntryOrganizationSummary(owner, book.id)?.tags).toEqual([]);
    expect(svc.listEntriesPaginated(owner, book.id, { limit: 2, offset: 0 }, { tags: ["villain"] }).total).toBe(0);
  });
});

// Failure fixtures use a real in-memory baseline DB and recording vector adapters.
function organizationFixture() {
  const book = svc.createWorldBook(owner, { name: "Source" });
  const target = svc.createWorldBook(owner, { name: "Target" });
  const foreign = svc.createWorldBook("foreign-owner", { name: "Foreign" });
  const first = svc.createEntry(owner, book.id, { folder: "Characters", tags: ["villain", "history"], content: "alpha lore", order_value: 231, vectorized: true })!;
  const second = svc.createEntry(owner, book.id, { folder: "Characters", tags: ["history"], content: "beta lore", order_value: 17, vectorized: true })!;
  const unrelated = svc.createEntry(owner, book.id, { folder: "Systems", content: "Keep", order_value: 900 })!;
  const destination = svc.createEntry(owner, target.id, { folder: "Characters", content: "Destination", order_value: 1 })!;
  for (const entry of [first, second]) getDb().query("UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 99, updated_at = 1 WHERE id = ?").run(entry.id);
  getDb().query("UPDATE world_books SET updated_at = 1").run();
  queued.length = 0;
  deleted.length = 0;
  return { book, target, foreign, first, second, unrelated, destination };
}

function databaseSnapshot() {
  return {
    books: getDb().query("SELECT * FROM world_books ORDER BY id").all(),
    entries: getDb().query("SELECT * FROM world_book_entries ORDER BY id").all(),
  };
}

describe("organization operations and failure boundaries", () => {
  for (const targetFolder of ["Locations", "", " Characters ", "All entries", "Unfiled", "📚 世界 / %_'\" OR 1=1 --"]) {
    test(`same-book move to ${JSON.stringify(targetFolder)} preserves order and indexed vector state`, async () => {
      const f = organizationFixture();
      const beforeUnrelated = svc.getEntry(owner, f.unrelated.id);
      const result = await svc.bulkOperateEntries(owner, f.book.id, { action: "move", target_book_id: f.book.id, target_folder: targetFolder, entry_ids: [f.second.id, f.first.id, f.first.id], expected_revisions: { [f.first.id]: f.first.revision, [f.second.id]: f.second.revision } });
      expect(result?.affected).toBe(2);
      for (const previous of [f.first, f.second]) {
        const current = svc.getEntry(owner, previous.id)!;
        expect(current).toMatchObject({ folder: targetFolder.trim(), revision: previous.revision + 1, order_value: previous.order_value, vector_index_status: "indexed", vector_indexed_at: 99, tags: previous.tags });
        expect(() => svc.updateEntry(owner, current.id, { content: "stale", expected_revision: previous.revision })).toThrow(svc.WorldBookEntryConflictError);
      }
      expect(svc.getEntry(owner, f.unrelated.id)).toEqual(beforeUnrelated);
      expect(queued).toEqual([]);
      expect(deleted).toEqual([]);
    });
  }

  for (const targetFolder of [undefined, "", "Characters", "New folder"]) {
    test(`cross-book selected move ${JSON.stringify(targetFolder)} retains established ordering and tags`, async () => {
      const f = organizationFixture();
      const destinationBefore = svc.getEntry(owner, f.destination.id);
      await svc.bulkOperateEntries(owner, f.book.id, { action: "move", entry_ids: [f.first.id, f.second.id], target_book_id: f.target.id, target_folder: targetFolder });
      for (const entry of [f.first, f.second]) expect(svc.getEntry(owner, entry.id)).toMatchObject({ world_book_id: f.target.id, folder: targetFolder ?? "Characters", tags: entry.tags, order_value: entry.order_value, revision: 2, vector_index_status: "pending", vector_indexed_at: null });
      expect(svc.getEntry(owner, f.destination.id)).toEqual(destinationBefore);
      expect(queued.sort()).toEqual([f.first.id, f.second.id].sort());
      expect(deleted).toEqual([]);
    });
  }

  test("rename merges existing names, remove unfiles, and stale editors cannot overwrite folder changes", () => {
    const f = organizationFixture();
    const beforeTarget = svc.listEntries(owner, f.target.id);
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "rename", folder: " Characters ", target_folder: "Systems" })?.affected).toBe(2);
    expect(svc.getEntryOrganizationSummary(owner, f.book.id)?.folders).toEqual([{ name: "Systems", count: 3 }]);
    expect(svc.getEntry(owner, f.first.id)).toMatchObject({ folder: "Systems", revision: 2, order_value: f.first.order_value, vector_index_status: "indexed", vector_indexed_at: 99 });
    expect(() => svc.updateEntry(owner, f.first.id, { folder: "Old", expected_revision: 1 })).toThrow(svc.WorldBookEntryConflictError);
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "remove", folder: "Systems" })?.affected).toBe(3);
    expect(svc.getEntryOrganizationSummary(owner, f.book.id)).toMatchObject({ folders: [], unfiled: 3 });
    expect(svc.listEntries(owner, f.target.id)).toEqual(beforeTarget);
    expect(queued).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("whole-folder cross-book move merges names, retains order, resets only moved vectors and touches both books", () => {
    const f = organizationFixture();
    const beforeUnrelated = svc.getEntry(owner, f.unrelated.id);
    const beforeDestination = svc.getEntry(owner, f.destination.id);
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "move", folder: "Characters", target_book_id: f.target.id })).toEqual({ affected: 2, target_book_id: f.target.id });
    expect(svc.getEntryOrganizationSummary(owner, f.book.id)?.folders).toEqual([{ name: "Systems", count: 1 }]);
    expect(svc.getEntryOrganizationSummary(owner, f.target.id)?.folders).toEqual([{ name: "Characters", count: 3 }]);
    for (const entry of [f.first, f.second]) expect(svc.getEntry(owner, entry.id)).toMatchObject({ folder: "Characters", tags: entry.tags, world_book_id: f.target.id, order_value: entry.order_value, revision: 2, vector_index_status: "pending", vector_indexed_at: null });
    expect(svc.getEntry(owner, f.unrelated.id)).toEqual(beforeUnrelated);
    expect(svc.getEntry(owner, f.destination.id)).toEqual(beforeDestination);
    expect(svc.getWorldBook(owner, f.book.id)!.updated_at).toBeGreaterThan(1);
    expect(svc.getWorldBook(owner, f.target.id)!.updated_at).toBeGreaterThan(1);
    expect(queued.sort()).toEqual([f.first.id, f.second.id].sort());
  });

  test("folder move also supports same-book and explicit Unfiled destination", () => {
    const f = organizationFixture();
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "move", folder: "Characters", target_book_id: f.book.id, target_folder: "Locations" })?.affected).toBe(2);
    expect(queued).toEqual([]);
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "move", folder: "Locations", target_book_id: f.target.id, target_folder: "" })?.affected).toBe(2);
    expect(svc.getEntryOrganizationSummary(owner, f.target.id)?.unfiled).toBe(2);
  });

  test("same-name rename, same-book move without a folder, and missing folders leave timestamps and revisions untouched", async () => {
    const f = organizationFixture();
    const before = databaseSnapshot();
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "rename", folder: "Characters", target_folder: "Characters" })?.affected).toBe(0);
    expect(svc.operateEntryFolder(owner, f.book.id, { action: "remove", folder: "Missing" })?.affected).toBe(0);
    expect((await svc.bulkOperateEntries(owner, f.book.id, { action: "move", target_book_id: f.book.id, entry_ids: [f.first.id] }))?.affected).toBe(0);
    expect(databaseSnapshot()).toEqual(before);
  });

  test("bulk tags add preserves existing tags, deduplicates exact spelling and remove preserves siblings", async () => {
    const f = organizationFixture();
    const ids = [f.first.id, f.second.id];
    await svc.bulkOperateEntries(owner, f.book.id, { action: "add_tags", entry_ids: ids, tags: [" new ", "history", "new", "History"] });
    expect(svc.getEntry(owner, f.first.id)?.tags).toEqual(["villain", "history", "new", "History"]);
    expect(svc.getEntry(owner, f.second.id)?.tags).toEqual(["history", "new", "History"]);
    await svc.bulkOperateEntries(owner, f.book.id, { action: "remove_tags", entry_ids: ids, tags: [" history ", "absent"] });
    expect(svc.getEntry(owner, f.first.id)?.tags).toEqual(["villain", "new", "History"]);
    expect(svc.getEntry(owner, f.second.id)?.tags).toEqual(["new", "History"]);
    expect(svc.getEntry(owner, f.first.id)).toMatchObject({ order_value: 231, vector_index_status: "indexed", vector_indexed_at: 99, revision: 3 });
    expect(queued).toEqual([]);
    expect(deleted).toEqual([]);
  });

  for (const action of ["move", "add_tags", "remove_tags", "set_fields"] as const) {
    test(`stale selection is rejected atomically for ${action}`, async () => {
      const f = organizationFixture();
      svc.updateEntry(owner, f.second.id, { folder: "Winner", expected_revision: 1 });
      const before = databaseSnapshot();
      const input = { action, entry_ids: [f.first.id, f.second.id], expected_revisions: { [f.first.id]: 1, [f.second.id]: 1 }, target_book_id: f.target.id, target_folder: "New", tags: ["new"], fields: { tags: ["new"] } };
      await expect(svc.bulkOperateEntries(owner, f.book.id, input)).rejects.toBeInstanceOf(svc.WorldBookEntryConflictError);
      expect(databaseSnapshot()).toEqual(before);
      expect(queued).toEqual([]);
    });
  }

  for (const bad of [{ folder: null }, { folder: 1 }, { tags: null }, { tags: "villain" }, { tags: ["good", 1] }, { tags: {} }]) {
    test(`invalid metadata ${JSON.stringify(bad)} is rejected before create/update/bulk writes`, async () => {
      const f = organizationFixture();
      const before = databaseSnapshot();
      expect(() => svc.createEntry(owner, f.book.id, bad as never)).toThrow(svc.WorldBookEntryOrganizationError);
      expect(() => svc.updateEntry(owner, f.first.id, bad as never)).toThrow(svc.WorldBookEntryOrganizationError);
      await expect(svc.bulkOperateEntries(owner, f.book.id, { action: "set_fields", entry_ids: [f.first.id, f.second.id], fields: bad as never })).rejects.toBeInstanceOf(svc.WorldBookEntryOrganizationError);
      expect(databaseSnapshot()).toEqual(before);
    });
  }

  for (const tags of [[], ["", " "], null, "tag", [1]]) {
    test(`invalid bulk tags ${JSON.stringify(tags)} cannot clear existing organization`, async () => {
      const f = organizationFixture();
      const before = databaseSnapshot();
      for (const action of ["add_tags", "remove_tags"] as const) await expect(svc.bulkOperateEntries(owner, f.book.id, { action, entry_ids: [f.first.id], tags: tags as never })).rejects.toBeInstanceOf(svc.WorldBookEntryOrganizationError);
      expect(databaseSnapshot()).toEqual(before);
    });
  }

  for (const bad of [null, {}, { action: "unknown", folder: "Characters" }, { action: "remove", folder: "" }, { action: "remove", folder: null }, { action: "rename", folder: "Characters" }, { action: "rename", folder: "Characters", target_folder: " " }, { action: "move", folder: "Characters" }, { action: "move", folder: "Characters", target_book_id: 1 }, { action: "move", folder: "Characters", target_book_id: "missing" }]) {
    test(`invalid folder operation ${JSON.stringify(bad)} leaves all books untouched`, () => {
      const f = organizationFixture();
      const before = databaseSnapshot();
      expect(() => svc.operateEntryFolder(owner, f.book.id, bad as never)).toThrow(svc.WorldBookEntryOrganizationError);
      expect(databaseSnapshot()).toEqual(before);
      expect(queued).toEqual([]);
    });
  }

  test("ownership validation covers source, destination and every selected entry", async () => {
    const f = organizationFixture();
    const foreignEntry = svc.createEntry("foreign-owner", f.foreign.id, { folder: "Characters" })!;
    const before = databaseSnapshot();
    expect(svc.operateEntryFolder(owner, f.foreign.id, { action: "remove", folder: "Characters" })).toBeNull();
    expect(() => svc.operateEntryFolder(owner, f.book.id, { action: "move", folder: "Characters", target_book_id: f.foreign.id })).toThrow(svc.WorldBookEntryOrganizationError);
    await expect(svc.bulkOperateEntries(owner, f.book.id, { action: "move", target_book_id: f.foreign.id, entry_ids: [f.first.id] })).rejects.toThrow("Target world book not found");
    for (const id of [foreignEntry.id, f.destination.id, "missing"]) await expect(svc.bulkOperateEntries(owner, f.book.id, { action: "add_tags", entry_ids: [f.first.id, id], tags: ["new"] })).rejects.toThrow("not found");
    expect(databaseSnapshot()).toEqual(before);
    expect(queued).toEqual([]);
  });

  for (const action of ["rename", "remove", "move"] as const) {
    test(`SQL failure during folder ${action} rolls back entries, books, revisions and vector work`, () => {
      const f = organizationFixture();
      getDb().run(`CREATE TRIGGER fail_organization BEFORE UPDATE ON world_book_entries WHEN OLD.id = '${f.second.id}' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
      const before = databaseSnapshot();
      expect(() => svc.operateEntryFolder(owner, f.book.id, { action, folder: "Characters", target_folder: "New", target_book_id: f.target.id })).toThrow("forced failure");
      expect(databaseSnapshot()).toEqual(before);
      expect(queued).toEqual([]);
      expect(deleted).toEqual([]);
    });
  }

  for (const action of ["move", "add_tags", "remove_tags", "set_fields"] as const) {
    test(`SQL failure midway through bulk ${action} rolls back the whole selection`, async () => {
      const f = organizationFixture();
      getDb().run(`CREATE TRIGGER fail_bulk BEFORE UPDATE ON world_book_entries WHEN OLD.id = '${f.second.id}' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
      const before = databaseSnapshot();
      await expect(svc.bulkOperateEntries(owner, f.book.id, { action, entry_ids: [f.first.id, f.second.id], target_book_id: f.target.id, target_folder: "New", tags: ["new"], fields: { folder: "New" } })).rejects.toThrow("forced failure");
      expect(databaseSnapshot()).toEqual(before);
      expect(queued).toEqual([]);
    });
  }

  for (const value of ["not-json", "null", "42", '"villain"', '{"tag":"villain"}', '["villain","villain"]']) {
    test(`stored JSON ${value} has consistent defensive read, facet and filter behavior`, () => {
      const f = organizationFixture();
      getDb().query("UPDATE world_book_entries SET tags = ? WHERE id = ?").run(value, f.first.id);
      const expected = value.startsWith("[") ? ["villain"] : [];
      expect(svc.getEntry(owner, f.first.id)?.tags).toEqual(expected);
      const page = svc.listEntriesPaginated(owner, f.book.id, { limit: 10, offset: 0 }, { tags: ["villain"] });
      expect(page.total).toBe(expected.length);
      expect(svc.getEntryOrganizationSummary(owner, f.book.id)?.tags.find(tag => tag.name === "villain")?.count ?? 0).toBe(expected.length);
    });
  }

  test("parameterized folder and tag queries treat SQL and LIKE metacharacters as literal values", () => {
    const f = organizationFixture();
    const name = "x' OR 1=1 -- %_世界";
    svc.updateEntry(owner, f.first.id, { folder: name, tags: [name] });
    expect(svc.listEntriesPaginated(owner, f.book.id, { limit: 1, offset: 0 }, { folder: name, tags: [name] }).total).toBe(1);
    expect(svc.getEntryOrganizationSummary(owner, f.book.id)?.folders.some(folder => folder.name === name)).toBe(true);
  });
});

describe("organization normalization and pagination exploration", () => {
  test("only native formats recover old extension organization; native top-level values take precedence", () => {
    const legacy = { content: "Lore", extensions: { folder: " Characters ", tags: [" villain ", "villain"], third_party: { keep: true } } };
    expect(svc.normalizeImportedEntryInput(legacy, 0)).toMatchObject({ folder: "", tags: [], extensions: legacy.extensions });
    expect(svc.normalizeImportedEntryInput(legacy, 0, { format: "lumiverse" })).toMatchObject({ folder: "Characters", tags: ["villain"], extensions: { third_party: { keep: true } } });
    expect(svc.normalizeImportedEntryInput({ ...legacy, folder: "", tags: [] }, 0, { format: "lumiverse" })).toMatchObject({ folder: "", tags: [], extensions: { third_party: { keep: true } } });
    expect(svc.normalizeImportedEntryInput({ folder: 42, tags: ["ok", null, "", "ok"], content: "Lore" }, 0, { format: "lumiverse" })).toMatchObject({ folder: "", tags: ["ok"], extensions: {} });
  });

  test("a 2,107-entry native book matches an independent filter/sort/pagination oracle over 160 combinations", () => {
    const folders = ["", "Characters", "Locations", "📚 世界 / %_'\""];
    const payload = { type: "lumiverse_world_book", entries: Array.from({ length: 2107 }, (_, i) => ({
      folder: folders[i % folders.length], tags: i % 3 ? ["history", "villain"] : ["history"],
      content: i % 2 ? "alpha lore" : "beta lore", comment: `row ${i}`,
      order_value: i % 19, priority: i % 7, vectorized: i % 4 === 0, constant: i % 5 === 0,
    })) };
    const imported = svc.importWorldBook(owner, payload);
    const original = svc.listEntries(owner, imported.worldBook.id);
    expect(original.length).toBe(2107);
    let seed = 0x39134;
    const pick = <T,>(values: readonly T[]) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
    const stringCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    for (let scenario = 0; scenario < 160; scenario++) {
      const folder = pick([undefined, ...folders, "absent"]);
      const tags = pick([[], ["history"], ["villain", "history"], ["absent"], ["villain", "villain"]]);
      const type = pick([undefined, "trigger", "constant", "vector"] as const);
      const search = pick(["", "alpha", "beta"]);
      const sortBy = pick(["order", "priority"] as const);
      const sortDir = pick(["asc", "desc"] as const);
      const limit = pick([1, 17, 50, 1000]);
      const offset = pick([0, 1, 49, 500, 2500]);
      const expected = original.filter(entry =>
        (folder === undefined || entry.folder === folder) && tags.every(tag => entry.tags.includes(tag)) &&
        (type === undefined || (entry.constant ? "constant" : entry.vectorized ? "vector" : "trigger") === type) &&
        (!search || entry.content.includes(search)),
      ).sort((a, b) => {
        const delta = sortBy === "order" ? a.order_value - b.order_value : a.priority - b.priority;
        return delta ? delta * (sortDir === "asc" ? 1 : -1) : stringCompare(a.id, b.id);
      });
      const actual = svc.listEntriesPaginated(owner, imported.worldBook.id, { limit, offset }, { folder, tags, type, search, sortBy, sortDir });
      expect(actual.total).toBe(expected.length);
      expect(actual.data.map(entry => entry.id)).toEqual(expected.slice(offset, offset + limit).map(entry => entry.id));
    }
    expect(svc.operateEntryFolder(owner, imported.worldBook.id, { action: "rename", folder: "Characters", target_folder: "Locations" })?.affected).toBe(527);
    expect(svc.getEntryOrganizationSummary(owner, imported.worldBook.id)?.folders.find(folder => folder.name === "Locations")?.count).toBe(1054);
  });

  test("organization is never part of lexical/FTS search or runtime materialization", () => {
    const book = svc.createWorldBook(owner, { name: "Book" });
    svc.createEntry(owner, book.id, { folder: "uniqueorganization", tags: ["uniquetag"], content: "plain lore" });
    for (const search of ["uniqueorganization", "uniquetag", "zz", "%_"]) expect(svc.listEntriesPaginated(owner, book.id, { limit: 10, offset: 0 }, { search }).total).toBe(0);
    const entries = svc.materializeCharacterBookEntriesForRuntime("embedded", { entries: [{ folder: "foreign", tags: ["foreign"], content: "plain lore" }] });
    expect(entries[0]).toMatchObject({ folder: "", tags: [], content: "plain lore" });
  });

  test("cancelled native bulk imports preserve organization for committed chunks and do not import later chunks", async () => {
    const controller = new AbortController();
    // Native import yields between committed chunks. Abort at its first yield.
    const abortTimer = setTimeout(() => controller.abort(), 0);
    try {
      const result = await svc.importWorldBookBulk(owner, { type: "lumiverse_world_book", entries: Array.from({ length: 1001 }, () => ({ folder: "Characters", tags: ["villain"], content: "Lore" })) }, { signal: controller.signal });
      expect(result.aborted).toBe(true);
      expect(result.entryCount).toBe(500);
      expect(svc.getEntryOrganizationSummary(owner, result.worldBook.id)).toEqual({ total: 500, unfiled: 0, folders: [{ name: "Characters", count: 500 }], tags: [{ name: "villain", count: 500 }] });
    } finally { clearTimeout(abortTimer); }
    const aborted = new AbortController();
    aborted.abort();
    const empty = await svc.importWorldBookBulk(owner, { type: "lumiverse_world_book", entries: [{ folder: "Characters", tags: ["villain"] }] }, { signal: aborted.signal });
    expect(empty).toMatchObject({ aborted: true, entryCount: 0 });
    expect(svc.listEntries(owner, empty.worldBook.id)).toEqual([]);
  });
});

for (const status of ["not_enabled", "pending", "error", "indexed"] as const) {
  test(`organization-only edits leave ${status} vectors and queue untouched`, async () => {
    const f = organizationFixture();
    getDb().query("UPDATE world_book_entries SET vector_index_status = ?, vectorized = ?, vector_index_error = ?, vector_indexed_at = ? WHERE id = ?").run(status, status === "not_enabled" ? 0 : 1, status === "error" ? "retry later" : null, status === "indexed" ? 99 : null, f.first.id);
    const before = svc.getEntry(owner, f.first.id)!;
    svc.updateEntry(owner, f.first.id, { tags: ["organization"] });
    await svc.bulkOperateEntries(owner, f.book.id, { action: "set_fields", entry_ids: [f.first.id], fields: { folder: "Locations" } });
    const after = svc.getEntry(owner, f.first.id)!;
    expect(after).toMatchObject({ vector_index_status: before.vector_index_status, vector_indexed_at: before.vector_indexed_at, vector_index_error: before.vector_index_error, vectorized: before.vectorized, order_value: before.order_value });
    expect(queued).toEqual([]);
    expect(deleted).toEqual([]);
  });
}

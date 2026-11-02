import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { executeDatabaseOperation, startDatabaseExecution, stopDatabaseExecution } from "../db/execution";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";

// SQLite and its subprocess are real. Vector storage is isolated so these tests
// can verify source/cleanup ordering without touching an installation's vectors.
let vectorCleanup: (() => void) | null = null;
const deletedChatVectors: string[] = [];
mock.module("./embeddings.service", () => ({
  getChatMemoryDistanceThreshold: async () => 0.6,
  deleteChatChunkEmbeddings: async (_userId: string, id: string) => { deletedChatVectors.push(id); },
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(_userId: string, _ids: string[], deleteSource: () => Promise<T>) => {
    vectorCleanup?.();
    return await deleteSource();
  },
  deleteWorldBookEmbeddingsBeforeSourceDelete: async <T>(_userId: string, _ids: string[], _entries: string[], deleteSource: () => Promise<T>) => {
    vectorCleanup?.();
    return await deleteSource();
  },
}));
const characters = await import("./characters.service");
const chats = await import("./chats.service");
const personas = await import("./personas.service");
const worldBooks = await import("./world-books.service");
const images = await import("./images.service");
const files = await import("./files.service");
const gallery = await import('./character-gallery.service');

let directory: string;
const originalDataDir = env.dataDir;
beforeEach(async () => {
  await stopDatabaseExecution();
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-service-execution-"));
  env.dataDir = directory;
  const db = initDatabase(join(directory, "database.db"));
  db.exec(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  for (const id of ["user", "other"]) {
    db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').run(id, id, `${id}@example.com`);
    db.query("INSERT INTO characters (id, user_id, name, tags) VALUES (?, ?, ?, '[\"oldtag\"]')").run(`character-${id}`, id, id);
  }
  vectorCleanup = null;
  deletedChatVectors.length = 0;
});
afterEach(async () => {
  await stopDatabaseExecution();
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

describe("file-backed service execution", () => {
  test('gallery removal confirms its committed relationship before slow image cleanup without backend-thread SQL', async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, 'user', 'missing.png', 'missing.png')").run(imageId);
    const item = gallery.addToGallery('user', 'character-user', imageId);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const cleanup = spyOn(images, 'deleteImageIfUnreferencedAsync').mockImplementation(async () => { reached.resolve(); return release.promise; });
    const emit = spyOn(eventBus, 'emit');
    await startDatabaseExecution();
    const query = spyOn(db, 'query').mockImplementation(() => { throw new Error('SQL ran on the backend thread'); });
    const removal = gallery.removeFromGalleryAsync('user', 'character-user', item.id);
    try {
      await reached.promise;
      expect(query).not.toHaveBeenCalled();
      const events = emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_GALLERY_ITEM_REMOVED);
      expect(events).toHaveLength(1);
      expect(events[0][1]).toEqual({ id: item.id, characterId: 'character-user', imageId, status: 'completed' });
      expect(await gallery.getGalleryRemovalStatusAsync('user', 'character-user', item.id)).toMatchObject({ deleted: true });
      expect((await characters.getCharacterAsync('user', 'character-user'))?.extensions.risu_asset_map).toEqual({});
      expect(emit.mock.calls.filter(([type]) => type === EventType.IMAGE_DELETED)).toHaveLength(0);
    } finally {
      release.resolve(false);
      await removal;
      query.mockRestore(); cleanup.mockRestore(); emit.mockRestore();
    }
    expect(db.query('SELECT id FROM images WHERE id = ?').get(imageId)).not.toBeNull();
  });

  test('a failed alias update rolls back gallery removal and publishes no confirmation', async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, 'user', 'missing.png', 'missing.png')").run(imageId);
    const item = gallery.addToGallery('user', 'character-user', imageId);
    db.exec("CREATE TRIGGER reject_gallery_alias BEFORE UPDATE OF extensions ON characters BEGIN SELECT RAISE(ABORT, 'alias failed'); END");
    const emit = spyOn(eventBus, 'emit');
    try {
      // Await IPC before asserting; Bun's .rejects native wait can stall Windows.
      const error = await gallery.removeFromGalleryAsync('user', 'character-user', item.id).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: expect.stringContaining('alias failed'), code: 'SQLITE_CONSTRAINT_TRIGGER', outcome: 'rolled-back' });
      expect(await gallery.getGalleryRemovalStatusAsync('user', 'character-user', item.id)).toMatchObject({ deleted: false });
      expect((await characters.getCharacterAsync('user', 'character-user'))?.extensions.risu_asset_map[item.reference]).toBe(imageId);
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_GALLERY_ITEM_REMOVED)).toHaveLength(0);
    } finally { emit.mockRestore(); }
  });

  test('duplicate gallery entries keep aliases and shared images, with removal scoped to the owning character', async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, 'user', 'missing.png', 'missing.png')").run(imageId);
    const first = gallery.addToGallery('user', 'character-user', imageId);
    const second = gallery.addToGallery('user', 'character-user', imageId);
    expect(await gallery.removeFromGalleryAsync('user', 'character-other', first.id)).toBeNull();
    expect(await gallery.removeFromGalleryAsync('other', 'character-user', first.id)).toBeNull();
    await gallery.removeFromGalleryAsync('user', 'character-user', first.id);
    expect(await gallery.getGalleryRemovalStatusAsync('user', 'character-user', second.id)).toMatchObject({ deleted: false });
    expect((await characters.getCharacterAsync('user', 'character-user'))?.extensions.risu_asset_map[first.reference]).toBe(imageId);
    expect(db.query('SELECT id FROM images WHERE id = ?').get(imageId)).not.toBeNull();
    await gallery.removeFromGalleryAsync('user', 'character-user', second.id);
    expect(db.query('SELECT id FROM images WHERE id = ?').get(imageId)).toBeNull();
  });

  test("background deletion reports acceptance until cleanup and commit, and duplicate requests share completion", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanup = spyOn(images, "unlinkPaths").mockImplementation(async () => { reached.resolve(); await release.promise; });
    const emit = spyOn(eventBus, "emit");
    try {
      const first = await characters.requestCharacterDeletionAsync("user", "character-user", "operation-one");
      expect(first?.status).toBe("accepted");
      await reached.promise;
      expect((await characters.getDeletionOperationAsync("user", "operation-one"))?.status).toBe("accepted");
      expect(await characters.getDeletionOperationAsync("other", "operation-one")).toBeNull();
      expect((await characters.requestCharacterDeletionAsync("user", "character-user", "operation-one"))?.status).toBe("accepted");
      expect((await characters.requestCharacterDeletionAsync("user", "character-user", "operation-two"))?.status).toBe("accepted");
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_DELETED)).toHaveLength(0);
      release.resolve();
      await characters.deleteCharacterAsync("user", "character-user");
      expect((await characters.getDeletionOperationAsync("user", "operation-one"))?.status).toBe("completed");
      expect((await characters.getDeletionOperationAsync("user", "operation-two"))?.status).toBe("completed");
      expect((await characters.requestCharacterDeletionAsync("user", "character-user", "operation-one"))?.status).toBe("completed");
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_DELETED)).toHaveLength(1);
      expect(getDb().query("SELECT id FROM characters WHERE id = 'character-user'").get()).toBeNull();
    } finally {
      release.resolve();
      await characters.deleteCharacterAsync("user", "character-user").catch(() => {});
      cleanup.mockRestore(); emit.mockRestore();
    }
  });

  test("completion receipts roll back with the source deletion and a fresh request can resume failed cleanup", async () => {
    const db = getDb();
    db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES ('image', 'user', 'missing.png', 'missing.png')").run();
    db.query("UPDATE characters SET image_id = 'image' WHERE id = 'character-user'").run();
    db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON deletion_operations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
    const emit = spyOn(eventBus, "emit");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await characters.requestCharacterDeletionAsync("user", "character-user", "failed-operation");
      await characters.deleteCharacterAsync("user", "character-user").catch(() => {});
      expect((await characters.getDeletionOperationAsync("user", "failed-operation"))?.status).toBe("failed");
      expect(db.query("SELECT id FROM characters WHERE id = 'character-user'").get()).not.toBeNull();
      expect(db.query("SELECT id FROM images WHERE id = 'image'").get()).not.toBeNull();
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_DELETED || type === EventType.IMAGE_DELETED)).toHaveLength(0);
      db.exec("DROP TRIGGER reject_completion");
      expect((await characters.requestCharacterDeletionAsync("user", "character-user", "failed-operation"))?.status).toBe("failed");
      await characters.requestCharacterDeletionAsync("user", "character-user", "retry-operation");
      await characters.deleteCharacterAsync("user", "character-user");
      expect((await characters.getDeletionOperationAsync("user", "retry-operation"))?.status).toBe("completed");
      expect(emit.mock.calls.filter(([type]) => type === EventType.IMAGE_DELETED).map(([, payload]) => payload.id)).toEqual(["image"]);
    } finally { emit.mockRestore(); log.mockRestore(); }
  });

  test("avatar cleanup failure is persisted and startup recovery preserves the operation ID", async () => {
    getDb().query("UPDATE characters SET avatar_path = 'missing.png' WHERE id = 'character-user'").run();
    const deleteAvatar = files.deleteAvatar;
    const cleanup = spyOn(files, "deleteAvatar").mockRejectedValue(Object.assign(new Error("file busy"), { code: "EBUSY" }));
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await characters.requestCharacterDeletionAsync("user", "character-user", "restart-operation");
      await characters.deleteCharacterAsync("user", "character-user").catch(() => {});
      const failed = await characters.getDeletionOperationAsync("user", "restart-operation");
      expect(failed?.status).toBe("failed");
      expect(failed?.error?.code).toBe("EBUSY");
      cleanup.mockImplementation(deleteAvatar);
      await stopDatabaseExecution();
      await startDatabaseExecution();
      expect(await characters.resumePendingCharacterDeletions()).toBe(1);
      expect((await characters.getDeletionOperationAsync("user", "restart-operation"))?.status).toBe("completed");
    } finally { cleanup.mockRestore(); log.mockRestore(); }
  });

  test("status reconciles an uncertain acknowledgment from committed source state", async () => {
    const db = getDb();
    db.query("INSERT INTO deletion_operations (id, user_id, entity, entity_id, status, error, created_at, updated_at) VALUES ('uncertain', 'user', 'character', 'character-user', 'unknown', '{}', 1, 1)").run();
    expect((await characters.getDeletionOperationAsync("user", "uncertain"))?.status).toBe("unknown");
    await executeDatabaseOperation({ kind: "transaction", statements: [{ sql: "DELETE FROM characters WHERE id = 'character-user'" }] });
    const operation = await characters.getDeletionOperationAsync("user", "uncertain");
    expect(operation?.status).toBe("completed");
    expect(operation?.error).toBeUndefined();
  });

  test("shutdown rejects late operations until execution is restarted", async () => {
    await stopDatabaseExecution();
    const stopped = await executeDatabaseOperation<never>({ kind: "checkpoint" }).catch((error) => error);
    expect(stopped.code).toBe("DATABASE_CLOSED");
    await startDatabaseExecution();
    expect(getDb().query("PRAGMA wal_autocheckpoint").get()).toEqual({ wal_autocheckpoint: 0 });
    await executeDatabaseOperation({ kind: "checkpoint" });
    closeDatabase();
    const closed = await executeDatabaseOperation<never>({ kind: "checkpoint" }).catch((error) => error);
    expect(closed.code).toBe("DATABASE_CLOSED");
  });
  test("tag edits preserve ownership, concurrent additions, and FTS consistency", async () => {
    expect(await characters.bulkUpdateCharacterTagsAsync("user", { ids: ["character-user", "character-other"], operation: "remove", tags: ["oldtag"] })).toEqual({ updated: 1, unchanged: 0 });
    await Promise.all(["alpha", "bravo"].map((tag) => characters.bulkUpdateCharacterTagsAsync("user", { ids: ["character-user"], operation: "add", tags: [tag] })));
    expect(characters.getCharacter("user", "character-user")!.tags.sort()).toEqual(["alpha", "bravo"]);
    expect(characters.getCharacter("other", "character-other")!.tags).toEqual(["oldtag"]);
    expect(getDb().query("SELECT rowid FROM characters_fts WHERE characters_fts MATCH 'alpha'").all()).toHaveLength(1);
    expect(getDb().query("SELECT rowid FROM characters_fts WHERE characters_fts MATCH 'oldtag'").all()).toHaveLength(1);
  });

  test("single updates publish committed rows and keep validation errors identifiable", async () => {
    const emit = spyOn(eventBus, "emit");
    try {
      await characters.updateCharacterAsync("user", "character-user", { tags: [] });
      await characters.updateCharacterAsync("user", "character-user", {});
      const error = await characters.updateCharacterAsync("user", "character-user", { library_scope: "invalid" as any }).catch((error) => error);
      const events = emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED);
      expect(error.code).toBe("INVALID_CHARACTER_LIBRARY_SCOPE");
      expect(events).toHaveLength(1);
      expect(events[0][1].character.tags).toEqual([]);
      expect(characters.getCharacter("user", "character-user")!.tags).toEqual([]);
    } finally { emit.mockRestore(); }
  });

  test("folder edits preserve owner scoping across rename, move, and removal", async () => {
    getDb().query("UPDATE characters SET folder = 'Source'").run();
    const renamed = await characters.renameCharacterFolderAsync("user", "Source", "Target");
    expect(renamed.map((character) => character.id)).toEqual(["character-user"]);
    const moved = await characters.bulkUpdateCharacterFoldersAsync("user", ["character-user", "character-other", "character-user"], " Final ");
    expect(moved.map((character) => character.id)).toEqual(["character-user"]);
    await characters.deleteCharacterFolderAsync("user", "Final");
    expect(characters.getCharacter("user", "character-user")!.folder).toBe("");
    expect(characters.getCharacter("other", "character-other")!.folder).toBe("Source");
  });

  test("chat deletion removes messages and breakdowns and invokes external cleanup", async () => {
    const db = getDb();
    for (const user of ["user", "other"]) {
      db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run(`chat-${user}`, user);
      db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, content) VALUES (?, ?, 0, 0, 'hello')").run(`message-${user}`, `chat-${user}`);
      db.query("INSERT INTO message_breakdowns (message_id, chat_id, user_id, data) VALUES (?, ?, ?, '{}')").run(`message-${user}`, `chat-${user}`, user);
    }
    expect(await chats.deleteChatsAsync("user", ["chat-user", "chat-other", "chat-user", "missing"])).toEqual(["chat-user"]);
    expect(db.query("SELECT id FROM messages").all()).toEqual([{ id: "message-other" }]);
    expect(db.query("SELECT message_id FROM message_breakdowns").all()).toEqual([{ message_id: "message-other" }]);
    expect(deletedChatVectors).toEqual(["chat-user"]);
  });

  test("resumable character deletion explicitly cleans primary chats and owned regex scripts", async () => {
    const db = getDb();
    db.query("INSERT INTO chats (id, user_id, character_id) VALUES ('primary', 'user', 'character-user')").run();
    db.query("INSERT INTO regex_scripts (id, user_id, character_id, name, find_regex) VALUES ('script', 'user', 'character-user', 'Script', 'example')").run();
    const result = await characters.batchDeleteCharacters("user", ["character-user", "character-other"]);
    expect(result).toEqual({ deleted: ["character-user"], failed: ["character-other"] });
    expect(db.query("SELECT id FROM chats WHERE id = 'primary'").get()).toBeNull();
    expect(db.query("SELECT id FROM regex_scripts WHERE id = 'script'").get()).toBeNull();
    expect(deletedChatVectors).toEqual(["primary"]);
    expect(characters.getCharacter("other", "character-other")).not.toBeNull();
  });

  test("character cleanup and group removal perform no backend-thread SQL", async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("INSERT INTO images (id, user_id, filename, original_filename, mime_type, byte_size) VALUES (?, 'user', 'missing.png', 'missing.png', 'image/png', 1)").run(imageId);
    db.query("UPDATE characters SET extensions = ? WHERE id = 'character-user'").run(JSON.stringify({ gallery: [{ image_id: imageId }] }));
    for (const id of ["third", "fourth"]) db.query("INSERT INTO characters (id, user_id, name) VALUES (?, 'user', ?)").run(id, id);
    db.query("INSERT INTO chats (id, user_id, character_id, metadata) VALUES ('group', 'user', 'third', ?)").run(JSON.stringify({ group: true, character_ids: ["character-user", "third", "fourth"], group_active_avatar_ids: { "character-user": imageId } }));
    await startDatabaseExecution();
    const query = spyOn(db, "query").mockImplementation(() => { throw new Error("SQL ran on the backend thread"); });
    try {
      await characters.updateCharacterAsync("user", "character-user", { extensions: {} });
      expect(await characters.batchDeleteCharacters("user", ["character-user"])).toEqual({ deleted: ["character-user"], failed: [] });
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
    expect(db.query("SELECT id FROM images WHERE id = ?").get(imageId)).toBeNull();
    expect((await chats.getChatAsync("user", "group"))?.metadata.character_ids).toEqual(["third", "fourth"]);
  });

  test("persona deletion keeps owner scoping", async () => {
    getDb().query("INSERT INTO personas (id, user_id, name) VALUES ('persona', 'other', 'Persona')").run();
    expect(await personas.deletePersonaAsync("user", "persona")).toBe(false);
    expect(await personas.deletePersonaAsync("other", "persona")).toBe(true);
  });

  test("a failed avatar cleanup preserves the committed character result and event", async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("UPDATE characters SET extensions = ? WHERE id = 'character-user'").run(JSON.stringify({ gallery: [{ image_id: imageId }] }));
    db.query("INSERT INTO chats (id, user_id, metadata) VALUES ('chat', 'user', ?)").run(JSON.stringify({ active_avatar_id: imageId }));
    db.exec("CREATE TRIGGER reject_avatar_cleanup BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");
    const emit = spyOn(eventBus, "emit");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const updated = await characters.updateCharacterAsync("user", "character-user", { extensions: {} });
      expect(updated?.extensions.gallery).toBeUndefined();
      expect((await characters.getCharacterAsync("user", "character-user"))?.extensions).toEqual(updated?.extensions);
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHARACTER_EDITED)).toHaveLength(1);
      expect(emit.mock.calls.filter(([type]) => type === EventType.CHAT_CHANGED)).toHaveLength(0);
      expect((await chats.getChatAsync("user", "chat"))?.metadata.active_avatar_id).toBe(imageId);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      emit.mockRestore();
      log.mockRestore();
    }
  });

  test("chat attachment cleanup awaits asynchronous image and audio deletion", async () => {
    const db = getDb();
    const imageId = crypto.randomUUID();
    db.query("INSERT INTO images (id, user_id, filename, original_filename, mime_type, byte_size) VALUES (?, 'user', 'image.png', 'image.png', 'image/png', 1)").run(imageId);
    db.query("INSERT INTO audio_files (id, user_id, filename, original_filename, mime_type, size_bytes) VALUES ('audio', 'user', 'audio.wav', 'audio.wav', 'audio/wav', 1)").run();
    db.query("INSERT INTO chats (id, user_id) VALUES ('attachments', 'user')").run();
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, content, extra) VALUES ('message', 'attachments', 0, 0, '', ?)").run(JSON.stringify({ attachments: [{ type: "image", image_id: imageId }, { type: "audio", image_id: "audio" }] }));
    expect(await chats.deleteChatAsync("user", "attachments")).toBe(true);
    expect(db.query("SELECT id FROM images WHERE id = ?").get(imageId)).toBeNull();
    expect(db.query("SELECT id FROM audio_files WHERE id = 'audio'").get()).toBeNull();
  });

  test("a revision change during vector cleanup rolls back the whole bulk deletion", async () => {
    const db = getDb();
    db.query("INSERT INTO world_books (id, user_id, name) VALUES ('book', 'user', 'Book')").run();
    for (const id of ["first", "second"]) db.query("INSERT INTO world_book_entries (id, world_book_id, uid, revision) VALUES (?, 'book', ?, 1)").run(id, id === "first" ? 1 : 2);
    vectorCleanup = () => { db.query("UPDATE world_book_entries SET revision = 2 WHERE id = 'second'").run(); };
    const error = await worldBooks.bulkOperateEntries("user", "book", { action: "delete", entry_ids: ["first", "second"], expected_revisions: { first: 1, second: 1 } }).catch((error) => error);
    expect(error.code).toBe("WORLD_BOOK_ENTRY_CONFLICT");
    expect(db.query("SELECT id FROM world_book_entries ORDER BY id").all()).toEqual([{ id: "first" }, { id: "second" }]);
    vectorCleanup = null;
    expect(await worldBooks.bulkOperateEntries("user", "book", { action: "delete", entry_ids: ["first", "second"], expected_revisions: { first: 1, second: 2 } })).toEqual({ action: "delete", affected: 2 });
    expect(db.query("SELECT id FROM world_book_entries").all()).toEqual([]);
  });

  test("maintenance and checkpoints retain the subprocess mmap guard", async () => {
    const result = await executeDatabaseOperation<any>({ kind: "maintenance", options: { optimize: true, refreshTuning: true, checkpointMode: "PASSIVE" } });
    expect(result.statsAfter.mmapSize).toBe(0);
    expect(result.statsAfter.walAutocheckpoint).toBe(0);
    expect(result.optimized).toBe(true);
  });
});

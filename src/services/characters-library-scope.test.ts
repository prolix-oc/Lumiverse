import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  InvalidCharacterLibraryScopeError,
  bulkUpdateCharacterFolders,
  bulkUpdateCharacterTags,
  createCharacter,
  deleteCharacter,
  deleteCharacterFolder,
  duplicateCharacter,
  findCharacterBySourceFilename,
  getCharacter,
  getCharacterPreview,
  getCharactersByIds,
  listCharacterSummaries,
  listCharacterTags,
  listCharacters,
  normalizeCharacterLibraryScope,
  renameCharacterFolder,
  setCharacterSourceFilename,
  updateCharacter,
} from "./characters.service";
import type { SummaryQueryOptions } from "./characters.service";

const USER_A = "character-library-scope-user-a";
const USER_B = "character-library-scope-user-b";

async function initDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");

  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());

}

function summaryIds(userId: string, scope: "mine" | "shared", options: Omit<SummaryQueryOptions, "scope"> = {}): string[] {
  return listCharacterSummaries(userId, { limit: 100, offset: 0 }, { scope, ...options }).data.map((character) => character.id);
}

function discoverIds(userId: string, scope: "mine" | "shared"): string[] {
  return listCharacterSummaries(userId, { limit: 100, offset: 0 }, { scope, sort: "discover", seed: 37 }).data.map(
    (character) => character.id,
  );
}

function insertChat(
  id: string,
  userId: string,
  characterId: string,
  name: string,
  updatedAt: number,
  metadata = "{}",
): void {
  getDb()
    .query(
      "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, userId, characterId, name, metadata, updatedAt, updatedAt);
}

function insertMessage(id: string, chatId: string, index: number, content: string): void {
  getDb().query("INSERT INTO messages (id, chat_id, index_in_chat, content) VALUES (?, ?, ?, ?)").run(id, chatId, index, content);
}

beforeEach(initDb);
afterEach(() => closeDatabase());

describe("character library scope", () => {
  test("creates, reads, lists, and summarizes mine and shared characters without crossing tenants", () => {
    const mine = createCharacter(USER_A, {
      name: "Mine",
      folder: "Mine Folder",
      tags: ["mine-tag", "partition"],
    });
    const shared = createCharacter(USER_A, {
      name: "Shared",
      library_scope: "shared",
      folder: "Shared Folder",
      tags: ["shared-tag", "partition"],
    });
    const foreignMine = createCharacter(USER_B, { name: "Foreign Mine", tags: ["foreign-tag"] });
    const foreignShared = createCharacter(USER_B, {
      name: "Foreign Shared",
      library_scope: "shared",
      tags: ["foreign-shared-tag"],
    });

    expect(mine.library_scope).toBe("mine");
    expect(shared.library_scope).toBe("shared");
    expect(getCharacter(USER_A, mine.id)?.library_scope).toBe("mine");
    expect(getCharacter(USER_A, shared.id)?.library_scope).toBe("shared");
    expect(getCharacter(USER_A, foreignMine.id)).toBeNull();
    const ownerById = getCharactersByIds(USER_A, [mine.id, shared.id, foreignMine.id, foreignShared.id]);
    expect([...ownerById.keys()].sort()).toEqual([mine.id, shared.id].sort());
    expect(ownerById.get(mine.id)).toEqual(expect.objectContaining({ id: mine.id, library_scope: "mine" }));
    expect(ownerById.get(shared.id)).toEqual(expect.objectContaining({ id: shared.id, library_scope: "shared" }));

    const ownerList = listCharacters(USER_A, { limit: 100, offset: 0 });
    expect(new Set(ownerList.data.map((character) => character.id))).toEqual(new Set([mine.id, shared.id]));
    expect(ownerList.total).toBe(2);
    expect(listCharacters(USER_B, { limit: 100, offset: 0 }).data.map((character) => character.id).sort()).toEqual(
      [foreignMine.id, foreignShared.id].sort(),
    );

    const mineSummary = listCharacterSummaries(USER_A, { limit: 100, offset: 0 }, { scope: "mine" });
    const sharedSummary = listCharacterSummaries(USER_A, { limit: 100, offset: 0 }, { scope: "shared" });
    expect(mineSummary.data).toEqual([
      expect.objectContaining({
        id: mine.id,
        name: "Mine",
        folder: "Mine Folder",
        tags: ["mine-tag", "partition"],
        library_scope: "mine",
      }),
    ]);
    expect(sharedSummary.data).toEqual([
      expect.objectContaining({
        id: shared.id,
        name: "Shared",
        folder: "Shared Folder",
        tags: ["shared-tag", "partition"],
        library_scope: "shared",
      }),
    ]);
    expect(summaryIds(USER_A, "mine")).not.toContain(shared.id);
    expect(summaryIds(USER_A, "shared")).not.toContain(mine.id);
    expect(summaryIds(USER_A, "mine")).not.toContain(foreignMine.id);
    expect(summaryIds(USER_B, "shared")).toEqual([foreignShared.id]);

    expect(discoverIds(USER_A, "mine")).toEqual([mine.id]);
    expect(discoverIds(USER_A, "shared")).toEqual([shared.id]);
    expect(discoverIds(USER_A, "mine")).not.toContain(shared.id);
    expect(discoverIds(USER_A, "shared")).not.toContain(mine.id);
  });

  test("uses only summary and discover scope filters while owner operations span both partitions", () => {
    const mine = createCharacter(USER_A, { name: "Mine", folder: "Drafts", tags: ["common", "mine-only"] });
    const shared = createCharacter(USER_A, {
      name: "Shared",
      library_scope: "shared",
      folder: "Drafts",
      tags: ["common", "shared-only"],
    });
    const foreign = createCharacter(USER_B, { name: "Foreign", folder: "Drafts", tags: ["common"] });

    expect(Object.fromEntries(listCharacterTags(USER_A).map(({ tag, count }) => [tag, count]))).toEqual({
      common: 2,
      "mine-only": 1,
      "shared-only": 1,
    });

    const tagResult = bulkUpdateCharacterTags(USER_A, {
      ids: [mine.id, shared.id, foreign.id, mine.id],
      operation: "add",
      tags: ["owner-update"],
    });
    expect(tagResult).toEqual({ updated: 2, unchanged: 0 });
    expect(getCharacter(USER_A, mine.id)?.tags).toContain("owner-update");
    expect(getCharacter(USER_A, shared.id)?.tags).toContain("owner-update");
    expect(getCharacter(USER_B, foreign.id)?.tags).not.toContain("owner-update");

    const renamed = renameCharacterFolder(USER_A, "Drafts", "Published");
    expect(renamed.map((character) => character.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(getCharacter(USER_A, mine.id)?.folder).toBe("Published");
    expect(getCharacter(USER_A, shared.id)?.folder).toBe("Published");
    expect(getCharacter(USER_B, foreign.id)?.folder).toBe("Drafts");

    const bulkMoved = bulkUpdateCharacterFolders(USER_A, [mine.id, shared.id, foreign.id, mine.id], " Bulk ");
    expect(bulkMoved.map((character) => character.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(getCharacter(USER_A, mine.id)?.folder).toBe("Bulk");
    expect(getCharacter(USER_A, shared.id)?.folder).toBe("Bulk");
    expect(getCharacter(USER_B, foreign.id)?.folder).toBe("Drafts");

    const deletedFolder = deleteCharacterFolder(USER_A, "Bulk");
    expect(deletedFolder.map((character) => character.id).sort()).toEqual([mine.id, shared.id].sort());
    expect(getCharacter(USER_A, mine.id)?.folder).toBe("");
    expect(getCharacter(USER_A, shared.id)?.folder).toBe("");
    expect(getCharacter(USER_B, foreign.id)?.folder).toBe("Drafts");

    expect(summaryIds(USER_A, "mine", { tags: ["shared-only"] })).toEqual([]);
    expect(summaryIds(USER_A, "shared", { tags: ["shared-only"] })).toEqual([shared.id]);
    expect(summaryIds(USER_A, "mine", { tags: ["owner-update"] })).toEqual([mine.id]);
    expect(summaryIds(USER_A, "shared", { tags: ["owner-update"] })).toEqual([shared.id]);
  });

  test("normalizes the persisted scope mirror on create and update", () => {
    const omitted = createCharacter(USER_A, { name: "Omitted" });
    const direct = createCharacter(USER_A, {
      name: "Direct",
      library_scope: "shared",
      extensions: { marker: "direct" },
    });
    const mirror = createCharacter(USER_A, {
      name: "Mirror",
      extensions: { marker: "mirror", _lumiverse_library_scope: "shared" },
    });
    const both = createCharacter(USER_A, {
      name: "Both",
      library_scope: "mine",
      extensions: { marker: "both", _lumiverse_library_scope: "mine" },
    });

    expect(omitted.library_scope).toBe("mine");
    expect(omitted.extensions._lumiverse_library_scope).toBe("mine");
    expect(direct.library_scope).toBe("shared");
    expect(direct.extensions).toEqual({ marker: "direct", _lumiverse_library_scope: "shared" });
    expect(mirror.library_scope).toBe("shared");
    expect(mirror.extensions).toEqual({ marker: "mirror", _lumiverse_library_scope: "shared" });
    expect(both.library_scope).toBe("mine");
    expect(both.extensions._lumiverse_library_scope).toBe("mine");

    const moved = updateCharacter(USER_A, omitted.id, { library_scope: "shared" });
    expect(moved).toEqual(expect.objectContaining({ id: omitted.id, library_scope: "shared" }));
    expect(moved?.extensions._lumiverse_library_scope).toBe("shared");
    expect(summaryIds(USER_A, "mine")).not.toContain(omitted.id);
    expect(summaryIds(USER_A, "shared")).toContain(omitted.id);

    const movedBack = updateCharacter(USER_A, omitted.id, {
      library_scope: "mine",
      extensions: { retained: true },
    });
    expect(movedBack?.library_scope).toBe("mine");
    expect(movedBack?.extensions).toEqual({ retained: true, _lumiverse_library_scope: "mine" });
    expect(summaryIds(USER_A, "mine")).toContain(omitted.id);
    expect(summaryIds(USER_A, "shared")).not.toContain(omitted.id);
  });

  test("rejects malformed or conflicting scope values before persisting", () => {
    const existing = createCharacter(USER_A, { name: "Existing" });

    expect(normalizeCharacterLibraryScope(undefined)).toBe("mine");
    expect(normalizeCharacterLibraryScope("mine")).toBe("mine");
    expect(normalizeCharacterLibraryScope("shared")).toBe("shared");
    for (const value of [null, "", "MINE", "public", 1, {}, []]) {
      expect(() => normalizeCharacterLibraryScope(value)).toThrow(InvalidCharacterLibraryScopeError);
      expect(() => createCharacter(USER_A, { name: `bad-${String(value)}`, library_scope: value as unknown as "mine" | "shared" })).toThrow(
        InvalidCharacterLibraryScopeError,
      );
      expect(() => createCharacter(USER_A, { name: `bad-mirror-${String(value)}`, extensions: { _lumiverse_library_scope: value } })).toThrow(
        InvalidCharacterLibraryScopeError,
      );
    }

    expect(() =>
      createCharacter(USER_A, {
        name: "conflict",
        library_scope: "mine",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    ).toThrow(InvalidCharacterLibraryScopeError);
    expect(() => updateCharacter(USER_A, existing.id, { library_scope: "elsewhere" as unknown as "mine" | "shared" })).toThrow(
      InvalidCharacterLibraryScopeError,
    );
    expect(() => updateCharacter(USER_A, existing.id, { extensions: { _lumiverse_library_scope: "elsewhere" } })).toThrow(
      InvalidCharacterLibraryScopeError,
    );
    expect(() =>
      updateCharacter(USER_A, existing.id, {
        library_scope: "mine",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    ).toThrow(InvalidCharacterLibraryScopeError);
    expect(() => listCharacterSummaries(USER_A, { limit: 10, offset: 0 }, { scope: "all" as unknown as "mine" | "shared" })).toThrow(
      InvalidCharacterLibraryScopeError,
    );

    expect(getCharacter(USER_A, existing.id)?.library_scope).toBe("mine");
    expect(getCharacter(USER_A, existing.id)?.extensions._lumiverse_library_scope).toBe("mine");
  });

  test("moving a shared character keeps native reads, updates, source lookup, and deletion owner-safe", async () => {
    const shared = createCharacter(USER_A, {
      name: "Movable Shared",
      library_scope: "shared",
      extensions: { marker: "before" },
    });

    expect(getCharacter(USER_A, shared.id)).toEqual(expect.objectContaining({ id: shared.id, library_scope: "shared" }));
    const moved = updateCharacter(USER_A, shared.id, {
      library_scope: "mine",
      name: "Moved Mine",
      extensions: { marker: "after" },
    });
    expect(moved).toEqual(expect.objectContaining({ id: shared.id, name: "Moved Mine", library_scope: "mine" }));
    expect(moved?.extensions).toEqual({ marker: "after", _lumiverse_library_scope: "mine" });

    setCharacterSourceFilename(USER_A, shared.id, "moved.json");
    expect(findCharacterBySourceFilename(USER_A, "moved.json")?.id).toBe(shared.id);
    expect(findCharacterBySourceFilename(USER_B, "moved.json")).toBeNull();
    expect(getCharacter(USER_A, shared.id)?.library_scope).toBe("mine");

    expect(deleteCharacter(USER_B, shared.id)).toBe(false);
    expect(deleteCharacter(USER_A, shared.id)).toBe(true);
    expect(summaryIds(USER_A, "mine")).not.toContain(shared.id);
    await Bun.sleep(10);
    expect(getCharacter(USER_A, shared.id)).toBeNull();
  });

  test("duplicates and deletes preserve the source scope without leaking across tenants", async () => {
    const source = createCharacter(USER_A, {
      name: "Shared Source",
      library_scope: "shared",
      folder: "Copies",
      tags: ["source"],
      extensions: { marker: "source", _lumiverse_library_scope: "shared" },
    });

    const duplicate = duplicateCharacter(USER_A, source.id);
    expect(duplicate).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: "Shared Source (Copy)",
        folder: "Copies",
        tags: ["source"],
        library_scope: "shared",
      }),
    );
    expect(duplicate?.extensions).toEqual({ marker: "source", _lumiverse_library_scope: "shared" });
    expect(summaryIds(USER_A, "shared")).toEqual(expect.arrayContaining([source.id, duplicate!.id]));
    expect(duplicateCharacter(USER_B, source.id)).toBeNull();

    expect(deleteCharacter(USER_A, duplicate!.id)).toBe(true);
    expect(summaryIds(USER_A, "shared")).toEqual([source.id]);
    expect(summaryIds(USER_B, "shared")).toEqual([]);
    await Bun.sleep(10);
    expect(getCharacter(USER_A, duplicate!.id)).toBeNull();
    expect(getCharacter(USER_A, source.id)?.library_scope).toBe("shared");
  });

  test("filters summaries by a tenant-owned chat and its direct or group participants", () => {
    const direct = createCharacter(USER_A, { name: "Direct Chat", tags: ["chat"] });
    const participant = createCharacter(USER_A, { name: "Participant", tags: ["chat"] });
    const sharedParticipant = createCharacter(USER_A, {
      name: "Shared Participant",
      library_scope: "shared",
      tags: ["chat"],
    });
    const absent = createCharacter(USER_A, { name: "Absent", tags: ["chat"] });
    const foreign = createCharacter(USER_B, { name: "Foreign", tags: ["chat"] });

    insertChat(
      "chat-participants",
      USER_A,
      direct.id,
      "Participants",
      20,
      JSON.stringify({ character_ids: [participant.id, sharedParticipant.id] }),
    );
    insertChat("chat-foreign", USER_B, foreign.id, "Foreign", 30, JSON.stringify({ character_ids: [direct.id] }));

    expect(summaryIds(USER_A, "mine", { chatId: "chat-participants" }).sort()).toEqual([direct.id, participant.id].sort());
    expect(summaryIds(USER_A, "shared", { chatId: "chat-participants" })).toEqual([sharedParticipant.id]);
    expect(summaryIds(USER_A, "mine", { chatId: "chat-foreign" })).toEqual([]);
    expect(summaryIds(USER_A, "shared", { chatId: "chat-foreign" })).toEqual([]);
    expect(summaryIds(USER_A, "mine", { chatId: "chat-participants", tags: ["chat"] })).not.toContain(absent.id);
    expect(summaryIds(USER_A, "mine")).toContain(absent.id);
  });

  test("projects an owner-safe CharacterPreview with scope, lorebooks, and the latest chat", () => {
    const character = createCharacter(USER_A, {
      name: "Preview Character",
      personality: "Imported personality fallback",
      creator: "Creator",
      library_scope: "shared",
      tags: ["preview"],
      alternate_greetings: ["Hello"],
      extensions: { world_book_ids: ["book-a", "book-b", "missing-book"] },
    });
    const canonicalDescriptionCharacter = createCharacter(USER_A, {
      name: "Canonical Description",
      description: "Canonical description wins",
      personality: "Personality fallback must not replace it",
    });
    const foreignCharacter = createCharacter(USER_B, { name: "Foreign Preview" });

    const summaries = listCharacterSummaries(USER_A, { limit: 100, offset: 0 }, {}).data;
    expect(summaries.find((item) => item.id === character.id)?.preview_description).toBe("Imported personality fallback");
    expect(summaries.find((item) => item.id === canonicalDescriptionCharacter.id)?.preview_description).toBe("Canonical description wins");

    getDb()
      .query(
        "INSERT INTO world_books (id, user_id, name, description, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '{}', ?, ?)",
      )
      .run("book-a", USER_A, "A Lorebook", 1, 2);
    getDb()
      .query(
        "INSERT INTO world_books (id, user_id, name, description, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '{}', ?, ?)",
      )
      .run("book-b", USER_B, "Foreign Lorebook", 1, 2);

    insertChat("preview-old", USER_A, character.id, "Old Chat", 10);
    insertChat("preview-latest", USER_A, character.id, "Latest Chat", 30);
    insertChat("preview-empty", USER_A, character.id, "Empty Chat", 40);
    insertChat("preview-group", USER_A, character.id, "Group Chat", 50, JSON.stringify({ group: true }));
    insertChat("preview-foreign", USER_B, foreignCharacter.id, "Foreign Chat", 60);
    insertMessage("preview-old-message", "preview-old", 0, "old reply");
    insertMessage("preview-latest-message", "preview-latest", 0, "latest reply");
    insertMessage("preview-group-message", "preview-group", 0, "must be ignored");
    insertMessage("preview-foreign-message", "preview-foreign", 0, "must be private");

    const preview = getCharacterPreview(USER_A, character.id);
    expect(preview).not.toBeNull();
    expect(Object.keys(preview!.character).sort()).toEqual(
      [
        "created_at",
        "creator",
        "description",
        "folder",
        "has_alternate_greetings",
        "id",
        "image_id",
        "library_scope",
        "name",
        "preview_description",
        "tags",
        "updated_at",
      ].sort(),
    );
    expect(preview!.character).toEqual({
      id: character.id,
      name: "Preview Character",
      description: "",
      preview_description: "Imported personality fallback",
      creator: "Creator",
      folder: "",
      tags: ["preview"],
      image_id: null,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
      has_alternate_greetings: true,
      library_scope: "shared",
    });
    expect(preview!.lorebooks).toEqual([{ id: "book-a", name: "A Lorebook" }]);
    expect(preview!.last_chat).toEqual({
      id: "preview-latest",
      name: "Latest Chat",
      updated_at: 30,
      last_message_preview: "latest reply",
    });
    expect(preview!.open_chat_id).toBe("preview-latest");
    expect(getCharacterPreview(USER_B, character.id)).toBeNull();
  });
});

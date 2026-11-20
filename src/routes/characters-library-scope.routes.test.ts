import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { charactersRoutes } from "./characters.routes";

const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const MINE_ID = "character-mine";
const SHARED_ID = "character-shared";
const SHARED_UNLISTED_ID = "character-shared-unlisted";
const OTHER_ID = "character-other-user";
const PREVIEW_CHAT_ID = "chat-preview";
const SHARED_CHAT_ID = "chat-shared";
const MINE_BOOK_ID = "world-book-mine";

function initCharactersScopeTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    library_scope TEXT NOT NULL DEFAULT 'mine' CHECK(library_scope IN ('mine', 'shared')),
    avatar_path TEXT,
    image_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleting INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    character_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL
  )`);
  getDb().run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    send_date INTEGER NOT NULL DEFAULT 0,
    swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]',
    extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT,
    branch_id TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    swipe_dates TEXT NOT NULL DEFAULT '[]'
  )`);
  getDb().run(`CREATE TABLE world_books (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT ''
  )`);
}

function insertCharacter(
  id: string,
  userId: string,
  name: string,
  libraryScope: "mine" | "shared",
  tags: string[],
  folder: string,
  extensions: Record<string, unknown>,
  createdAt: number,
  updatedAt: number,
): void {
  getDb().query(`INSERT INTO characters (
    id, user_id, name, library_scope, folder, tags, extensions, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    userId,
    name,
    libraryScope,
    folder,
    JSON.stringify(tags),
    JSON.stringify(extensions),
    createdAt,
    updatedAt,
  );
}

function seedCharacters(): void {
  insertCharacter(
    MINE_ID,
    USER_ID,
    "Mine Character",
    "mine",
    ["mine-tag", "common"],
    "Shelf",
    { _lumiverse_library_scope: "mine", world_book_ids: [MINE_BOOK_ID] },
    1,
    10,
  );
  insertCharacter(
    SHARED_ID,
    USER_ID,
    "Shared Character",
    "shared",
    ["shared-tag", "common"],
    "Shelf",
    { _lumiverse_library_scope: "shared" },
    2,
    20,
  );
  insertCharacter(
    SHARED_UNLISTED_ID,
    USER_ID,
    "Shared Without Chat",
    "shared",
    ["shared-only"],
    "Other Shelf",
    { _lumiverse_library_scope: "shared" },
    3,
    30,
  );
  insertCharacter(
    OTHER_ID,
    OTHER_USER_ID,
    "Other User Character",
    "shared",
    ["private-tag"],
    "Shelf",
    { _lumiverse_library_scope: "shared" },
    4,
    40,
  );

  getDb().query(`INSERT INTO world_books
    (id, name, description, metadata, created_at, updated_at, user_id, folder)
    VALUES (?, ?, '', '{}', 1, 1, ?, '')`).run(MINE_BOOK_ID, "Mine Lorebook", USER_ID);

  getDb().query(`INSERT INTO chats
    (id, character_id, name, metadata, created_at, updated_at, user_id)
    VALUES (?, ?, ?, '{}', ?, ?, ?)`).run(
    PREVIEW_CHAT_ID,
    MINE_ID,
    "Preview Chat",
    30,
    40,
    USER_ID,
  );
  getDb().query(`INSERT INTO chats
    (id, character_id, name, metadata, created_at, updated_at, user_id)
    VALUES (?, ?, ?, '{}', ?, ?, ?)`).run(
    SHARED_CHAT_ID,
    SHARED_ID,
    "Shared Chat",
    31,
    41,
    USER_ID,
  );
  getDb().query(`INSERT INTO messages
    (id, chat_id, index_in_chat, is_user, name, content, send_date, created_at)
    VALUES (?, ?, 0, 0, '', ?, 40, 40)`).run(
    "message-preview",
    PREVIEW_CHAT_ID,
    "Preview message",
  );
}

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("userId", USER_ID);
  await next();
});
app.route("/", charactersRoutes);
type LibraryScope = "mine" | "shared";
type SummaryRow = { id: string; name: string; description: string; library_scope: LibraryScope };
type SummaryResponse = { total: number; data: SummaryRow[] };
type TagRow = { tag: string; count: number };
type CharacterPayload = {
  id: string;
  name: string;
  library_scope: LibraryScope;
  extensions: Record<string, unknown>;
};
type CharacterResponse = CharacterPayload & { character?: CharacterPayload };
type StoredCharacter = { name: string; tags: string; folder: string };
type PreviewResponse = {
  character: Record<string, unknown>;
  lorebooks: Array<Record<string, unknown>>;
  last_chat: Record<string, unknown> | null;
  open_chat_id: string | null;
};

async function bodyOf<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function characterFrom(response: Response): Promise<CharacterPayload> {
  const body = await bodyOf<CharacterResponse>(response);
  return body.character ?? body;
}

function storedCharacter(id: string): StoredCharacter {
  const row: unknown = getDb().query("SELECT * FROM characters WHERE id = ?").get(id);
  if (!row || typeof row !== "object") throw new Error(`Missing stored character ${id}`);
  const record = row as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.tags !== "string" || typeof record.folder !== "string") {
    throw new Error(`Malformed stored character ${id}`);
  }
  return { name: record.name, tags: record.tags, folder: record.folder };
}

beforeEach(async () => {
  initCharactersScopeTestDb();
  getDb().run(await Bun.file(new URL('../db/migrations/125_deletion_operations.sql', import.meta.url)).text());
  seedCharacters();
});

afterEach(() => closeDatabase());

describe("character summary scope filtering", () => {
  test("omitted scope returns every owner row while explicit scope partitions summaries", async () => {
    const allResponse = await app.request("/summary");
    expect(allResponse.status).toBe(200);
    const all = await bodyOf<SummaryResponse>(allResponse);
    expect(all.total).toBe(3);
    expect(all.data.map((item) => item.id).sort()).toEqual(
      [MINE_ID, SHARED_ID, SHARED_UNLISTED_ID].sort(),
    );
    expect(Object.keys(all.data.find((item) => item.id === MINE_ID) ?? {}).sort()).toEqual([
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
    ]);
    expect(all.data.find((item) => item.id === MINE_ID)?.description).toBe("");
    expect(all.data.every((item) => item.library_scope === "mine" || item.library_scope === "shared")).toBe(true);
    expect(all.data.some((item) => item.id === OTHER_ID)).toBe(false);

    const mineResponse = await app.request("/summary?scope=mine");
    expect(mineResponse.status).toBe(200);
    const mine = await bodyOf<SummaryResponse>(mineResponse);
    expect(mine.data.map((item) => item.id)).toEqual([MINE_ID]);
    expect(mine.data[0].library_scope).toBe("mine");

    const sharedResponse = await app.request("/summary?scope=shared");
    expect(sharedResponse.status).toBe(200);
    const shared = await bodyOf<SummaryResponse>(sharedResponse);
    expect(shared.data.map((item) => item.id).sort()).toEqual(
      [SHARED_ID, SHARED_UNLISTED_ID].sort(),
    );
    expect(shared.data.every((item) => item.library_scope === "shared")).toBe(true);
  });

  test("threads chat_id through the summary query and rejects malformed scope strictly", async () => {
    const response = await app.request(`/summary?scope=shared&chat_id=${SHARED_CHAT_ID}`);
    expect(response.status).toBe(200);
    const body = await bodyOf<SummaryResponse>(response);
    expect(body.data.map((item) => item.id)).toEqual([SHARED_ID]);
    expect(body.data[0].library_scope).toBe("shared");

    const malformed = await app.request("/summary?scope=public");
    expect(malformed.status).toBe(400);
    expect(await bodyOf<{ error: string }>(malformed)).toEqual({
      error: "scope must be either 'mine' or 'shared'",
    });
  });
});

describe("owner-only character collections", () => {
  test("lists all owned scopes and tags without exposing another user's rows", async () => {
    const listResponse = await app.request("/");
    expect(listResponse.status).toBe(200);
    const list = await bodyOf<SummaryResponse>(listResponse);
    expect(list.data.map((item) => item.id).sort()).toEqual(
      [MINE_ID, SHARED_ID, SHARED_UNLISTED_ID].sort(),
    );
    expect(list.data.some((item) => item.id === OTHER_ID)).toBe(false);

    const tagsResponse = await app.request("/tags");
    expect(tagsResponse.status).toBe(200);
    const tags = Object.fromEntries((await bodyOf<TagRow[]>(tagsResponse)).map((item) => [item.tag, item.count]));
    expect(tags).toEqual({
      common: 2,
      "mine-tag": 1,
      "shared-tag": 1,
      "shared-only": 1,
    });
    expect(tags["private-tag"]).toBeUndefined();
  });

  test("bulk tags, folders, and folder updates operate on owned rows across scopes", async () => {
    const bulkTagsResponse = await app.request("/bulk-tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [MINE_ID, SHARED_ID, OTHER_ID], operation: "add", tags: ["batch"] }),
    });
    expect(bulkTagsResponse.status).toBe(200);
    expect(JSON.parse(storedCharacter(MINE_ID).tags)).toContain("batch");
    expect(JSON.parse(storedCharacter(SHARED_ID).tags)).toContain("batch");
    expect(JSON.parse(storedCharacter(OTHER_ID).tags)).not.toContain("batch");

    const renameResponse = await app.request("/folders/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ old_name: "Shelf", new_name: "Renamed Shelf" }),
    });
    expect(renameResponse.status).toBe(200);
    expect(storedCharacter(MINE_ID).folder).toBe("Renamed Shelf");
    expect(storedCharacter(SHARED_ID).folder).toBe("Renamed Shelf");
    expect(storedCharacter(OTHER_ID).folder).toBe("Shelf");

    const bulkUpdateResponse = await app.request("/bulk-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [MINE_ID, SHARED_ID, OTHER_ID], folder: "Bulk Shelf" }),
    });
    expect(bulkUpdateResponse.status).toBe(200);
    expect(storedCharacter(MINE_ID).folder).toBe("Bulk Shelf");
    expect(storedCharacter(SHARED_ID).folder).toBe("Bulk Shelf");
    expect(storedCharacter(OTHER_ID).folder).toBe("Shelf");
  });
});

describe("character CRUD scope classification", () => {
  test("creates with optional mine default or shared library_scope and mirrors the persisted scope", async () => {
    const defaultResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Default Scope Character" }),
    });
    expect(defaultResponse.status).toBe(201);
    const defaultCharacter = await characterFrom(defaultResponse);
    expect(defaultCharacter.library_scope).toBe("mine");
    expect(defaultCharacter.extensions._lumiverse_library_scope).toBe("mine");

    const sharedResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shared Scope Character",
        library_scope: "shared",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    });
    expect(sharedResponse.status).toBe(201);
    const sharedCharacter = await characterFrom(sharedResponse);
    expect(sharedCharacter.library_scope).toBe("shared");
    expect(sharedCharacter.extensions._lumiverse_library_scope).toBe("shared");

    const malformedResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Malformed Scope Character", library_scope: "public" }),
    });
    expect(malformedResponse.status).toBe(400);
    expect(storedCharacter(MINE_ID).name).toBe("Mine Character");
    const names = (await bodyOf<SummaryResponse>(await app.request("/summary"))).data.map((item) => item.name);
    expect(names).not.toContain("Malformed Scope Character");
  });

  test("updates an owned character by moving its library_scope and rejects a mismatched mirror", async () => {
    const movedResponse = await app.request(`/${MINE_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Moved Character",
        library_scope: "shared",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    });
    expect(movedResponse.status).toBe(200);
    const moved = await characterFrom(movedResponse);
    expect(moved.name).toBe("Moved Character");
    expect(moved.library_scope).toBe("shared");
    expect(moved.extensions._lumiverse_library_scope).toBe("shared");

    const mismatchResponse = await app.request(`/${SHARED_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Must Not Move",
        library_scope: "mine",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    });
    expect(mismatchResponse.status).toBe(400);
    const unchanged = await characterFrom(await app.request(`/${SHARED_ID}`));
    expect(unchanged.name).toBe("Shared Character");
    expect(unchanged.library_scope).toBe("shared");

    expect((await app.request(`/${OTHER_ID}`)).status).toBe(404);
    expect((await app.request(`/${OTHER_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No Access" }),
    })).status).toBe(404);
    expect((await app.request(`/${OTHER_ID}`, { method: "DELETE" })).status).toBe(404);
  });

  test("duplicate preserves the source library_scope and enforces owner isolation", async () => {
    const duplicateResponse = await app.request(`/${SHARED_ID}/duplicate`, { method: "POST" });
    expect(duplicateResponse.status).toBe(201);
    const duplicate = await characterFrom(duplicateResponse);
    expect(duplicate.id).not.toBe(SHARED_ID);
    expect(duplicate.library_scope).toBe("shared");
    expect(duplicate.extensions._lumiverse_library_scope).toBe("shared");

    const inaccessible = await app.request(`/${OTHER_ID}/duplicate`, { method: "POST" });
    expect(inaccessible.status).toBe(404);
  });
});

describe("character imports", () => {
  test("classifies raw JSON imports from body library_scope and mirrors it", async () => {
    const response = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Body Imported Character",
        library_scope: "shared",
        extensions: { _lumiverse_library_scope: "shared" },
      }),
    });
    expect(response.status).toBe(201);
    const imported = await characterFrom(response);
    expect(imported.name).toBe("Body Imported Character");
    expect(imported.library_scope).toBe("shared");
    expect(imported.extensions._lumiverse_library_scope).toBe("shared");

    const malformed = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad Body Import", library_scope: "public" }),
    });
    expect(malformed.status).toBe(400);
    const names = (await bodyOf<SummaryResponse>(await app.request("/summary"))).data.map((item) => item.name);
    expect(names).not.toContain("Bad Body Import");
  });

  test("classifies multipart imports from the library_scope form field", async () => {
    const form = new FormData();
    form.append("library_scope", "shared");
    form.append(
      "file",
      new File(
        [JSON.stringify({
          name: "Form Imported Character",
          extensions: { _lumiverse_library_scope: "shared" },
        })],
        "form-card.json",
        { type: "application/json" },
      ),
    );

    const response = await app.request("/import", { method: "POST", body: form });
    expect(response.status).toBe(201);
    const imported = await characterFrom(response);
    expect(imported.name).toBe("Form Imported Character");
    expect(imported.library_scope).toBe("shared");
    expect(imported.extensions._lumiverse_library_scope).toBe("shared");

    const invalidForm = new FormData();
    invalidForm.append("library_scope", "public");
    invalidForm.append(
      "file",
      new File([JSON.stringify({ name: "Bad Form Import" })], "bad-card.json", { type: "application/json" }),
    );
    const malformed = await app.request("/import", { method: "POST", body: invalidForm });
    expect(malformed.status).toBe(400);
    const names = (await bodyOf<SummaryResponse>(await app.request("/summary"))).data.map((item) => item.name);
    expect(names).not.toContain("Bad Form Import");
  });
});

describe("homepage character preview", () => {
  test("serves the sole nested preview shape for an owned character", async () => {
    const response = await app.request(`/${MINE_ID}/homepage-preview`);
    expect(response.status).toBe(200);
    const preview = await bodyOf<PreviewResponse>(response);

    expect(Object.keys(preview).sort()).toEqual(["character", "last_chat", "lorebooks", "open_chat_id"]);
    expect(Object.keys(preview.character).sort()).toEqual([
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
    ]);
    expect(preview.character).toEqual({
      id: MINE_ID,
      library_scope: "mine",
      name: "Mine Character",
      description: "",
      preview_description: "",
      creator: "",
      folder: "Shelf",
      tags: ["mine-tag", "common"],
      image_id: null,
      created_at: 1,
      updated_at: 10,
      has_alternate_greetings: false,
    });
    expect(preview.lorebooks).toEqual([{ id: MINE_BOOK_ID, name: "Mine Lorebook" }]);
    expect(preview.last_chat).toEqual({
      id: PREVIEW_CHAT_ID,
      name: "Preview Chat",
      updated_at: 40,
      last_message_preview: "Preview message",
    });
    expect(preview.open_chat_id).toBe(PREVIEW_CHAT_ID);
  });

  test("returns 404 for missing characters and characters owned by another user", async () => {
    expect((await app.request("/missing-character/homepage-preview")).status).toBe(404);
    expect((await app.request(`/${OTHER_ID}/homepage-preview`)).status).toBe(404);
  });
});

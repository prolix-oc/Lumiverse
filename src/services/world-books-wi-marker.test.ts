import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  createEntry,
  createWorldBook,
  getEntry,
  normalizeImportedEntryInput,
  updateEntry,
} from "./world-books.service";
import type { CreateWorldBookEntryInput } from "../types/world-book";

const USER_ID = "wi-marker-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function readRawExtensions(id: string): Record<string, any> {
  const row = getDb()
    .query("SELECT extensions FROM world_book_entries WHERE id = ?")
    .get(id) as { extensions: string } | undefined;
  return row ? JSON.parse(row.extensions) : {};
}

describe("WI marker fields — import normalization (pure)", () => {
  test("surfaces extensions.wi_marker / wi_marker_side", () => {
    const input = normalizeImportedEntryInput(
      {
        key: ["dragon"],
        content: "Smaug",
        position: 7,
        extensions: { wi_marker: "char_description", wi_marker_side: "before" },
      },
      0,
    );
    expect(input.wi_marker).toBe("char_description");
    expect(input.wi_marker_side).toBe("before");
  });

  test("surfaces camelCase aliases", () => {
    const input = normalizeImportedEntryInput(
      {
        key: ["x"],
        content: "x",
        extensions: { wiMarker: "scenario", wiMarkerSide: "after" },
      },
      0,
    );
    expect(input.wi_marker).toBe("scenario");
    expect(input.wi_marker_side).toBe("after");
  });

  test("top-level wi_marker takes precedence over extensions", () => {
    const input = normalizeImportedEntryInput(
      {
        key: ["x"],
        content: "x",
        position: 7,
        wi_marker: "main_prompt",
        extensions: { wi_marker: "jailbreak" },
      },
      0,
    );
    expect(input.wi_marker).toBe("main_prompt");
  });
});

describe("WI marker fields — persistence round trip", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  afterEach(() => closeDatabase());

  test("create + read preserves wi_marker and wi_marker_side", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "char_description",
      wi_marker_side: "before",
      content: "pinned",
    });
    expect(created).not.toBeNull();
    expect(created!.wi_marker).toBe("char_description");
    expect(created!.wi_marker_side).toBe("before");

    const read = getEntry(USER_ID, created!.id);
    expect(read).not.toBeNull();
    expect(read!.wi_marker).toBe("char_description");
    expect(read!.wi_marker_side).toBe("before");
    // Managed fields are surfaced top-level and stripped from extensions.
    expect(read!.extensions.wi_marker).toBeUndefined();
    expect(read!.extensions.wi_marker_side).toBeUndefined();
  });

  test("stored inside the extensions JSON bag", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "scenario",
      wi_marker_side: "after",
    });
    expect(created).not.toBeNull();
    const ext = readRawExtensions(created!.id);
    expect(ext.wi_marker).toBe("scenario");
    expect(ext.wi_marker_side).toBe("after");
  });

  test("unset marker stays null (legacy {{wi_marker}} pool behaviour)", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      content: "legacy",
    });
    expect(created!.wi_marker).toBeNull();
    expect(created!.wi_marker_side).toBeNull();
  });

  test("side is null when marker set but side omitted (assembly treats as after)", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "char_description",
    });
    expect(created!.wi_marker).toBe("char_description");
    expect(created!.wi_marker_side).toBeNull();
  });

  test("invalid wi_marker coerces to null; a valid side is retained independently", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "bogus_marker",
      wi_marker_side: "before",
    });
    expect(created!.wi_marker).toBeNull();
    // Fields are validated/stored independently (mirroring outlet_name): a valid
    // side persists even when the marker is invalid. The orphan side is inert at
    // assembly time since pinning keys entirely off wi_marker being set.
    expect(created!.wi_marker_side).toBe("before");
  });

  test("invalid wi_marker_side coerces to null but keeps a valid marker", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    // Untyped API/JSON body reaching createEntry with a side the type rejects.
    const input = {
      position: 7,
      wi_marker: "scenario",
      wi_marker_side: "sideways",
    } as unknown as CreateWorldBookEntryInput;
    const created = createEntry(USER_ID, book.id, input);
    expect(created!.wi_marker).toBe("scenario");
    expect(created!.wi_marker_side).toBeNull();
  });

  test("marker id and side are case-insensitive", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    // Untyped API/JSON body reaching createEntry with uppercase variants.
    const input = {
      position: 7,
      wi_marker: "CHAR_DESCRIPTION",
      wi_marker_side: "BEFORE",
    } as unknown as CreateWorldBookEntryInput;
    const created = createEntry(USER_ID, book.id, input);
    expect(created!.wi_marker).toBe("char_description");
    expect(created!.wi_marker_side).toBe("before");
  });

  test("non-position-7 entries still store the fields (position is an assembly concern)", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 0,
      wi_marker: "char_description",
      wi_marker_side: "before",
    });
    // Storage is position-agnostic; assembly ignores the marker when position != 7.
    expect(created!.wi_marker).toBe("char_description");
    expect(created!.wi_marker_side).toBe("before");
  });

  test("update clears the marker back to null", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "char_description",
      wi_marker_side: "before",
    });

    const updated = updateEntry(USER_ID, created!.id, { wi_marker: null, wi_marker_side: null });
    expect(updated!.wi_marker).toBeNull();
    expect(updated!.wi_marker_side).toBeNull();

    const read = getEntry(USER_ID, created!.id);
    expect(read!.wi_marker).toBeNull();
    expect(read!.wi_marker_side).toBeNull();
  });

  test("update can change marker and side together", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "char_description",
      wi_marker_side: "before",
    });

    const updated = updateEntry(USER_ID, created!.id, {
      wi_marker: "scenario",
      wi_marker_side: "after",
    });
    expect(updated!.wi_marker).toBe("scenario");
    expect(updated!.wi_marker_side).toBe("after");
  });

  test("update with only the side retains the existing marker", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const created = createEntry(USER_ID, book.id, {
      position: 7,
      wi_marker: "char_description",
      wi_marker_side: "before",
    });

    const updated = updateEntry(USER_ID, created!.id, { wi_marker_side: "after" });
    expect(updated!.wi_marker).toBe("char_description");
    expect(updated!.wi_marker_side).toBe("after");
  });

  test("raw import with extensions.wi_marker surfaces after persist", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const input = normalizeImportedEntryInput(
      {
        key: ["dragon"],
        content: "Smaug",
        position: 7,
        extensions: { wi_marker: "char_description", wi_marker_side: "before" },
      },
      0,
    );

    const created = createEntry(USER_ID, book.id, input);
    expect(created).not.toBeNull();
    expect(created!.wi_marker).toBe("char_description");
    expect(created!.wi_marker_side).toBe("before");

    const read = getEntry(USER_ID, created!.id);
    expect(read!.wi_marker).toBe("char_description");
    expect(read!.wi_marker_side).toBe("before");
  });

  test("all 12 valid marker ids round-trip", () => {
    const book = createWorldBook(USER_ID, { name: "Markers" });
    const ids = [
      "chat_history",
      "world_info_before",
      "world_info_after",
      "char_description",
      "char_personality",
      "persona_description",
      "scenario",
      "dialogue_examples",
      "main_prompt",
      "enhance_definitions",
      "jailbreak",
      "nsfw_prompt",
    ];
    for (const id of ids) {
      const created = createEntry(USER_ID, book.id, { position: 7, wi_marker: id });
      expect(created!.wi_marker, `marker ${id}`).toBe(id);
    }
  });
});

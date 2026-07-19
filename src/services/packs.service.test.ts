import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  createLoomItem,
  createLoomTool,
  createLumiaItem,
  createPack,
  getLumiaDlcCatalog,
} from "./packs.service";

const USER_ID = "user-1";

function initPacksTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");

  const db = getDb();
  db.run(`CREATE TABLE packs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    cover_url TEXT,
    version TEXT NOT NULL DEFAULT '1.0.0',
    is_custom INTEGER NOT NULL DEFAULT 1,
    source_url TEXT,
    extras TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE lumia_items (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    author_name TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    behavior TEXT NOT NULL DEFAULT '',
    gender_identity INTEGER NOT NULL DEFAULT 3,
    version TEXT NOT NULL DEFAULT '1.0.0',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE loom_items (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'narrative_style',
    author_name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '1.0.0',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE loom_tools (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    input_schema TEXT NOT NULL DEFAULT '{}',
    result_variable TEXT NOT NULL DEFAULT '',
    store_in_deliberation INTEGER NOT NULL DEFAULT 0,
    author_name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '1.0.0',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

beforeEach(initPacksTestDb);
afterEach(closeDatabase);

describe("getLumiaDlcCatalog", () => {
  test("returns every DLC category for only the requested user", () => {
    const pack = createPack(USER_ID, {
      name: "Aether Pack",
      author: "Lumia Author",
      is_custom: false,
      source_url: "https://example.test/aether",
      extras: { private_to_pack_ui: true },
    });
    const otherPack = createPack("other-user", { name: "Other Pack" });

    createLumiaItem(USER_ID, pack.id, { name: "Aether", definition: "A bright explorer" });
    createLoomItem(USER_ID, pack.id, { name: "Cinematic", content: "Write cinematically", category: "narrative_style" });
    createLoomItem(USER_ID, pack.id, { name: "Rhythm", content: "Vary cadence", category: "loom_utility" });
    createLoomItem(USER_ID, pack.id, { name: "Refit", content: "Modernize prose", category: "retrofit" });
    createLoomTool(USER_ID, pack.id, {
      tool_name: "aether_check",
      display_name: "Aether Check",
      prompt: "Review the scene",
      input_schema: { type: "object" },
    });
    createLumiaItem("other-user", otherPack.id, { name: "Not Visible" });

    const catalog = getLumiaDlcCatalog(USER_ID);

    expect(catalog.packs).toEqual([
      expect.objectContaining({
        id: pack.id,
        name: "Aether Pack",
        author: "Lumia Author",
        is_custom: false,
      }),
    ]);
    expect(catalog.packs[0]).not.toHaveProperty("user_id");
    expect(catalog.packs[0]).not.toHaveProperty("extras");
    expect(catalog.lumiaItems.map((item) => item.name)).toEqual(["Aether"]);
    expect(catalog.narrativeStyles.map((item) => item.name)).toEqual(["Cinematic"]);
    expect(catalog.utilities.map((item) => item.name)).toEqual(["Rhythm"]);
    expect(catalog.retrofits.map((item) => item.name)).toEqual(["Refit"]);
    expect(catalog.tools).toEqual([
      expect.objectContaining({ tool_name: "aether_check", display_name: "Aether Check" }),
    ]);
  });
});

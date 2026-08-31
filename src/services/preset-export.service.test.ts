import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  buildPresetBulkExportStream,
  consumePreparedPresetExport,
  preparePresetBulkExport,
} from "./preset-export.service";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    prompts TEXT NOT NULL DEFAULT '{}',
    user_id TEXT,
    engine TEXT NOT NULL DEFAULT 'classic',
    cache_revision INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
}

function insertPreset(id: string, userId: string, blockKey: string): void {
  getDb().run(
    `INSERT INTO presets (id, name, provider, parameters, prompt_order, metadata, prompts, user_id)
     VALUES (?, 'Shared name', 'loom', '{}', ?, ?, '{}', ?)`,
    [
      id,
      JSON.stringify([{
        id: `block-${id}`,
        name: "Private block",
        content: "private source text",
        sealed: true,
        sealedKey: blockKey,
        sealedSource: "lumihub",
      }]),
      JSON.stringify({
        coverUrl: `https://cdn.example.test/${id}.webp`,
        _lumiverse_sealed_preset: { blocks: [{ key: blockKey }] },
      }),
      userId,
    ],
  );
}

beforeEach(initTestDb);
afterEach(() => closeDatabase());

describe("streaming preset bulk export", () => {
  test("prepares a user-scoped one-shot download and streams portable JSON entries", async () => {
    insertPreset("preset-a", "u1", "private.a");
    insertPreset("preset-b", "u1", "private.b");
    insertPreset("foreign", "u2", "private.foreign");

    const prepared = preparePresetBulkExport("u1", ["preset-a", "preset-b", "foreign"]);
    expect(prepared).not.toBeNull();
    expect(prepared?.count).toBe(2);
    expect(consumePreparedPresetExport("u2", prepared!.downloadId)).toBeNull();

    const entry = consumePreparedPresetExport("u1", prepared!.downloadId);
    expect(entry?.presetIds).toEqual(["preset-a", "preset-b"]);
    expect(consumePreparedPresetExport("u1", prepared!.downloadId)).toBeNull();

    const bytes = new Uint8Array(await new Response(
      buildPresetBulkExportStream("u1", entry!.presetIds),
    ).arrayBuffer());
    const archive = unzipSync(bytes);
    expect(Object.keys(archive).sort()).toEqual(["Shared name (2).json", "Shared name.json"]);

    const first = JSON.parse(strFromU8(archive["Shared name.json"]));
    expect(Object.hasOwn(first, "id")).toBe(false);
    expect(first.coverUrl).toBe("https://cdn.example.test/preset-a.webp");
    expect(first.blocks[0]).toMatchObject({
      content: "{{presetBlock::private.a}}",
      sealed: true,
      sealedKey: "private.a",
    });
  });
});

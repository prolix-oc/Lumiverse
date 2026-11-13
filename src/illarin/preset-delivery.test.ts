import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { findPresetByIllarinAssetId, updatePreset } from "../services/presets.service";
import { activatePresetBoundRegexScripts, getRegexScriptsByPresetId } from "../services/regex-scripts.service";
import { installPreset } from "../lumihub/installer";
import * as api from "./api";
import type { IllarinDelivery } from "./types";

const USER_ID = "owner-1";
const TENANT_USER_ID = "tenant-1";
let artifact: Record<string, any> = {};
mock.module("./api", () => ({
  ...api,
  fetchDeliveryArtifact: async () => Response.json(artifact),
}));
const { installIllarinDelivery } = await import("./delivery-installer");

function initInstallerTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO "user" (id, createdAt) VALUES (?, ?)` , [USER_ID, 1]);
  db.run(`INSERT INTO "user" (id, createdAt) VALUES (?, ?)` , [TENANT_USER_ID, 2]);
  db.run(`CREATE TABLE presets (
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
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    script_id TEXT NOT NULL DEFAULT '',
    find_regex TEXT NOT NULL,
    replace_string TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT 'gi',
    placement TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_id TEXT,
    target TEXT NOT NULL,
    min_depth INTEGER,
    max_depth INTEGER,
    trim_strings TEXT NOT NULL,
    run_on_edit INTEGER NOT NULL DEFAULT 0,
    substitute_macros TEXT NOT NULL DEFAULT 'none',
    disabled INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    pack_id TEXT,
    preset_id TEXT,
    character_id TEXT,
    owner_extension_identifier TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE UNIQUE INDEX idx_regex_scripts_script_id
    ON regex_scripts(user_id, script_id)
    WHERE script_id != ''`);
}

beforeEach(initInstallerTestDb);
afterEach(() => closeDatabase());

function delivery(versionNumber: number): IllarinDelivery {
  return {
    id: `send-${versionNumber}`, workId: "work-1", versionNumber,
    type: "preset", name: "Delivery preset", format: "preset_lumiverse", label: "Lumiverse preset",
    queuedAt: "2026-10-09T00:00:00Z", leaseExpiresAt: "2026-10-09T00:15:00Z",
    files: [{ type: "export", url: "https://illarin.example/export" }],
  };
}
function raw(release: number, label?: string) {
  return {
    name: "Delivery preset", schemaVersion: 1,
    ...(label === undefined ? {} : { presetVersion: label }),
    blocks: [{ id: "block-1", content: `content-${release}` }],
    regex_scripts: [{ name: `Regex ${release}`, find_regex: `release-${release}`, disabled: false }],
  };
}
function current() {
  const preset = findPresetByIllarinAssetId(USER_ID, "work-1")!;
  return { preset, scripts: getRegexScriptsByPresetId(USER_ID, preset.id) };
}

test("numbered deliveries update content in place and retain unlabelled regex history", async () => {
  artifact = raw(1);
  await installIllarinDelivery(USER_ID, delivery(1));
  const firstId = current().preset.id;
  artifact = raw(2);
  await installIllarinDelivery(USER_ID, delivery(2));
  const { preset, scripts } = current();
  expect(preset.id).toBe(firstId);
  expect(preset.prompt_order[0].content).toBe("content-2");
  expect(preset.metadata).toMatchObject({ _lumiverse_preset_version: "2", _lumiverse_illarin_version_number: 2 });
  expect(scripts).toHaveLength(2);
  expect(scripts.find((s) => s.find_regex === "release-1")).toMatchObject({
    disabled: true, folder: "Delivery preset · v1",
    metadata: { _lumiverse_illarin_preset: { id: "work-1", versionNumber: 1 } },
  });
  activatePresetBoundRegexScripts(USER_ID, preset.id);
  const active = current().scripts.filter((s) => !s.disabled);
  expect(active.map((s) => s.find_regex)).toEqual(["release-2"]);
});

test("repeated labels preserve each numbered release, and a repeat send replaces only that release", async () => {
  for (const release of [1, 2, 3, 3]) {
    artifact = raw(release, "stable");
    await installIllarinDelivery(USER_ID, delivery(release));
  }
  const { preset, scripts } = current();
  expect(preset.metadata).toMatchObject({ _lumiverse_preset_version: "stable", _lumiverse_illarin_version_number: 3 });
  expect(scripts).toHaveLength(3);
  expect(scripts.map((s) => s.metadata._lumiverse_illarin_preset.versionNumber).sort()).toEqual([1, 2, 3]);
  expect(scripts.find((s) => s.find_regex === "release-1")?.folder).toBe("Delivery preset · v1");
  expect(scripts.find((s) => s.find_regex === "release-2")?.folder).toBe("Delivery preset · v2");
});

test("raw portable exports import extensions-only scripts with fresh Illarin attribution", async () => {
  const { regex_scripts, ...preset } = raw(1, "1.0.0");
  regex_scripts[0] = {
    ...regex_scripts[0],
    metadata: { _lumiverse_lumihub_preset: { id: "original-hub", version: "old" } },
  } as any;
  artifact = { ...preset, extensions: { regex_scripts } };
  await installIllarinDelivery(USER_ID, delivery(1));
  const { scripts } = current();
  expect(scripts).toHaveLength(1);
  expect(scripts[0].metadata._lumiverse_illarin_preset).toMatchObject({ id: "work-1", version: "1.0.0", versionNumber: 1 });
  expect(scripts[0].metadata._lumiverse_lumihub_preset).toBeUndefined();
});

test("wrapped exports retain prompt blocks, labels, covers and nested regex modules", async () => {
  const { regex_scripts, ...preset } = raw(1, "1.0.0");
  artifact = {
    type: "lumiverse_preset", cover_url: "https://example.test/cover.webp",
    preset: { ...preset, extensions: { lumiverse_modules: { regex_scripts } } },
  };
  await installIllarinDelivery(USER_ID, delivery(1));
  const stored = current();
  expect(stored.preset.prompt_order[0].content).toBe("content-1");
  expect(stored.preset.metadata).toMatchObject({ _lumiverse_preset_version: "1.0.0", coverUrl: "https://example.test/cover.webp" });
  expect(stored.scripts).toHaveLength(1);
});

test("failed regex updates roll back preset content and metadata before retrying", async () => {
  artifact = raw(1);
  await installIllarinDelivery(USER_ID, delivery(1));
  const previous = current();
  artifact = { ...raw(2), regex_scripts: [{ name: "Broken", find_regex: "[", flags: "g" }] };
  await expect(installIllarinDelivery(USER_ID, delivery(2))).rejects.toThrow(/incomplete/);
  expect(current()).toEqual(previous);
  artifact = raw(2);
  await installIllarinDelivery(USER_ID, delivery(2));
  expect(current().scripts).toHaveLength(2);
  expect(current().preset.metadata._lumiverse_illarin_version_number).toBe(2);
});

test("failed first deliveries leave no partial preset", async () => {
  artifact = { ...raw(1), regex_scripts: [{ name: "Broken", find_regex: "[", flags: "g" }] };
  await expect(installIllarinDelivery(USER_ID, delivery(1))).rejects.toThrow(/incomplete/);
  expect(findPresetByIllarinAssetId(USER_ID, "work-1")).toBeNull();
});

test("upgrading an unnumbered installation archives its regexes even when the label repeats", async () => {
  await installPreset("legacy", USER_ID, {
    source: "illarin", presetId: "work-1", presetName: "Delivery preset", presetData: { preset: raw(1, "stable") },
  });
  for (const release of [2, 3]) {
    artifact = raw(release, "stable");
    await installIllarinDelivery(USER_ID, delivery(release));
  }
  const scripts = current().scripts;
  expect(scripts).toHaveLength(3);
  expect(scripts.find((s) => s.find_regex === "release-1")).toMatchObject({
    disabled: true, metadata: { _lumiverse_illarin_preset: { version: "stable" } },
  });
  expect(scripts.find((s) => s.find_regex === "release-1")?.metadata._lumiverse_illarin_preset.versionNumber).toBeUndefined();
});

test("updates preserve user sampler settings and remain scoped to the receiving user", async () => {
  artifact = raw(1);
  await installIllarinDelivery(USER_ID, delivery(1));
  await installIllarinDelivery(TENANT_USER_ID, delivery(1));
  const first = current().preset;
  updatePreset(USER_ID, first.id, { parameters: { samplerOverrides: { temperature: 0.75 }, customBody: { user: true } } });
  artifact = { ...raw(2), samplerOverrides: { temperature: 1.5 }, customBody: { publisher: true } };
  await installIllarinDelivery(USER_ID, delivery(2));
  expect(current().preset.parameters).toEqual({ samplerOverrides: { temperature: 0.75 }, customBody: { user: true } });
  expect(findPresetByIllarinAssetId(TENANT_USER_ID, "work-1")?.metadata._lumiverse_illarin_version_number).toBe(1);
});

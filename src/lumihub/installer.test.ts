import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getPreset } from "../services/presets.service";
import { validateInstallPresetPayload } from "./payload-validation";
import { installPreset } from "./installer";
import type { InstallPresetPayload } from "./types";

const USER_ID = "owner-1";

function initInstallerTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO "user" (id, createdAt) VALUES (?, ?)` , [USER_ID, 1]);
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
    preset_id TEXT
  )`);
}

function installPayload(
  presetId: string,
  preset: Record<string, unknown>,
): InstallPresetPayload {
  return {
    source: "lumihub",
    presetId,
    presetName: "Hub preset",
    presetVersion: "1.0.0",
    presetCreator: "creator",
    presetSlug: "creator/hub-preset",
    presetData: {
      type: "lumiverse_preset",
      preset,
    },
  };
}

beforeEach(initInstallerTestDb);
afterEach(() => closeDatabase());

describe("LumiHub preset installer metadata", () => {
  test("preserves internal passthrough metadata on create and serialized metadata on update", async () => {
    const first = await installPreset("request-1", installPayload("hub-1", {
      name: "Hub preset",
      blocks: [],
      source: { kind: "loom" },
      description: "Native description",
      passthroughMetadata: {
        agentic_preset_composer: { mode: "single", revision: 1 },
        unrelated_extension: { enabled: true },
        source: { attempted: "override" },
        description: "attempted override",
        _lumiverse_lumihub_id: "attempted override",
      },
    }));

    expect(first.success).toBe(true);
    expect(first.presetId).toBeString();
    const created = getPreset(USER_ID, first.presetId!);
    expect(created?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "single", revision: 1 },
      unrelated_extension: { enabled: true },
      source: { kind: "loom" },
      description: "Native description",
      _lumiverse_lumihub_id: "hub-1",
      _lumiverse_install_source: "lumihub",
    });

    const second = await installPreset("request-2", installPayload("hub-1", {
      name: "Hub preset updated",
      blocks: [],
      source: { kind: "loom-updated" },
      description: "Native updated description",
      metadata: {
        agentic_preset_composer: { mode: "parallel", revision: 2 },
        unrelated_extension: { enabled: false, revision: 2 },
        _lumiverse_lumihub_id: "attempted override",
        description: "attempted override",
      },
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    const updated = getPreset(USER_ID, first.presetId!);
    expect(updated?.name).toBe("Hub preset updated");
    expect(updated?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "parallel", revision: 2 },
      unrelated_extension: { enabled: false, revision: 2 },
      source: { kind: "loom-updated" },
      description: "Native updated description",
      _lumiverse_lumihub_id: "hub-1",
      _lumiverse_install_source: "lumihub",
    });
  });

  test("preserves a locally-added passthrough key when an update omits it", async () => {
    const first = await installPreset("request-3", installPayload("hub-3", {
      name: "Hub preset",
      blocks: [],
      passthroughMetadata: {
        agentic_preset_composer: { mode: "parallel", graph: true },
      },
    }));
    expect(first.success).toBe(true);

    const updated = await installPreset("request-4", installPayload("hub-3", {
      name: "Hub preset update",
      blocks: [],
      metadata: {
        unrelated_extension: { retained: true },
      },
    }));
    expect(updated.success).toBe(true);
    const saved = getPreset(USER_ID, first.presetId!);
    expect(saved?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "parallel", graph: true },
      unrelated_extension: { retained: true },
    });
  });

  test("rejects metadata with an arbitrary prototype", () => {
    const metadata = Object.create({ inherited: true }) as Record<string, unknown>;
    metadata.agentic_preset_composer = { mode: "single" };
    const validation = validateInstallPresetPayload(installPayload("hub-2", {
      name: "Malformed",
      blocks: [],
      passthroughMetadata: metadata,
    }));

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.error).toContain("passthroughMetadata");
  });

  test("rejects accessor-backed metadata before it can execute", async () => {
    const preset = {
      name: "Accessor-backed",
      blocks: [],
    } as Record<string, unknown>;
    Object.defineProperty(preset, "passthroughMetadata", {
      enumerable: true,
      get() {
        throw new Error("metadata getter executed");
      },
    });

    const validation = validateInstallPresetPayload(installPayload("hub-4", preset));
    expect(validation.ok).toBe(false);

    const result = await installPreset("request-5", installPayload("hub-4", preset));
    expect(result.success).toBe(false);
    expect(result.error).toContain("passthroughMetadata");
  });

  test("rejects hidden metadata serialization hooks", () => {
    const metadata = {
      agentic_preset_composer: { mode: "single" },
    };
    Object.defineProperty(metadata, "toJSON", {
      enumerable: false,
      value: () => ({ injected: true }),
    });

    const validation = validateInstallPresetPayload(installPayload("hub-5", {
      name: "Hidden hook",
      blocks: [],
      passthroughMetadata: metadata,
    }));
    expect(validation.ok).toBe(false);
  });
});

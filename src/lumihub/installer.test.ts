import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createPreset, getPreset, updatePreset } from "../services/presets.service";
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

  test("updates the installed row while retaining user configuration", async () => {
    const first = await installPreset("request-config-1", installPayload("hub-config", {
      name: "Configurable preset",
      samplerOverrides: { enabled: true, temperature: 0.2 },
      customBody: { enabled: false, rawJson: "{}" },
      blocks: [
        {
          id: "category-old",
          name: "Old category",
          content: "",
          marker: "category",
          categoryMode: "checkbox",
        },
        {
          id: "block-1",
          name: "Original prompt",
          content: "Original content",
          group: "category-old",
          variables: [
            { id: "var-text", name: "instruction", label: "Instruction", type: "text", defaultValue: "Default" },
            { id: "var-number", name: "creativity", label: "Creativity", type: "number", defaultValue: 2, min: 0, max: 10 },
            {
              id: "var-select",
              name: "style",
              label: "Style",
              type: "select",
              defaultValue: "warm-old",
              options: [{ id: "warm-old", label: "Warm", value: "Warm style" }],
            },
            {
              id: "var-multi",
              name: "guides",
              label: "Guides",
              type: "multiselect",
              defaultValue: [],
              options: [
                { id: "concise-old", label: "Concise", value: "Be concise" },
                { id: "polite-old", label: "Polite", value: "Be polite" },
              ],
            },
            { id: "var-switch", name: "legacyToggle", label: "Toggle", type: "switch", defaultValue: 0 },
          ],
        },
      ],
      promptVariables: {},
    }));
    expect(first.success).toBe(true);

    const installed = getPreset(USER_ID, first.presetId!)!;
    const userSamplerOverrides = { enabled: true, temperature: 0.83, topP: 0.91 };
    const userCustomBody = { enabled: true, rawJson: "{\"provider_setting\":true}" };
    updatePreset(USER_ID, installed.id, {
      parameters: {
        samplerOverrides: userSamplerOverrides,
        customBody: userCustomBody,
      },
      metadata: {
        ...installed.metadata,
        promptVariables: {
          "block-1": {
            instruction: "User instruction",
            creativity: 8,
            style: "warm-old",
            guides: ["concise-old", "polite-old"],
            legacyToggle: 1,
          },
        },
      },
    });
    const binding = {
      preset_id: installed.id,
      block_states: { "block-1": false },
      captured_at: 123,
    };
    getDb().query(
      "INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)",
    ).run("presetProfileDefaults:" + installed.id, JSON.stringify(binding), USER_ID, 123);

    const second = await installPreset("request-config-2", installPayload("hub-config", {
      name: "Configurable preset v2",
      samplerOverrides: { enabled: true, temperature: 0.4 },
      customBody: { enabled: false, rawJson: "{\"publisher\":true}" },
      blocks: [
        {
          id: "category-new",
          name: "Adjusted category",
          content: "",
          marker: "category",
          categoryMode: "radio",
        },
        {
          id: "block-1",
          name: "Updated prompt",
          content: "Updated content",
          group: "category-new",
          variables: [
            { id: "var-text", name: "directive", label: "Directive", type: "textarea", defaultValue: "New default" },
            { id: "var-number", name: "creativity", label: "Creativity", type: "slider", defaultValue: 2, min: 0, max: 5 },
            {
              id: "var-select",
              name: "style",
              label: "Style",
              type: "select",
              defaultValue: "warm-new",
              options: [{ id: "warm-new", label: "Warm", value: "Warm style" }],
            },
            {
              id: "var-multi",
              name: "guides",
              label: "Guides",
              type: "multiselect",
              defaultValue: [],
              options: [{ id: "concise-new", label: "Concise", value: "Be concise" }],
            },
            {
              id: "var-switch",
              name: "mode",
              label: "Mode",
              type: "select",
              defaultValue: "publisher-mode",
              options: [{ id: "publisher-mode", label: "Publisher", value: "Publisher" }],
            },
          ],
        },
        {
          id: "block-2",
          name: "New prompt",
          content: "New block content",
          group: "category-new",
          variables: [
            { id: "var-new", name: "newVariable", label: "New", type: "text", defaultValue: "new" },
          ],
        },
      ],
      promptVariables: {
        "block-1": {
          directive: "Publisher instruction",
          creativity: 2,
          style: "warm-new",
          guides: [],
          mode: "publisher-mode",
        },
        "block-2": { newVariable: "Publisher new value" },
      },
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    const updated = getPreset(USER_ID, first.presetId!)!;
    expect(updated.name).toBe("Configurable preset v2");
    expect(updated.parameters).toEqual({
      samplerOverrides: userSamplerOverrides,
      customBody: userCustomBody,
    });
    expect(updated.prompt_order.map((block) => ({
      id: block.id,
      name: block.name,
      content: block.content,
      group: block.group,
      categoryMode: block.categoryMode,
    }))).toEqual([
      { id: "category-new", name: "Adjusted category", content: "", group: undefined, categoryMode: "radio" },
      { id: "block-1", name: "Updated prompt", content: "Updated content", group: "category-new", categoryMode: undefined },
      { id: "block-2", name: "New prompt", content: "New block content", group: "category-new", categoryMode: undefined },
    ]);
    expect(updated.metadata.promptVariables).toEqual({
      "block-1": {
        directive: "User instruction",
        creativity: 5,
        style: "warm-new",
        guides: ["concise-new"],
        mode: "publisher-mode",
      },
      "block-2": { newVariable: "Publisher new value" },
    });
    const savedBinding = getDb().query(
      "SELECT value FROM settings WHERE key = ? AND user_id = ?",
    ).get("presetProfileDefaults:" + installed.id, USER_ID) as { value: string };
    expect(JSON.parse(savedBinding.value)).toEqual(binding);
  });

  test("uses the manifest slug to update a LumiHub install whose Hub id changed", async () => {
    const first = await installPreset("request-identity-1", installPayload("old-hub-id", {
      name: "Hub preset",
      blocks: [],
    }));
    expect(first.success).toBe(true);

    const second = await installPreset("request-identity-2", installPayload("new-hub-id", {
      name: "Hub preset migrated",
      blocks: [],
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    expect(getPreset(USER_ID, first.presetId!)?.metadata._lumiverse_lumihub_id).toBe("new-hub-id");
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(1);
  });

  test("does not claim a local preset that happens to share the manifest slug", async () => {
    const local = createPreset(USER_ID, {
      name: "Local lookalike",
      provider: "loom",
      metadata: {
        _lumiverse_install_source: "local",
        _lumiverse_preset_slug: "creator/hub-preset",
      },
    });

    const installed = await installPreset("request-local-lookalike", installPayload("hub-lookalike", {
      name: "Hub preset",
      blocks: [],
    }));

    expect(installed.success).toBe(true);
    expect(installed.presetId).not.toBe(local.id);
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(2);
  });
});

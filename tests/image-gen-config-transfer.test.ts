/**
 * Image gen config import/export: secrets and install-specific IDs must never
 * leave in an export, and importing merges presets by ID, applies whitelisted
 * settings, and recreates connections without API keys.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as imageGenSvc from "../src/services/image-gen.service";
import * as imageGenConnSvc from "../src/services/image-gen-connections.service";
import * as settingsSvc from "../src/services/settings.service";

const EXPORTER = "image-gen-export-user";
const IMPORTER = "image-gen-import-user";
const PAGINATION = { limit: 50, offset: 0 };

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
}

const MAIN_PRESET = {
  id: "preset-main-1",
  name: "Main scene",
  mode: "custom" as const,
  prompt: "a castle, {{character_prompt}}",
  negativePrompt: "blurry",
  parserConnectionId: "llm-conn-1",
  parserModel: "exporter-preset-parser",
  parserParameters: { temperature: 0.7 },
  kind: "main" as const,
};

const CHARACTER_PRESET = {
  id: "preset-char-1",
  name: "Char snippet",
  mode: "custom" as const,
  prompt: "1girl, silver hair",
  kind: "character" as const,
};

async function seedExporter() {
  const conn = await imageGenConnSvc.createConnection(EXPORTER, {
    name: "My NovelAI",
    provider: "novelai",
    api_url: "https://image.novelai.net",
    model: "nai-diffusion-4-5-full",
    is_default: true,
    default_parameters: {
      steps: 28,
      sampler: "k_euler_ancestral",
      referenceImages: [{ data: "base64-personal-image", mimeType: "image/png" }],
    },
    metadata: { note: "shared" },
  });

  settingsSvc.putSetting(EXPORTER, "imageGeneration", {
    enabled: true,
    activeImageGenConnectionId: conn.id,
    promptParserConnectionId: "llm-conn-1",
    promptParserModel: "exporter-parser-model",
    promptParserParameters: { temperature: 1 },
    customPrompt: "shared custom prompt",
    sceneChangeThreshold: 3,
    activePromptPresetId: MAIN_PRESET.id,
    promptPresets: [MAIN_PRESET, CHARACTER_PRESET],
  });

  return conn;
}

describe("image gen config import/export", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("export strips install-specific IDs, reference images and key material", async () => {
    const conn = await seedExporter();
    const exported = imageGenSvc.exportImageGenConfig(EXPORTER);

    expect(exported.type).toBe("lumiverse_image_gen_config");
    expect(exported.version).toBe(1);

    expect(exported.presets).toHaveLength(2);
    for (const preset of exported.presets!) {
      // Parser setup is bound to the importer's own connection profile.
      expect("parserConnectionId" in preset).toBe(false);
      expect("parserModel" in preset).toBe(false);
      expect("parserParameters" in preset).toBe(false);
    }

    const settings = exported.settings!;
    expect(settings.customPrompt).toBe("shared custom prompt");
    expect(settings.sceneChangeThreshold).toBe(3);
    // Active preset reference travels because the preset itself is included.
    expect(settings.activePromptPresetId).toBe(MAIN_PRESET.id);
    expect("enabled" in settings).toBe(false);
    expect("activeImageGenConnectionId" in settings).toBe(false);
    expect("promptParserConnectionId" in settings).toBe(false);
    expect("promptParserModel" in settings).toBe(false);
    expect("promptParserParameters" in settings).toBe(false);
    expect("promptPresets" in settings).toBe(false);

    // Generation parameters of the active connection travel standalone.
    expect(exported.generation_parameters?.provider).toBe("novelai");
    expect(exported.generation_parameters?.parameters.steps).toBe(28);
    expect(exported.generation_parameters?.parameters.referenceImages).toBeUndefined();

    expect(exported.connections).toHaveLength(1);
    const exportedConn = exported.connections![0] as any;
    expect(exportedConn.name).toBe("My NovelAI");
    expect(exportedConn.default_parameters.steps).toBe(28);
    expect(exportedConn.default_parameters.referenceImages).toBeUndefined();
    expect(exportedConn.id).toBeUndefined();
    expect(exportedConn.has_api_key).toBeUndefined();

    const raw = JSON.stringify(exported);
    expect(raw).not.toContain(conn.id);
    expect(raw).not.toContain("base64-personal-image");
  });

  test("export respects section toggles and preset filters", async () => {
    await seedExporter();

    const presetsOnly = imageGenSvc.exportImageGenConfig(EXPORTER, {
      includeSettings: false,
      includeConnections: false,
      includeParameters: false,
      presetIds: [CHARACTER_PRESET.id],
    });
    expect(presetsOnly.settings).toBeUndefined();
    expect(presetsOnly.connections).toBeUndefined();
    expect(presetsOnly.generation_parameters).toBeUndefined();
    expect(presetsOnly.presets).toHaveLength(1);
    expect(presetsOnly.presets![0].id).toBe(CHARACTER_PRESET.id);

    // A provided ID list is authoritative: empty selection exports no presets.
    const emptySelection = imageGenSvc.exportImageGenConfig(EXPORTER, { presetIds: [] });
    expect(emptySelection.presets).toHaveLength(0);
  });

  test("import merges settings/presets and recreates connections without keys", async () => {
    await seedExporter();
    const exported = imageGenSvc.exportImageGenConfig(EXPORTER);

    const result = await imageGenSvc.importImageGenConfig(IMPORTER, exported);
    expect(result.errors).toHaveLength(0);
    expect(result.imported.settings).toBe(true);
    expect(result.imported.presets).toBe(2);
    expect(result.imported.connections).toBe(1);

    // No active connection on a fresh install: the parameters were silently
    // skipped because they already arrived inside the imported connection.
    expect(result.imported.parameters).toBe(false);

    const settings = imageGenSvc.getImageGenSettings(IMPORTER);
    expect(settings.customPrompt).toBe("shared custom prompt");
    expect(settings.sceneChangeThreshold).toBe(3);
    expect(settings.activePromptPresetId).toBe(MAIN_PRESET.id);
    // The receiver's enabled state and parser setup are never touched.
    expect(settings.enabled).toBe(false);
    expect(settings.promptParserModel).toBe("");
    expect(settings.promptPresets).toHaveLength(2);
    expect(settings.promptPresets![0].parserConnectionId).toBeUndefined();
    expect(settings.promptPresets![0].parserModel).toBeUndefined();

    const connections = imageGenConnSvc.listConnections(IMPORTER, PAGINATION);
    expect(connections.total).toBe(1);
    expect(connections.data[0].name).toBe("My NovelAI");
    expect(connections.data[0].has_api_key).toBe(false);
    expect(connections.data[0].default_parameters.steps).toBe(28);
  });

  test("re-importing a preset with the same ID overwrites it but keeps local parser setup", async () => {
    await seedExporter();
    const exported = imageGenSvc.exportImageGenConfig(EXPORTER, { includeConnections: false });
    await imageGenSvc.importImageGenConfig(IMPORTER, exported);

    // The importer wires their own parser onto the imported preset.
    const afterFirst = imageGenSvc.getImageGenSettings(IMPORTER);
    settingsSvc.putSetting(IMPORTER, "imageGeneration", {
      ...afterFirst,
      promptPresets: afterFirst.promptPresets!.map((p) =>
        p.id === CHARACTER_PRESET.id
          ? { ...p, parserConnectionId: "importer-conn", parserModel: "importer-model" }
          : p,
      ),
    });

    const updated = {
      ...exported,
      presets: [{ ...CHARACTER_PRESET, prompt: "1girl, red hair", parserConnectionId: undefined }],
    };
    const result = await imageGenSvc.importImageGenConfig(IMPORTER, updated);
    expect(result.imported.presets).toBe(1);

    const settings = imageGenSvc.getImageGenSettings(IMPORTER);
    expect(settings.promptPresets).toHaveLength(2);
    const overwritten = settings.promptPresets!.find((p) => p.id === CHARACTER_PRESET.id);
    expect(overwritten?.prompt).toBe("1girl, red hair");
    expect(overwritten?.parserConnectionId).toBe("importer-conn");
    expect(overwritten?.parserModel).toBe("importer-model");
  });

  test("generation parameters merge into a matching active connection", async () => {
    await seedExporter();
    const exported = imageGenSvc.exportImageGenConfig(EXPORTER, { includeConnections: false });

    const mine = await imageGenConnSvc.createConnection(IMPORTER, {
      name: "Importer NovelAI",
      provider: "novelai",
      model: "nai-diffusion-4-5-full",
      is_default: true,
      default_parameters: { steps: 10, guidance: 4, referenceImages: [{ data: "importer-image" }] },
    });
    settingsSvc.putSetting(IMPORTER, "imageGeneration", {
      activeImageGenConnectionId: mine.id,
      promptParserModel: "importer-parser-model",
    });

    const result = await imageGenSvc.importImageGenConfig(IMPORTER, exported);
    expect(result.errors).toHaveLength(0);
    expect(result.imported.parameters).toBe(true);

    const updated = imageGenConnSvc.getConnection(IMPORTER, mine.id)!;
    expect(updated.default_parameters.steps).toBe(28);
    expect(updated.default_parameters.sampler).toBe("k_euler_ancestral");
    // Merged, not replaced: keys the export doesn't carry stay put.
    expect(updated.default_parameters.guidance).toBe(4);
    expect(updated.default_parameters.referenceImages).toEqual([{ data: "importer-image" }]);

    // The importer's parser setup survives the import.
    expect(imageGenSvc.getImageGenSettings(IMPORTER).promptParserModel).toBe("importer-parser-model");
  });

  test("generation parameters are skipped when the active provider differs", async () => {
    await seedExporter();
    const exported = imageGenSvc.exportImageGenConfig(EXPORTER, { includeConnections: false });

    const mine = await imageGenConnSvc.createConnection(IMPORTER, {
      name: "Importer Comfy",
      provider: "comfyui",
      is_default: true,
      default_parameters: { steps: 20 },
    });
    settingsSvc.putSetting(IMPORTER, "imageGeneration", { activeImageGenConnectionId: mine.id });

    const result = await imageGenSvc.importImageGenConfig(IMPORTER, exported);
    expect(result.imported.parameters).toBe(false);
    expect(result.errors.some((e) => e.includes("Generation parameters skipped"))).toBe(true);
    expect(imageGenConnSvc.getConnection(IMPORTER, mine.id)!.default_parameters.steps).toBe(20);
  });

  test("rejects foreign payloads and skips malformed entries with errors", async () => {
    expect(imageGenSvc.importImageGenConfig(IMPORTER, { scripts: [] })).rejects.toThrow(
      "Not a Lumiverse image generation config export",
    );

    const result = await imageGenSvc.importImageGenConfig(IMPORTER, {
      version: 1,
      type: "lumiverse_image_gen_config",
      settings: { sceneChangeThreshold: "very high", autoGenerate: false },
      presets: [{ mode: "custom", prompt: "no name" }],
      connections: [{ name: "Mystery", provider: "not-a-provider" }],
    });

    expect(result.errors).toHaveLength(3);
    expect(result.imported.presets).toBe(0);
    expect(result.imported.connections).toBe(0);
    // Valid keys in the same payload still apply.
    expect(result.imported.settings).toBe(true);
    expect(imageGenSvc.getImageGenSettings(IMPORTER).autoGenerate).toBe(false);
    expect(imageGenSvc.getImageGenSettings(IMPORTER).sceneChangeThreshold).toBe(2);
  });
});

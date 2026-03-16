import type { LumiFileFormat, LumiPresetMetadata } from "../../types/lumi-engine";
import { LUMI_SIDECAR_DEFAULTS } from "../../types/lumi-engine";
import type { Preset } from "../../types/preset";
import * as presetsSvc from "../presets.service";

/** Validate a parsed JSON object against the LumiFileFormat shape. */
export function validateLumiFile(data: any): { valid: boolean; error?: string } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Invalid JSON object" };
  }
  if (data.version !== 2) {
    return { valid: false, error: `Unsupported version: ${data.version}` };
  }
  if (typeof data.name !== "string" || !data.name.trim()) {
    return { valid: false, error: "Missing or empty 'name'" };
  }
  if (typeof data.provider !== "string" || !data.provider.trim()) {
    return { valid: false, error: "Missing or empty 'provider'" };
  }

  if (!Array.isArray(data.pipelines)) {
    return { valid: false, error: "'pipelines' must be an array" };
  }
  for (const pipeline of data.pipelines) {
    if (!pipeline.key || !pipeline.name || !Array.isArray(pipeline.modules)) {
      return { valid: false, error: `Invalid pipeline group: ${JSON.stringify(pipeline)}` };
    }
    for (const mod of pipeline.modules) {
      if (!mod.key || !mod.name || typeof mod.prompt !== "string") {
        return { valid: false, error: `Invalid pipeline module: ${JSON.stringify(mod)}` };
      }
    }
  }

  return { valid: true };
}

/** Import a .lumi file and create a preset with engine="lumi". */
export function importLumiFile(userId: string, file: LumiFileFormat): Preset {

  const metadata: LumiPresetMetadata = {
    pipelines: file.pipelines,
    sidecar: file.sidecar,
    blockGroups: file.blockGroups,
  };

  return presetsSvc.createPreset(userId, {
    name: file.name,
    provider: file.provider,
    engine: "lumi",
    parameters: file.parameters || {},
    prompt_order: file.prompt_order || [],
    prompts: file.prompts || {},
    metadata: metadata as any,
  });
}

/** Export a lumi preset as a LumiFileFormat JSON object. */
export function exportLumiFile(userId: string, presetId: string): LumiFileFormat | null {
  const preset = presetsSvc.getPreset(userId, presetId);
  if (!preset) return null;
  if (preset.engine !== "lumi") return null;

  const meta = preset.metadata as LumiPresetMetadata;

  return {
    version: 2,
    name: preset.name,
    provider: preset.provider,
    pipelines: meta?.pipelines || [],
    sidecar: meta?.sidecar || { ...LUMI_SIDECAR_DEFAULTS },
    blockGroups: meta?.blockGroups,
    parameters: preset.parameters,
    prompts: preset.prompts,
    prompt_order: preset.prompt_order,
  };
}

import * as settingsSvc from "../settings.service";

export interface DatabankSettings {
  chunkTargetTokens: number;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  retrievalTopK: number;
}

export const DATABANK_SETTINGS_KEY = "databankSettings";

export const DEFAULT_DATABANK_SETTINGS: DatabankSettings = {
  chunkTargetTokens: 800,
  chunkMaxTokens: 1600,
  chunkOverlapTokens: 120,
  retrievalTopK: 4,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function normalizeDatabankSettings(input: any): DatabankSettings {
  const target = clampInt(input?.chunkTargetTokens, 200, 2000, DEFAULT_DATABANK_SETTINGS.chunkTargetTokens);
  const max = clampInt(input?.chunkMaxTokens, target, 4000, Math.max(DEFAULT_DATABANK_SETTINGS.chunkMaxTokens, target));

  return {
    chunkTargetTokens: target,
    chunkMaxTokens: Math.max(target, max),
    chunkOverlapTokens: clampInt(input?.chunkOverlapTokens, 0, 500, DEFAULT_DATABANK_SETTINGS.chunkOverlapTokens),
    retrievalTopK: clampInt(input?.retrievalTopK, 1, 20, DEFAULT_DATABANK_SETTINGS.retrievalTopK),
  };
}

export function loadDatabankSettings(userId: string): DatabankSettings {
  const raw = settingsSvc.getSetting(userId, DATABANK_SETTINGS_KEY)?.value;
  return normalizeDatabankSettings(raw);
}

export function saveDatabankSettings(userId: string, input: any): DatabankSettings {
  const normalized = normalizeDatabankSettings(input);
  settingsSvc.putSetting(userId, DATABANK_SETTINGS_KEY, normalized);
  return normalized;
}

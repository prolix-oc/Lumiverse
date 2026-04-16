import * as settingsSvc from "../settings.service";

const SETTINGS_KEY = "dreamWeaverGenParams";

export interface DWGenParams {
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  topK?: number | null;
  /** Timeout in milliseconds. Null or absent = no timeout applied. */
  timeoutMs?: number | null;
}

/** Load Dream Weaver generation params from the user's setting. Returns an empty object when not set. */
export function getDWGenParams(userId: string): DWGenParams {
  const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
  if (row?.value && typeof row.value === "object") {
    return row.value as DWGenParams;
  }
  return {};
}

/**
 * Merge user-configured Dream Weaver gen params into a base parameter set.
 * Only fields that have been explicitly set (non-null) are applied.
 */
export function applyDWGenParams(
  base: Record<string, unknown>,
  params: DWGenParams,
): Record<string, unknown> {
  const result = { ...base };
  if (params.temperature != null) result.temperature = params.temperature;
  if (params.topP != null) result.top_p = params.topP;
  if (params.maxTokens != null) result.max_tokens = params.maxTokens;
  if (params.topK != null) result.top_k = params.topK;
  return result;
}

/**
 * Create a timeout AbortSignal from gen params.
 * Returns null when no timeout is configured.
 */
export function createDWTimeout(
  params: DWGenParams,
): { signal: AbortSignal; cleanup: () => void } | null {
  const ms = params.timeoutMs;
  if (ms == null || ms <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

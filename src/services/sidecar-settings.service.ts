import * as settingsSvc from "./settings.service";
import type { SidecarConfig } from "lumiverse-spindle-types";
import { SIDECAR_DEFAULTS } from "lumiverse-spindle-types";
import { getCouncilSettings } from "./council/council-settings.service";

const SETTINGS_KEY = "sidecarSettings";

export type SidecarSettings = SidecarConfig;

function isObject(value: unknown): value is Partial<SidecarSettings> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the shared sidecar settings for a user.
 *
 * Resolution order:
 * 1. Dedicated `sidecarSettings` setting (new, preferred)
 * 2. Legacy `council_settings.toolsSettings.sidecar` (backwards compat)
 * 3. Defaults
 */
export function getSidecarSettings(userId: string): SidecarSettings {
  // Try the new dedicated setting first
  const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
  if (isObject(row?.value)) {
    return { ...SIDECAR_DEFAULTS, ...row.value };
  }

  // Fall back to legacy council sidecar config
  const councilSettings = getCouncilSettings(userId);
  const legacy = councilSettings.toolsSettings?.sidecar;
  if (legacy?.connectionProfileId) {
    return {
      connectionProfileId: legacy.connectionProfileId,
      model: legacy.model || "",
      temperature: legacy.temperature ?? SIDECAR_DEFAULTS.temperature,
      topP: legacy.topP ?? SIDECAR_DEFAULTS.topP,
      maxTokens: legacy.maxTokens ?? SIDECAR_DEFAULTS.maxTokens,
    };
  }

  return { ...SIDECAR_DEFAULTS };
}

export function putSidecarSettings(userId: string, settings: Partial<SidecarSettings>): SidecarSettings {
  const current = getSidecarSettings(userId);
  const merged = { ...current, ...settings };
  settingsSvc.putSetting(userId, SETTINGS_KEY, merged);
  return merged;
}

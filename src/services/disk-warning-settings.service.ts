import { getFirstUserId } from "../auth/seed";
import {
  DEFAULT_DISK_WARNING_MIN_FREE_BYTES,
  DEFAULT_DISK_WARNING_USAGE_THRESHOLD,
  env,
} from "../env";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";

export const DISK_WARNING_SETTINGS_KEY = "diskWarningSettings";

export interface DiskWarningSettings {
  /** 0..1 ratio; 0.9 = 90% used. Inputs in 0..100 are also accepted and normalized. */
  usagePercentThreshold?: number | null;
  minFreeBytesThreshold?: number | null;
}

export interface ResolvedDiskWarningSettings {
  usagePercentThreshold: number;
  minFreeBytesThreshold: number;
}

export interface DiskWarningSettingsStatus {
  settingsKey: typeof DISK_WARNING_SETTINGS_KEY;
  configuredSettings: DiskWarningSettings;
  effectiveSettings: ResolvedDiskWarningSettings;
  defaults: ResolvedDiskWarningSettings;
}

const DEFAULT_DISK_WARNING_SETTINGS: ResolvedDiskWarningSettings = {
  usagePercentThreshold: env.diskWarningUsageThreshold ?? DEFAULT_DISK_WARNING_USAGE_THRESHOLD,
  minFreeBytesThreshold: env.diskWarningMinFreeBytes ?? DEFAULT_DISK_WARNING_MIN_FREE_BYTES,
};

let currentConfiguredSettings: DiskWarningSettings = {};
let currentEffectiveSettings: ResolvedDiskWarningSettings = { ...DEFAULT_DISK_WARNING_SETTINGS };
let initialized = false;

function normalizeUsageThreshold(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingError("Disk warning usage threshold must be a number or null");
  }
  if (value <= 0) {
    throw new InvalidSettingError("Disk warning usage threshold must be greater than 0");
  }
  const ratio = value <= 1 ? value : value / 100;
  return Math.max(0.01, Math.min(1, ratio));
}

function normalizeMinFreeBytes(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingError("Disk warning minimum free space must be a number or null");
  }
  return Math.max(0, Math.floor(value));
}

export function normalizeDiskWarningSettings(input: unknown): DiskWarningSettings {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSettingError("Disk warning settings must be an object");
  }
  const raw = input as Record<string, unknown>;
  return {
    usagePercentThreshold: normalizeUsageThreshold(raw.usagePercentThreshold),
    minFreeBytesThreshold: normalizeMinFreeBytes(raw.minFreeBytesThreshold),
  };
}

function resolveDiskWarningSettings(
  configured: DiskWarningSettings | null | undefined,
): ResolvedDiskWarningSettings {
  return {
    usagePercentThreshold: configured?.usagePercentThreshold ?? DEFAULT_DISK_WARNING_SETTINGS.usagePercentThreshold,
    minFreeBytesThreshold: configured?.minFreeBytesThreshold ?? DEFAULT_DISK_WARNING_SETTINGS.minFreeBytesThreshold,
  };
}

function loadStoredDiskWarningSettings(userId: string | null): DiskWarningSettings {
  if (!userId) return {};
  const stored = getSetting(userId, DISK_WARNING_SETTINGS_KEY)?.value;
  return normalizeDiskWarningSettings(stored);
}

export function applyDiskWarningSettings(
  configured: DiskWarningSettings | null | undefined,
): DiskWarningSettingsStatus {
  const normalized = normalizeDiskWarningSettings(configured ?? {});
  currentConfiguredSettings = { ...normalized };
  currentEffectiveSettings = resolveDiskWarningSettings(normalized);
  return getDiskWarningSettingsStatus();
}

export function loadAndApplyDiskWarningSettings(
  userId: string | null = getFirstUserId(),
): DiskWarningSettingsStatus {
  return applyDiskWarningSettings(loadStoredDiskWarningSettings(userId));
}

export function getDiskWarningSettingsStatus(): DiskWarningSettingsStatus {
  return {
    settingsKey: DISK_WARNING_SETTINGS_KEY,
    configuredSettings: { ...currentConfiguredSettings },
    effectiveSettings: { ...currentEffectiveSettings },
    defaults: { ...DEFAULT_DISK_WARNING_SETTINGS },
  };
}

export function getEffectiveDiskWarningSettings(): ResolvedDiskWarningSettings {
  return currentEffectiveSettings;
}

export function putDiskWarningSettings(
  userId: string,
  input: unknown,
): DiskWarningSettingsStatus {
  const normalized = normalizeDiskWarningSettings(input);
  putSetting(userId, DISK_WARNING_SETTINGS_KEY, normalized);
  return applyDiskWarningSettings(normalized);
}

export function initDiskWarningSettings(): void {
  if (initialized) return;
  initialized = true;

  loadAndApplyDiskWarningSettings();

  eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
    const ownerUserId = getFirstUserId();
    if (!ownerUserId || event.userId !== ownerUserId) return;

    const payload = event.payload as { key?: string; keys?: string[] } | undefined;
    if (!payload) return;

    const changed = payload.key === DISK_WARNING_SETTINGS_KEY
      || (Array.isArray(payload.keys) && payload.keys.includes(DISK_WARNING_SETTINGS_KEY));
    if (!changed) return;

    try {
      loadAndApplyDiskWarningSettings(ownerUserId);
    } catch (err) {
      console.error("[disk-warning-settings] Failed to apply updated settings:", err);
      applyDiskWarningSettings({});
    }
  });
}

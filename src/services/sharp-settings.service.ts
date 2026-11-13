import sharp from "sharp";
import { currentWorkerBudget, deriveThumbnailSharpConcurrency } from "../utils/cpu-budget";
import { getFirstUserId } from "../auth/seed";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";

export const SHARP_SETTINGS_KEY = "sharpSettings";

export type ThumbnailCodec = "webp" | "avif";

export interface SharpSettings {
  concurrency?: number | null;
  cacheMemoryMb?: number | null;
  cacheFiles?: number | null;
  cacheItems?: number | null;
  thumbnailCodec?: ThumbnailCodec | null;
  webpQuality?: number | null;
  avifQuality?: number | null;
}

export interface ResolvedSharpSettings {
  concurrency: number;
  cacheMemoryMb: number;
  cacheFiles: number;
  cacheItems: number;
  thumbnailCodec: ThumbnailCodec;
  webpQuality: number;
  avifQuality: number;
}

export interface SharpSettingsStatus {
  settingsKey: typeof SHARP_SETTINGS_KEY;
  configuredSettings: SharpSettings;
  effectiveSettings: ResolvedSharpSettings;
  defaults: ResolvedSharpSettings;
  automaticConcurrency: Record<ThumbnailCodec, number>;
}

const cpuDerivedSharpConcurrency = currentWorkerBudget().sharpConcurrency;
const AUTOMATIC_CONCURRENCY: Record<ThumbnailCodec, number> = {
  webp: deriveThumbnailSharpConcurrency("webp", cpuDerivedSharpConcurrency),
  avif: deriveThumbnailSharpConcurrency("avif", cpuDerivedSharpConcurrency),
};

const DEFAULT_SHARP_SETTINGS: ResolvedSharpSettings = {
  concurrency: AUTOMATIC_CONCURRENCY.webp,
  cacheMemoryMb: 64,
  cacheFiles: 128,
  cacheItems: 256,
  thumbnailCodec: "webp",
  webpQuality: 80,
  avifQuality: 54,
};

let currentConfiguredSettings: SharpSettings = {};
let currentEffectiveSettings: ResolvedSharpSettings = { ...DEFAULT_SHARP_SETTINGS };
let initialized = false;

function clampInteger(value: unknown, min: number, max: number, label: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSettingError(`${label} must be a number or null`);
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeThumbnailCodec(value: unknown): ThumbnailCodec | null {
  if (value == null || value === "") return null;
  if (value !== "webp" && value !== "avif") {
    throw new InvalidSettingError("Thumbnail codec must be webp, avif, or null");
  }
  return value;
}

export function normalizeSharpSettings(input: unknown): SharpSettings {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSettingError("Sharp settings must be an object");
  }

  const raw = input as Record<string, unknown>;
  return {
    concurrency: clampInteger(raw.concurrency, 1, 16, "Sharp concurrency"),
    cacheMemoryMb: clampInteger(raw.cacheMemoryMb, 8, 512, "Sharp cache memory"),
    cacheFiles: clampInteger(raw.cacheFiles, 0, 2048, "Sharp cache files"),
    cacheItems: clampInteger(raw.cacheItems, 1, 4096, "Sharp cache items"),
    thumbnailCodec: normalizeThumbnailCodec(raw.thumbnailCodec),
    webpQuality: clampInteger(raw.webpQuality, 1, 100, "WebP thumbnail quality"),
    avifQuality: clampInteger(raw.avifQuality, 1, 100, "AVIF thumbnail quality"),
  };
}

function resolveSharpSettings(configured: SharpSettings | null | undefined): ResolvedSharpSettings {
  const thumbnailCodec = configured?.thumbnailCodec ?? DEFAULT_SHARP_SETTINGS.thumbnailCodec;
  return {
    concurrency: configured?.concurrency ?? AUTOMATIC_CONCURRENCY[thumbnailCodec],
    cacheMemoryMb: configured?.cacheMemoryMb ?? DEFAULT_SHARP_SETTINGS.cacheMemoryMb,
    cacheFiles: configured?.cacheFiles ?? DEFAULT_SHARP_SETTINGS.cacheFiles,
    cacheItems: configured?.cacheItems ?? DEFAULT_SHARP_SETTINGS.cacheItems,
    thumbnailCodec,
    webpQuality: configured?.webpQuality ?? DEFAULT_SHARP_SETTINGS.webpQuality,
    avifQuality: configured?.avifQuality ?? DEFAULT_SHARP_SETTINGS.avifQuality,
  };
}

function applyResolvedSharpSettings(effective: ResolvedSharpSettings): void {
  sharp.concurrency(effective.concurrency);
  sharp.cache({
    memory: effective.cacheMemoryMb,
    files: effective.cacheFiles,
    items: effective.cacheItems,
  });
  currentEffectiveSettings = { ...effective };
}

function loadStoredSharpSettings(userId: string | null): SharpSettings {
  if (!userId) return {};
  const stored = getSetting(userId, SHARP_SETTINGS_KEY)?.value;
  return normalizeSharpSettings(stored);
}

export function applySharpSettings(configured: SharpSettings | null | undefined): SharpSettingsStatus {
  const normalized = normalizeSharpSettings(configured ?? {});
  currentConfiguredSettings = { ...normalized };
  const effective = resolveSharpSettings(normalized);
  applyResolvedSharpSettings(effective);
  return getSharpSettingsStatus();
}

export function loadAndApplySharpSettings(userId: string | null = getFirstUserId()): SharpSettingsStatus {
  return applySharpSettings(loadStoredSharpSettings(userId));
}

export function getSharpSettingsStatus(): SharpSettingsStatus {
  return {
    settingsKey: SHARP_SETTINGS_KEY,
    configuredSettings: { ...currentConfiguredSettings },
    effectiveSettings: { ...currentEffectiveSettings },
    defaults: { ...DEFAULT_SHARP_SETTINGS },
    automaticConcurrency: { ...AUTOMATIC_CONCURRENCY },
  };
}

/** Drop Sharp/libvips caches while keeping the configured limits active for later work. */
export function releaseSharpCacheMemory(): void {
  const effective = { ...currentEffectiveSettings };
  sharp.cache(false);
  sharp.cache({
    memory: effective.cacheMemoryMb,
    files: effective.cacheFiles,
    items: effective.cacheItems,
  });
}

export function putSharpSettings(userId: string, input: unknown): SharpSettingsStatus {
  const normalized = normalizeSharpSettings(input);
  putSetting(userId, SHARP_SETTINGS_KEY, normalized);
  return applySharpSettings(normalized);
}

export function initSharpSettings(): void {
  if (initialized) return;
  initialized = true;

  loadAndApplySharpSettings();

  eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
    const ownerUserId = getFirstUserId();
    if (!ownerUserId || event.userId !== ownerUserId) return;

    const payload = event.payload as { key?: string; keys?: string[] } | undefined;
    if (!payload) return;

    const changed = payload.key === SHARP_SETTINGS_KEY
      || (Array.isArray(payload.keys) && payload.keys.includes(SHARP_SETTINGS_KEY));
    if (!changed) return;

    try {
      loadAndApplySharpSettings(ownerUserId);
    } catch (err) {
      console.error("[sharp-settings] Failed to apply updated settings:", err);
      applySharpSettings({});
    }
  });
}

applyResolvedSharpSettings(DEFAULT_SHARP_SETTINGS);

export default sharp;

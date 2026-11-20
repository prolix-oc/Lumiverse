import * as settingsSvc from "../settings.service";
import { InvalidSettingError } from "../settings-validation";
import { normalizeEndpointOrigin } from "./origin";
import { isInferenceSchedulerHost } from "./runtime";
import type { InferenceResourceGroup, InferenceSchedulerConfig } from "./types";

export const INFERENCE_SCHEDULER_SETTINGS_KEY = "inferenceSchedulerConfig";

const MAX_ORIGINS = 100;
const MAX_GROUPS = 8;
const MAX_ORIGINS_PER_GROUP = 50;
const CACHE_TTL_MS = 5_000;

export const DEFAULT_INFERENCE_SCHEDULER_CONFIG: InferenceSchedulerConfig = {
  enabled: false,
  unifiedLocalPool: true,
  schedulePrivateNetwork: true,
  extraOrigins: [],
  excludedOrigins: [],
  groups: [],
  concurrency: 1,
  preemptBackground: true,
  agingMs: 15_000,
  maxWaitMs: 0,
};

interface CacheEntry {
  value: InferenceSchedulerConfig;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeOriginList(value: unknown, cap = MAX_ORIGINS): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const origins: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const origin = normalizeEndpointOrigin(entry);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
    if (origins.length >= cap) break;
  }
  return origins;
}

function slugifyGroupId(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return slug;
  return fallback;
}

function normalizeGroups(value: unknown): InferenceResourceGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: InferenceResourceGroup[] = [];
  const claimedIds = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const rawName = typeof entry.name === "string" ? entry.name.trim().slice(0, 60) : "";
    const origins = normalizeOriginList(entry.origins, MAX_ORIGINS_PER_GROUP);
    if (origins.length === 0) continue;

    let id = typeof entry.id === "string" ? slugifyGroupId(entry.id, "") : "";
    if (!id) id = slugifyGroupId(rawName, `group-${groups.length + 1}`);
    let uniqueId = id;
    let suffix = 2;
    while (claimedIds.has(uniqueId)) {
      uniqueId = `${id}-${suffix}`;
      suffix += 1;
    }
    claimedIds.add(uniqueId);
    groups.push({
      id: uniqueId,
      name: rawName || `Inference pool ${groups.length + 1}`,
      origins,
    });
    if (groups.length >= MAX_GROUPS) break;
  }
  return groups;
}

export function normalizeInferenceSchedulerConfig(raw: unknown): InferenceSchedulerConfig {
  if (!isObject(raw)) return { ...DEFAULT_INFERENCE_SCHEDULER_CONFIG };
  return {
    enabled: bool(raw.enabled, DEFAULT_INFERENCE_SCHEDULER_CONFIG.enabled),
    unifiedLocalPool: bool(raw.unifiedLocalPool, DEFAULT_INFERENCE_SCHEDULER_CONFIG.unifiedLocalPool),
    schedulePrivateNetwork: bool(
      raw.schedulePrivateNetwork,
      DEFAULT_INFERENCE_SCHEDULER_CONFIG.schedulePrivateNetwork,
    ),
    extraOrigins: normalizeOriginList(raw.extraOrigins),
    excludedOrigins: normalizeOriginList(raw.excludedOrigins),
    groups: normalizeGroups(raw.groups),
    concurrency: clampInt(raw.concurrency, DEFAULT_INFERENCE_SCHEDULER_CONFIG.concurrency, 1, 8),
    preemptBackground: bool(raw.preemptBackground, DEFAULT_INFERENCE_SCHEDULER_CONFIG.preemptBackground),
    agingMs: clampInt(raw.agingMs, DEFAULT_INFERENCE_SCHEDULER_CONFIG.agingMs, 0, 600_000),
    maxWaitMs: clampInt(raw.maxWaitMs, DEFAULT_INFERENCE_SCHEDULER_CONFIG.maxWaitMs, 0, 1_800_000),
  };
}

export function invalidateInferenceSchedulerConfig(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

export function getInferenceSchedulerConfig(userId: string): InferenceSchedulerConfig {
  // Workers and the vectorization subprocess are leased by the host; they must
  // not read user settings or build a parallel queue.
  if (!isInferenceSchedulerHost()) return { ...DEFAULT_INFERENCE_SCHEDULER_CONFIG };

  const cached = cache.get(userId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.value;

  let value: InferenceSchedulerConfig;
  try {
    const row = settingsSvc.getSetting(userId, INFERENCE_SCHEDULER_SETTINGS_KEY);
    value = normalizeInferenceSchedulerConfig(row?.value);
  } catch {
    // Storage may not be initialized yet (tooling, early boot, unit tests).
    // Scheduling is opt-in, so defaulting to disabled is safe.
    value = { ...DEFAULT_INFERENCE_SCHEDULER_CONFIG };
  }
  cache.set(userId, { value, loadedAt: Date.now() });
  return value;
}

export function putInferenceSchedulerConfig(
  userId: string,
  patch: unknown,
): InferenceSchedulerConfig {
  if (!isObject(patch)) {
    throw new InvalidSettingError("Inference scheduler config must be an object");
  }
  const current = getInferenceSchedulerConfig(userId);
  const merged = normalizeInferenceSchedulerConfig({ ...current, ...patch });
  settingsSvc.putSetting(userId, INFERENCE_SCHEDULER_SETTINGS_KEY, merged);
  cache.set(userId, { value: merged, loadedAt: Date.now() });
  return merged;
}

export function resetInferenceSchedulerConfigForTests(): void {
  cache.clear();
}

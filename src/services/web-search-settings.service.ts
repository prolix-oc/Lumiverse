import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";

export const WEB_SEARCH_SETTINGS_KEY = "webSearchSettings";
export const WEB_SEARCH_API_KEY_SECRET = "web_search_api_key";

export interface WebSearchSettings {
  enabled: boolean;
  provider: "searxng";
  apiUrl: string;
  requestTimeoutMs: number;
  defaultResultCount: number;
  maxResultCount: number;
  maxPagesToScrape: number;
  maxCharsPerPage: number;
  language: string;
  safeSearch: 0 | 1 | 2;
  engines: string[];
  hasApiKey: boolean;
}

export interface WebSearchSettingsInput {
  enabled?: boolean;
  provider?: "searxng";
  apiUrl?: string;
  requestTimeoutMs?: number;
  defaultResultCount?: number;
  maxResultCount?: number;
  maxPagesToScrape?: number;
  maxCharsPerPage?: number;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  engines?: string[];
  apiKey?: string | null;
}

const DEFAULT_SETTINGS: Omit<WebSearchSettings, "hasApiKey"> = {
  enabled: false,
  provider: "searxng",
  apiUrl: "",
  requestTimeoutMs: 15_000,
  defaultResultCount: 3,
  maxResultCount: 5,
  maxPagesToScrape: 3,
  maxCharsPerPage: 3_000,
  language: "all",
  safeSearch: 1,
  engines: [],
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeApiUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.apiUrl;
  return value.trim().replace(/\/$/, "");
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.language;
  const trimmed = value.trim();
  return trimmed || DEFAULT_SETTINGS.language;
}

function normalizeEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const engines: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    engines.push(trimmed);
    if (engines.length >= 20) break;
  }
  return engines;
}

function normalizeBaseSettings(raw: Partial<WebSearchSettingsInput> | null | undefined): Omit<WebSearchSettings, "hasApiKey"> {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const defaultResultCount = clampInt(merged.defaultResultCount, 1, 10, DEFAULT_SETTINGS.defaultResultCount);
  const maxResultCount = clampInt(merged.maxResultCount, defaultResultCount, 20, DEFAULT_SETTINGS.maxResultCount);

  return {
    enabled: !!merged.enabled,
    provider: "searxng",
    apiUrl: normalizeApiUrl(merged.apiUrl),
    requestTimeoutMs: clampInt(merged.requestTimeoutMs, 5_000, 120_000, DEFAULT_SETTINGS.requestTimeoutMs),
    defaultResultCount,
    maxResultCount,
    maxPagesToScrape: clampInt(merged.maxPagesToScrape, 1, 10, DEFAULT_SETTINGS.maxPagesToScrape),
    maxCharsPerPage: clampInt(merged.maxCharsPerPage, 500, 20_000, DEFAULT_SETTINGS.maxCharsPerPage),
    language: normalizeLanguage(merged.language),
    safeSearch: clampInt(merged.safeSearch, 0, 2, DEFAULT_SETTINGS.safeSearch) as 0 | 1 | 2,
    engines: normalizeEngines(merged.engines),
  };
}

export function normalizeWebSearchSettings(
  raw: Partial<WebSearchSettingsInput> | null | undefined,
  hasApiKey: boolean,
): WebSearchSettings {
  return {
    ...normalizeBaseSettings(raw),
    hasApiKey,
  };
}

export async function getWebSearchSettings(userId: string): Promise<WebSearchSettings> {
  const row = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY);
  const hasApiKey = await secretsSvc.validateSecret(userId, WEB_SEARCH_API_KEY_SECRET);
  return normalizeWebSearchSettings((row?.value as Partial<WebSearchSettingsInput> | undefined) ?? undefined, hasApiKey);
}

export async function getWebSearchApiKey(userId: string): Promise<string | null> {
  return secretsSvc.getSecret(userId, WEB_SEARCH_API_KEY_SECRET);
}

export async function putWebSearchSettings(userId: string, input: WebSearchSettingsInput): Promise<WebSearchSettings> {
  const current = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY)?.value as Partial<WebSearchSettingsInput> | undefined;
  const merged = normalizeBaseSettings({ ...current, ...input });

  settingsSvc.putSetting(userId, WEB_SEARCH_SETTINGS_KEY, merged);

  if (typeof input.apiKey === "string") {
    const trimmed = input.apiKey.trim();
    if (trimmed) {
      await secretsSvc.putSecret(userId, WEB_SEARCH_API_KEY_SECRET, trimmed);
    } else {
      secretsSvc.deleteSecret(userId, WEB_SEARCH_API_KEY_SECRET);
    }
  } else if (input.apiKey === null) {
    secretsSvc.deleteSecret(userId, WEB_SEARCH_API_KEY_SECRET);
  }

  return getWebSearchSettings(userId);
}

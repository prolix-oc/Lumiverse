import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";

export const WEB_SEARCH_SETTINGS_KEY = "webSearchSettings";
/** Legacy SearXNG key name; retained so existing installations keep working. */
export const WEB_SEARCH_API_KEY_SECRET = "web_search_api_key";
export const EXA_WEB_SEARCH_API_KEY_SECRET = "web_search_exa_api_key";
export const TAVILY_WEB_SEARCH_API_KEY_SECRET = "web_search_tavily_api_key";
export const EXA_SEARCH_API_URL = "https://api.exa.ai/search";
export const TAVILY_SEARCH_API_URL = "https://api.tavily.com/search";

export type WebSearchProvider = "searxng" | "exa" | "tavily";

/**
 * API keys are deliberately kept out of the user-settings JSON. Each
 * provider gets its own encrypted, user-scoped secret so switching providers
 * does not overwrite a credential that the user may switch back to later.
 */
export function webSearchApiKeySecretForProvider(provider: WebSearchProvider): string {
  if (provider === "exa") return EXA_WEB_SEARCH_API_KEY_SECRET;
  if (provider === "tavily") return TAVILY_WEB_SEARCH_API_KEY_SECRET;
  return WEB_SEARCH_API_KEY_SECRET;
}

/** Non-sensitive settings remembered independently for each provider. */
export interface WebSearchProviderProfile {
  apiUrl: string;
  requestTimeoutMs: number;
  defaultResultCount: number;
  maxResultCount: number;
  maxPagesToScrape: number;
  maxCharsPerPage: number;
  language: string;
  safeSearch: 0 | 1 | 2;
  engines: string[];
  inlineToolEnabled: boolean;
  /** Returned by GET only; the key itself remains encrypted and unreadable. */
  hasApiKey?: boolean;
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  apiUrl: string;
  requestTimeoutMs: number;
  defaultResultCount: number;
  maxResultCount: number;
  maxPagesToScrape: number;
  maxCharsPerPage: number;
  language: string;
  safeSearch: 0 | 1 | 2;
  engines: string[];
  /** Allow the primary model to call Lumiverse's selected web-search provider. */
  inlineToolEnabled: boolean;
  hasApiKey: boolean;
  /** Saved non-sensitive configuration for each provider. */
  providerProfiles?: Partial<Record<WebSearchProvider, WebSearchProviderProfile>>;
}

export interface WebSearchSettingsInput {
  enabled?: boolean;
  provider?: WebSearchProvider;
  apiUrl?: string;
  requestTimeoutMs?: number;
  defaultResultCount?: number;
  maxResultCount?: number;
  maxPagesToScrape?: number;
  maxCharsPerPage?: number;
  language?: string;
  safeSearch?: 0 | 1 | 2;
  engines?: string[];
  inlineToolEnabled?: boolean;
  providerProfiles?: Partial<Record<WebSearchProvider, WebSearchProviderProfile>>;
  apiKey?: string | null;
}

type NormalizedWebSearchSettings = Omit<WebSearchSettings, "hasApiKey" | "providerProfiles">;

const DEFAULT_SETTINGS: NormalizedWebSearchSettings = {
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
  inlineToolEnabled: false,
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

function normalizeProvider(value: unknown): WebSearchProvider {
  return value === "exa" || value === "tavily" ? value : "searxng";
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

function normalizeBaseSettings(raw: Partial<WebSearchSettingsInput> | null | undefined): NormalizedWebSearchSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const provider = normalizeProvider(merged.provider);
  const defaultResultCount = clampInt(merged.defaultResultCount, 1, 10, DEFAULT_SETTINGS.defaultResultCount);
  const maxResultCount = clampInt(merged.maxResultCount, defaultResultCount, 20, DEFAULT_SETTINGS.maxResultCount);

  return {
    enabled: !!merged.enabled,
    provider,
    // Hosted provider endpoints are fixed. Do not let a stale SearXNG URL get
    // used when a client switches providers without resetting apiUrl.
    apiUrl: provider === "exa"
      ? EXA_SEARCH_API_URL
      : provider === "tavily"
        ? TAVILY_SEARCH_API_URL
        : normalizeApiUrl(merged.apiUrl),
    requestTimeoutMs: clampInt(merged.requestTimeoutMs, 5_000, 120_000, DEFAULT_SETTINGS.requestTimeoutMs),
    defaultResultCount,
    maxResultCount,
    maxPagesToScrape: clampInt(merged.maxPagesToScrape, 1, 10, DEFAULT_SETTINGS.maxPagesToScrape),
    maxCharsPerPage: clampInt(merged.maxCharsPerPage, 500, 20_000, DEFAULT_SETTINGS.maxCharsPerPage),
    language: normalizeLanguage(merged.language),
    safeSearch: clampInt(merged.safeSearch, 0, 2, DEFAULT_SETTINGS.safeSearch) as 0 | 1 | 2,
    engines: normalizeEngines(merged.engines),
    inlineToolEnabled: merged.inlineToolEnabled === true,
  };
}

function toProviderProfile(settings: NormalizedWebSearchSettings): WebSearchProviderProfile {
  const { enabled: _enabled, provider: _provider, ...profile } = settings;
  return profile;
}

function normalizeProviderProfiles(raw: unknown): Partial<Record<WebSearchProvider, WebSearchProviderProfile>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const profiles: Partial<Record<WebSearchProvider, WebSearchProviderProfile>> = {};
  for (const provider of ["searxng", "exa", "tavily"] as const) {
    const profile = (raw as Record<string, unknown>)[provider];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
    profiles[provider] = toProviderProfile(normalizeBaseSettings({
      ...(profile as Partial<WebSearchSettingsInput>),
      provider,
    }));
  }
  return profiles;
}

function normalizeStoredWebSearchSettings(
  raw: Partial<WebSearchSettingsInput> | null | undefined,
): NormalizedWebSearchSettings & { providerProfiles: Partial<Record<WebSearchProvider, WebSearchProviderProfile>> } {
  const normalized = normalizeBaseSettings(raw);
  const providerProfiles = normalizeProviderProfiles(raw?.providerProfiles);
  // Existing installations have a single flat config. Seed its provider's
  // first profile lazily so upgrades do not need a data migration.
  if (!providerProfiles[normalized.provider]) {
    providerProfiles[normalized.provider] = toProviderProfile(normalized);
  }
  return { ...normalized, providerProfiles };
}

export function normalizeWebSearchSettings(
  raw: Partial<WebSearchSettingsInput> | null | undefined,
  hasApiKey: boolean,
): WebSearchSettings {
  return {
    ...normalizeStoredWebSearchSettings(raw),
    hasApiKey,
  };
}

export async function getWebSearchSettings(userId: string): Promise<WebSearchSettings> {
  const row = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY);
  const normalized = normalizeStoredWebSearchSettings((row?.value as Partial<WebSearchSettingsInput> | undefined) ?? undefined);
  const hasApiKey = await secretsSvc.validateSecret(userId, webSearchApiKeySecretForProvider(normalized.provider));
  const providerProfiles = Object.fromEntries(await Promise.all(
    Object.entries(normalized.providerProfiles).map(async ([provider, profile]) => [
      provider,
      {
        ...profile,
        hasApiKey: await secretsSvc.validateSecret(userId, webSearchApiKeySecretForProvider(provider as WebSearchProvider)),
      },
    ] as const),
  )) as Partial<Record<WebSearchProvider, WebSearchProviderProfile>>;
  return { ...normalized, hasApiKey, providerProfiles };
}

export async function getWebSearchApiKey(userId: string, provider: WebSearchProvider = "searxng"): Promise<string | null> {
  return secretsSvc.getSecret(userId, webSearchApiKeySecretForProvider(provider));
}

export async function putWebSearchSettings(userId: string, input: WebSearchSettingsInput): Promise<WebSearchSettings> {
  const currentRaw = settingsSvc.getSetting(userId, WEB_SEARCH_SETTINGS_KEY)?.value as Partial<WebSearchSettingsInput> | undefined;
  const current = normalizeStoredWebSearchSettings(currentRaw);
  const requestedProvider = normalizeProvider(input.provider ?? current.provider);
  const suppliedProfiles = normalizeProviderProfiles(input.providerProfiles);
  const providerProfiles = { ...current.providerProfiles, ...suppliedProfiles };
  const selectedProfile = providerProfiles[requestedProvider];
  const merged = normalizeBaseSettings({
    ...current,
    ...selectedProfile,
    ...input,
    provider: requestedProvider,
  });
  providerProfiles[requestedProvider] = toProviderProfile(merged);
  const persisted = { ...merged, providerProfiles };

  // Match connection creation semantics: persist the encrypted credential
  // first. If encryption/storage fails, do not report a configuration change
  // whose required provider key was never saved.
  if (typeof input.apiKey === "string") {
    const trimmed = input.apiKey.trim();
    if (trimmed) {
      await secretsSvc.putSecret(userId, webSearchApiKeySecretForProvider(persisted.provider), trimmed);
    } else {
      secretsSvc.deleteSecret(userId, webSearchApiKeySecretForProvider(persisted.provider));
    }
  } else if (input.apiKey === null) {
    secretsSvc.deleteSecret(userId, webSearchApiKeySecretForProvider(persisted.provider));
  }

  settingsSvc.putSetting(userId, WEB_SEARCH_SETTINGS_KEY, persisted);

  return getWebSearchSettings(userId);
}

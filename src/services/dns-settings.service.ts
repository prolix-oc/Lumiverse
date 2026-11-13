import { getFirstUserId } from "../auth/seed";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { InvalidSettingError, getSetting, putSetting } from "./settings.service";

export const DNS_SETTINGS_KEY = "dnsSettings";

/**
 * DNS resolver behaviour for SSRF validation. Most operators never need to
 * touch this — the defaults work everywhere the system resolver does. The
 * DoH fallback exists for environments where the system resolver can't see
 * custom TLDs (Termux on Android with `.spot`, Tailscale split-horizon, etc.)
 * but a public DoH endpoint can. See safe-fetch.ts for how this is consumed.
 */
export interface DnsSettings {
  dohFallbackEnabled?: boolean;
  dohEndpoint?: string;
}

export interface ResolvedDnsSettings {
  dohFallbackEnabled: boolean;
  dohEndpoint: string;
}

export interface DnsSettingsStatus {
  settingsKey: typeof DNS_SETTINGS_KEY;
  configuredSettings: DnsSettings;
  effectiveSettings: ResolvedDnsSettings;
  defaults: ResolvedDnsSettings;
}

const DEFAULT_DNS_SETTINGS: ResolvedDnsSettings = {
  dohFallbackEnabled: false,
  // IP literal so the DoH lookup itself doesn't require DNS. Cloudflare's
  // cert covers both `1.1.1.1` and `cloudflare-dns.com`, so TLS verifies.
  dohEndpoint: "https://1.1.1.1/dns-query",
};

let currentConfiguredSettings: DnsSettings = {};
let currentEffectiveSettings: ResolvedDnsSettings = { ...DEFAULT_DNS_SETTINGS };
let initialized = false;

function normalizeEndpoint(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidSettingError("DoH endpoint must be a string");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidSettingError("DoH endpoint is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidSettingError("DoH endpoint must use https://");
  }
  return parsed.toString();
}

export function normalizeDnsSettings(input: unknown): DnsSettings {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSettingError("DNS settings must be an object");
  }
  const raw = input as Record<string, unknown>;
  const out: DnsSettings = {};

  if (raw.dohFallbackEnabled != null) {
    if (typeof raw.dohFallbackEnabled !== "boolean") {
      throw new InvalidSettingError("dohFallbackEnabled must be a boolean");
    }
    out.dohFallbackEnabled = raw.dohFallbackEnabled;
  }

  const endpoint = normalizeEndpoint(raw.dohEndpoint);
  if (endpoint) out.dohEndpoint = endpoint;

  return out;
}

function resolveDnsSettings(configured: DnsSettings | null | undefined): ResolvedDnsSettings {
  return {
    dohFallbackEnabled: configured?.dohFallbackEnabled ?? DEFAULT_DNS_SETTINGS.dohFallbackEnabled,
    dohEndpoint: configured?.dohEndpoint ?? DEFAULT_DNS_SETTINGS.dohEndpoint,
  };
}

function loadStoredDnsSettings(userId: string | null): DnsSettings {
  if (!userId) return {};
  const stored = getSetting(userId, DNS_SETTINGS_KEY)?.value;
  return normalizeDnsSettings(stored);
}

export function applyDnsSettings(configured: DnsSettings | null | undefined): DnsSettingsStatus {
  const normalized = normalizeDnsSettings(configured ?? {});
  currentConfiguredSettings = { ...normalized };
  currentEffectiveSettings = resolveDnsSettings(normalized);
  return getDnsSettingsStatus();
}

export function loadAndApplyDnsSettings(userId: string | null = getFirstUserId()): DnsSettingsStatus {
  return applyDnsSettings(loadStoredDnsSettings(userId));
}

export function getDnsSettingsStatus(): DnsSettingsStatus {
  return {
    settingsKey: DNS_SETTINGS_KEY,
    configuredSettings: { ...currentConfiguredSettings },
    effectiveSettings: { ...currentEffectiveSettings },
    defaults: { ...DEFAULT_DNS_SETTINGS },
  };
}

/**
 * Read-only accessor for the current effective settings. safe-fetch.ts calls
 * this on every validation to pick up live changes without having to subscribe
 * to events itself.
 */
export function getEffectiveDnsSettings(): ResolvedDnsSettings {
  return currentEffectiveSettings;
}

export function putDnsSettings(userId: string, input: unknown): DnsSettingsStatus {
  const normalized = normalizeDnsSettings(input);
  putSetting(userId, DNS_SETTINGS_KEY, normalized);
  return applyDnsSettings(normalized);
}

export function initDnsSettings(): void {
  if (initialized) return;
  initialized = true;

  loadAndApplyDnsSettings();

  eventBus.on(EventType.SETTINGS_UPDATED, (event) => {
    const ownerUserId = getFirstUserId();
    if (!ownerUserId || event.userId !== ownerUserId) return;

    const payload = event.payload as { key?: string; keys?: string[] } | undefined;
    if (!payload) return;

    const changed = payload.key === DNS_SETTINGS_KEY
      || (Array.isArray(payload.keys) && payload.keys.includes(DNS_SETTINGS_KEY));
    if (!changed) return;

    try {
      loadAndApplyDnsSettings(ownerUserId);
    } catch (err) {
      console.error("[dns-settings] Failed to apply updated settings:", err);
      applyDnsSettings({});
    }
  });
}

import { networkInterfaces, hostname as osHostname } from "node:os";
import { promises as dnsPromises } from "node:dns";
import { env } from "../env";
import { getFirstUserId } from "../auth/seed";
import { getSetting, putSetting } from "./settings.service";

export const TRUSTED_HOSTS_SETTING_KEY = "trustedHosts";

export interface TrustedHostEntry {
  /** Lowercase host, usually `host:port`; IPv6 is wrapped in brackets. */
  host: string;
  /** How we learned about the host. Used only by the suggestions endpoint. */
  source: "hostname" | "mdns" | "reverse-dns" | "tailscale" | "lan-ip" | "env" | "configured";
}

export interface TrustedHostsSnapshot {
  configured: string[];
  baseline: TrustedHostEntry[];
}

export interface TrustedHostsSuggestions {
  hostname: string;
  suggestions: TrustedHostEntry[];
}

// Matches letters, digits, dots, hyphens, underscores; plus bracketed IPv6. No
// wildcards, no paths, no schemes. Port is added by normalization below.
const HOSTNAME_PATTERN = /^(?:\[[0-9a-f:%.]+\]|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/i;
const MAX_CONFIGURED_HOSTS = 32;
const REVERSE_LOOKUP_TIMEOUT_MS = 1500;
const TAILSCALE_TIMEOUT_MS = 2000;
const SUGGESTIONS_CACHE_TTL_MS = 60_000;

let networkInterfacesWarned = false;
let suggestionsCache: { value: TrustedHostsSuggestions; expiresAt: number } | null = null;
let suggestionsInFlight: Promise<TrustedHostsSuggestions> | null = null;

// Termux/Android sandboxes deny getifaddrs() (EACCES). Treat enumeration as
// best-effort so a missing LAN-IP list doesn't crash the server at startup.
function safeNetworkInterfaces(): ReturnType<typeof networkInterfaces> {
  try {
    return networkInterfaces();
  } catch (err) {
    if (!networkInterfacesWarned) {
      networkInterfacesWarned = true;
      console.warn("[trusted-hosts] Could not enumerate network interfaces:", (err as Error)?.message ?? err);
    }
    return {};
  }
}

export class InvalidTrustedHostError extends Error {
  status = 400 as const;
  constructor(message: string) { super(message); }
}

interface NormalizedTrustedInput {
  /** Persisted/display value. Host entries are `host:port`; explicit origins keep their scheme. */
  value: string;
  /** Host-header value to allow. */
  host: string;
  /** Origin values to allow for this entry. */
  origins: string[];
}

// ─── Normalization / validation ─────────────────────────────────────────────

function originForExplicitUrl(input: string): NormalizedTrustedInput | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidTrustedHostError(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) {
    throw new InvalidTrustedHostError(`Credentials are not allowed in trusted host URLs: ${input}`);
  }

  const host = parsed.host.toLowerCase();
  if (!HOSTNAME_PATTERN.test(parsed.hostname) && !HOSTNAME_PATTERN.test(`[${parsed.hostname}]`)) {
    throw new InvalidTrustedHostError(`Invalid hostname: ${input}`);
  }

  const origin = parsed.origin.toLowerCase();
  return { value: origin, host, origins: [origin] };
}

function normalizeTrustedInput(input: string): NormalizedTrustedInput {
  if (typeof input !== "string") {
    throw new InvalidTrustedHostError("Host must be a string");
  }

  const explicitOrigin = originForExplicitUrl(input);
  if (explicitOrigin) return explicitOrigin;

  let value = input.trim();
  if (!value) throw new InvalidTrustedHostError("Host cannot be empty");

  // Strip scheme + path. We tolerate users pasting full URLs.
  value = value.replace(/^https?:\/\//i, "");
  const slash = value.indexOf("/");
  if (slash >= 0) value = value.slice(0, slash);

  if (value.includes("*") || value.includes("?")) {
    throw new InvalidTrustedHostError("Wildcards are not allowed — list each hostname explicitly");
  }

  // Split host + port. IPv6 hosts are wrapped in brackets.
  let host: string;
  let portStr: string | null = null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) throw new InvalidTrustedHostError(`Malformed IPv6 literal: ${input}`);
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest.startsWith(":")) portStr = rest.slice(1);
    else if (rest.length > 0) throw new InvalidTrustedHostError(`Unexpected characters after IPv6 literal: ${input}`);
  } else {
    const lastColon = value.lastIndexOf(":");
    if (lastColon >= 0 && value.indexOf(":") === lastColon) {
      host = value.slice(0, lastColon);
      portStr = value.slice(lastColon + 1);
    } else if (lastColon < 0) {
      host = value;
    } else {
      // Multiple colons + no brackets — probably a bare IPv6, re-wrap it.
      host = `[${value}]`;
    }
  }

  if (!host) throw new InvalidTrustedHostError(`Host cannot be empty: ${input}`);
  if (!HOSTNAME_PATTERN.test(host)) {
    throw new InvalidTrustedHostError(`Invalid hostname: ${input}`);
  }

  let port: number;
  if (portStr == null || portStr === "") {
    port = env.port;
  } else {
    const parsed = Number.parseInt(portStr, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      throw new InvalidTrustedHostError(`Invalid port in ${input}: must be 1..65535`);
    }
    port = parsed;
  }

  const normalizedHost = `${host.toLowerCase()}:${port}`;
  return {
    value: normalizedHost,
    host: normalizedHost,
    origins: [`http://${normalizedHost}`, `https://${normalizedHost}`],
  };
}

/**
 * Accepts user-entered values like "machine", "machine:7860",
 * "https://app.example.com", "machine.tailnet.ts.net", "[::1]:7860". Returns a normalized
 * lowercase entry suitable for persistence, or throws InvalidTrustedHostError.
 * Port defaults to env.port when omitted, except explicit URL origins are
 * preserved so reverse-proxy HTTPS origins can be allowlisted exactly.
 */
export function normalizeHost(input: string): string {
  return normalizeTrustedInput(input).value;
}

// ─── Baseline (env-derived, always trusted) ─────────────────────────────────

function baselineEntries(): TrustedHostEntry[] {
  const seen = new Set<string>();
  const out: TrustedHostEntry[] = [];
  const add = (host: string, source: TrustedHostEntry["source"]) => {
    if (seen.has(host)) return;
    seen.add(host);
    out.push({ host, source });
  };

  add(`localhost:${env.port}`, "env");
  add(`127.0.0.1:${env.port}`, "env");
  add(`[::1]:${env.port}`, "env");

  for (const origin of env.trustedOrigins) {
    try {
      add(new URL(origin).host.toLowerCase(), "env");
    } catch { /* skip malformed */ }
  }

  for (const iface of Object.values(safeNetworkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.internal) continue;
      if (addr.family === "IPv4") {
        add(`${addr.address}:${env.port}`, "lan-ip");
      } else if (addr.family === "IPv6") {
        const clean = addr.address.split("%")[0];
        add(`[${clean}]:${env.port}`, "lan-ip");
      }
    }
  }

  return out;
}

// ─── State ──────────────────────────────────────────────────────────────────

let configuredHosts: string[] = [];
let configuredTrustedInputs: NormalizedTrustedInput[] = [];
let allowedHosts = new Set<string>();
let allowedOrigins = new Set<string>();
let loaded = false;

function rebuildCaches(): void {
  const baseline = baselineEntries();
  const hosts = new Set<string>();
  for (const e of baseline) hosts.add(e.host);
  for (const entry of configuredTrustedInputs) hosts.add(entry.host);

  const origins = new Set<string>();
  for (const entry of baseline) {
    origins.add(`http://${entry.host}`);
    origins.add(`https://${entry.host}`);
  }
  for (const entry of configuredTrustedInputs) {
    for (const origin of entry.origins) origins.add(origin);
  }

  allowedHosts = hosts;
  allowedOrigins = origins;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function load(): void {
  const ownerId = getFirstUserId();
  configuredHosts = [];
  configuredTrustedInputs = [];
  if (ownerId) {
    try {
      const row = getSetting(ownerId, TRUSTED_HOSTS_SETTING_KEY);
      const raw = row?.value;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.hosts) ? raw.hosts : [];
      const seen = new Set<string>();
      for (const entry of list) {
        try {
          const normalized = normalizeTrustedInput(entry);
          if (seen.has(normalized.value)) continue;
          seen.add(normalized.value);
          configuredHosts.push(normalized.value);
          configuredTrustedInputs.push(normalized);
        } catch {
          // Skip malformed persisted entries rather than crashing startup.
        }
      }
    } catch (err) {
      console.warn("[trusted-hosts] Failed to read setting:", err);
    }
  }
  rebuildCaches();
  loaded = true;
}

function ensureLoaded(): void {
  if (!loaded) load();
}

export function getAllowedHosts(): ReadonlySet<string> {
  ensureLoaded();
  return allowedHosts;
}

export function getAllowedOrigins(): ReadonlySet<string> {
  ensureLoaded();
  return allowedOrigins;
}

export function isHostAllowed(host: string | null | undefined): boolean {
  if (!host) return false;
  return getAllowedHosts().has(host.toLowerCase());
}

export function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return getAllowedOrigins().has(origin.toLowerCase());
}

export function getSnapshot(): TrustedHostsSnapshot {
  ensureLoaded();
  return {
    configured: [...configuredHosts],
    baseline: baselineEntries(),
  };
}

export function setTrustedHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) {
    throw new InvalidTrustedHostError("Payload must be { hosts: string[] }");
  }
  if (hosts.length > MAX_CONFIGURED_HOSTS) {
    throw new InvalidTrustedHostError(
      `Too many trusted hosts (max ${MAX_CONFIGURED_HOSTS})`,
    );
  }
  // Persist against the server owner's settings row so that `load()` (which
  // also resolves via `getFirstUserId()`) sees the same value on restart.
  // Admins can reach this endpoint via `requireOwner`, but their own user row
  // would be invisible to startup load.
  const ownerId = getFirstUserId();
  if (!ownerId) {
    throw new InvalidTrustedHostError("Server owner is not initialized yet");
  }

  const baseline = new Set(baselineEntries().map((e) => e.host));
  const seen = new Set<string>();
  const normalized: string[] = [];
  const trustedInputs: NormalizedTrustedInput[] = [];
  for (const raw of hosts) {
    const entry = normalizeTrustedInput(String(raw));
    if (baseline.has(entry.host)) continue; // baseline is implicit, no need to persist
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    normalized.push(entry.value);
    trustedInputs.push(entry);
  }

  putSetting(ownerId, TRUSTED_HOSTS_SETTING_KEY, normalized);
  configuredHosts = normalized;
  configuredTrustedInputs = trustedInputs;
  rebuildCaches();
  return [...configuredHosts];
}

// ─── Suggestions ────────────────────────────────────────────────────────────

async function reverseLookup(ip: string, timeoutMs: number): Promise<string[]> {
  const stripped = ip.startsWith("[") ? ip.slice(1, -1).split("%")[0] : ip;
  try {
    const names = await Promise.race<string[]>([
      dnsPromises.reverse(stripped),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]);
    return names.map((n) => n.toLowerCase().replace(/\.$/, ""));
  } catch {
    return [];
  }
}

async function tailscaleSuggestion(timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeoutHandle = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, timeoutMs);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timeoutHandle);
    const code = await proc.exited;
    if (code !== 0 || !output) return null;
    const parsed = JSON.parse(output);
    const dnsName = typeof parsed?.Self?.DNSName === "string" ? parsed.Self.DNSName : null;
    if (!dnsName) return null;
    return dnsName.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

async function buildHostnameSuggestions(baseline?: TrustedHostEntry[]): Promise<TrustedHostsSuggestions> {
  const shortHostname = osHostname().toLowerCase();
  const seen = new Set<string>();
  const suggestions: TrustedHostEntry[] = [];
  const add = (host: string, source: TrustedHostEntry["source"]) => {
    try {
      const normalized = normalizeHost(host);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      suggestions.push({ host: normalized, source });
    } catch { /* skip invalid */ }
  };

  if (shortHostname) {
    add(shortHostname, "hostname");
    if (!shortHostname.includes(".")) {
      add(`${shortHostname}.local`, "mdns");
    }
  }

  // Collect non-internal IPs once, then reverse-resolve in parallel.
  const ips: string[] = [];
  const seenIps = new Set<string>();
  for (const iface of Object.values(safeNetworkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.internal) continue;
      if (addr.family === "IPv4") {
        if (!seenIps.has(addr.address)) {
          seenIps.add(addr.address);
          ips.push(addr.address);
        }
      } else if (addr.family === "IPv6") {
        const ip = `[${addr.address.split("%")[0]}]`;
        if (!seenIps.has(ip)) {
          seenIps.add(ip);
          ips.push(ip);
        }
      }
    }
  }
  const [reverseResults, tailscaleName] = await Promise.all([
    Promise.all(ips.map((ip) => reverseLookup(ip, REVERSE_LOOKUP_TIMEOUT_MS))),
    tailscaleSuggestion(TAILSCALE_TIMEOUT_MS),
  ]);
  for (const names of reverseResults) {
    for (const name of names) add(name, "reverse-dns");
  }

  if (tailscaleName) add(tailscaleName, "tailscale");

  // Drop anything that is already in the baseline — no need to suggest those.
  const baselineHosts = new Set((baseline ?? baselineEntries()).map((e) => e.host));
  const filtered = suggestions.filter((s) => !baselineHosts.has(s.host));

  return { hostname: shortHostname, suggestions: filtered };
}

export async function detectHostnameSuggestions(options?: {
  forceRefresh?: boolean;
  baseline?: TrustedHostEntry[];
}): Promise<TrustedHostsSuggestions> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && suggestionsCache && suggestionsCache.expiresAt > now) {
    return suggestionsCache.value;
  }

  if (suggestionsInFlight) {
    return suggestionsInFlight;
  }

  const promise = buildHostnameSuggestions(options?.baseline)
    .then((value) => {
      suggestionsCache = {
        value,
        expiresAt: Date.now() + SUGGESTIONS_CACHE_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      if (suggestionsInFlight === promise) {
        suggestionsInFlight = null;
      }
    });

  suggestionsInFlight = promise;
  return promise;
}

// ─── Test support ───────────────────────────────────────────────────────────

/** @internal Only intended for unit tests — resets in-memory state. */
export function _resetForTests(): void {
  configuredHosts = [];
  configuredTrustedInputs = [];
  allowedHosts = new Set();
  allowedOrigins = new Set();
  loaded = false;
  suggestionsCache = null;
  suggestionsInFlight = null;
}

/** @internal Only intended for unit tests — bypasses owner-backed persistence. */
export function _setTrustedHostsForTests(hosts: string[]): void {
  configuredHosts = [];
  configuredTrustedInputs = [];
  const seen = new Set<string>();
  for (const host of hosts) {
    const entry = normalizeTrustedInput(host);
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    configuredHosts.push(entry.value);
    configuredTrustedInputs.push(entry);
  }
  rebuildCaches();
  loaded = true;
}

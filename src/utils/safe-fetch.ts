/**
 * SSRF-safe fetch utility.
 *
 * Validates URLs before fetching to prevent requests to private/internal networks.
 * Resolves hostnames to IPs and checks against reserved ranges.
 * Follows redirects safely by re-validating each hop.
 */

import { lookup, resolve4, resolve6 } from "dns/promises";
import { dns as bunDns } from "bun";
import { getEffectiveDnsSettings } from "../services/dns-settings.service";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DOH_TIMEOUT_MS = 5_000;

// DNS record type codes used by RFC 8484 JSON DoH responses.
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFError";
  }
}

/**
 * Pin Bun's fetch DNS cache to the IPs we just validated. Without this,
 * validateHost() and the subsequent fetch() perform two independent DNS
 * lookups, leaving a TOCTOU window where a short-TTL record can flip a
 * public hostname to a private IP between checks. `Bun.dns.prefetch`
 * populates the same cache that fetch consults, closing that window for
 * the lifetime of the cached entry.
 */
function pinDnsCache(hostname: string, port: number): void {
  try {
    bunDns.prefetch(hostname, port);
  } catch {
    // prefetch is documented as experimental; if it ever throws (e.g. on
    // bare IPs), validation has already happened so we just skip pinning.
  }
}

// ─── Private IP detection ─────────────────────────────────────────────────

const PRIVATE_V4_RANGES: [number, number, number][] = [
  // [network, mask, bits]  — stored as 32-bit unsigned ints
  [0x7F000000, 0xFF000000, 8],   // 127.0.0.0/8
  [0x0A000000, 0xFF000000, 8],   // 10.0.0.0/8
  [0xAC100000, 0xFFF00000, 12],  // 172.16.0.0/12
  [0xC0A80000, 0xFFFF0000, 16],  // 192.168.0.0/16
  [0xA9FE0000, 0xFFFF0000, 16],  // 169.254.0.0/16
  [0x00000000, 0xFF000000, 8],   // 0.0.0.0/8
  [0xC0000000, 0xFFFFFFF8, 29],  // 192.0.0.0/29
  [0xC6120000, 0xFFFE0000, 15],  // 198.18.0.0/15  (benchmarking)
  [0xE0000000, 0xF0000000, 4],   // 224.0.0.0/4    (multicast)
  [0xF0000000, 0xF0000000, 4],   // 240.0.0.0/4    (reserved)
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  for (const [network, mask] of PRIVATE_V4_RANGES) {
    if (((addr & mask) >>> 0) === network) return true;
  }
  return false;
}

function isLoopbackIPv4(ip: string): boolean {
  return ((ipv4ToInt(ip) & 0xFF000000) >>> 0) === 0x7F000000;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback
  if (normalized === "::1") return true;

  // IPv4-mapped: ::ffff:x.x.x.x
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);

  // Unique local (fc00::/7 → fc and fd prefixes)
  if (/^f[cd]/.test(normalized)) return true;

  // Link-local (fe80::/10)
  if (/^fe[89ab]/.test(normalized)) return true;

  // Unspecified
  if (normalized === "::") return true;

  return false;
}

function isLoopbackIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;

  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return v4Mapped ? isLoopbackIPv4(v4Mapped[1]) : false;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

// ─── DNS resolution + validation ──────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/g, "");
}

function isLocalhostName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Fallback resolver for environments where the system DNS resolver can't
 * see a hostname but a public DoH endpoint can (Termux + custom TLDs,
 * Tailscale split-horizon, etc.). Off by default; toggled in the Operator
 * panel via `dnsSettings.dohFallbackEnabled`.
 *
 * Uses Cloudflare's RFC 8484 JSON wire format and contacts the endpoint by
 * its configured URL — defaults to `https://1.1.1.1/dns-query` so DoH itself
 * needs no DNS to bootstrap. We call plain `fetch` (not `safeFetch`) on
 * purpose: the destination is the operator-configured DoH endpoint, and
 * safeFetch would recurse back through validateHost.
 */
async function resolveViaDoh(
  hostname: string,
  endpoint: string,
  timeoutMs: number
): Promise<{ v4: string[]; v6: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const query = async (type: typeof DNS_TYPE_A | typeof DNS_TYPE_AAAA): Promise<string[]> => {
    const url = new URL(endpoint);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type === DNS_TYPE_A ? "A" : "AAAA");
    const res = await fetch(url.toString(), {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as
      | { Status?: number; Answer?: Array<{ type?: number; data?: string }> }
      | null;
    if (!body || body.Status !== 0 || !Array.isArray(body.Answer)) return [];
    const ips: string[] = [];
    for (const ans of body.Answer) {
      if (ans.type === type && typeof ans.data === "string") ips.push(ans.data);
    }
    return ips;
  };

  try {
    const [v4, v6] = await Promise.all([
      query(DNS_TYPE_A).catch(() => [] as string[]),
      query(DNS_TYPE_AAAA).catch(() => [] as string[]),
    ]);
    return { v4, v6 };
  } finally {
    clearTimeout(timer);
  }
}

export interface ValidateHostOptions {
  /** Allow loopback IP literals and RFC-localhost names, but not LAN/private ranges. */
  allowLoopback?: boolean;
  allowPrivate?: boolean;
  /**
   * Hard ceiling on total DNS resolution time. Without this, environments
   * whose system resolver doesn't know a TLD (e.g. Termux on Android with
   * custom TLDs like `.spot`) can stall for several minutes while resolve4,
   * resolve6, and lookup each time out independently. Defaults to 5s.
   */
  dnsTimeoutMs?: number;
}

function allowsLoopback(options?: ValidateHostOptions): boolean {
  return Boolean(options?.allowLoopback || options?.allowPrivate);
}

export async function validateHost(hostname: string, options?: ValidateHostOptions): Promise<void> {
  hostname = normalizeHostname(hostname);

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SSRFError(`Blocked hostname: ${hostname}`);
  }

  if (isLocalhostName(hostname)) {
    if (allowsLoopback(options)) return;
    throw new SSRFError(`URL resolves to private IP: ${hostname}`);
  }

  // If hostname is already an IP literal, check directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (allowsLoopback(options) && isLoopbackIPv4(hostname)) return;
    if (options?.allowPrivate && isPrivateIPv4(hostname)) return;
    if (isPrivateIPv4(hostname)) {
      throw new SSRFError(`URL resolves to private IP: ${hostname}`);
    }
    return;
  }
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (allowsLoopback(options) && isLoopbackIPv6(bare)) return;
    if (options?.allowPrivate && isPrivateIPv6(bare)) return;
    if (isPrivateIPv6(bare)) {
      throw new SSRFError(`URL resolves to private IP: ${bare}`);
    }
    return;
  }

  // Run resolve4, resolve6, and lookup in parallel and race the whole stage
  // against a hard timeout. Sequencing these would let a single hung resolver
  // block the others — on Termux that adds up to ~5 minutes per request.
  const dnsTimeoutMs = options?.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const v4Addrs = new Set<string>();
  const v6Addrs = new Set<string>();

  const resolvers = [
    resolve4(hostname).then(
      (addrs) => addrs.forEach((a) => v4Addrs.add(a)),
      () => { /* no A records, or resolver doesn't know this name */ }
    ),
    resolve6(hostname).then(
      (addrs) => addrs.forEach((a) => v6Addrs.add(a)),
      () => { /* no AAAA records */ }
    ),
    lookup(hostname, { all: true }).then(
      (addrs) => {
        for (const a of addrs) {
          if (a.family === 4) v4Addrs.add(a.address);
          else if (a.family === 6) v6Addrs.add(a.address);
        }
      },
      () => { /* system resolver doesn't know this name */ }
    ),
  ];

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve();
    }, dnsTimeoutMs);
  });

  try {
    await Promise.race([Promise.allSettled(resolvers), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // Local resolvers came back empty — NXDOMAIN-equivalent or they timed
  // out. If the operator turned on DoH fallback, ask Cloudflare (or whatever
  // they configured). Termux/.spot escape hatch.
  //
  // Heads-up if you're debugging this later: DoH only fixes validation.
  // The fetch() that safeFetch fires below still does its own DNS lookup.
  // We get away with it because Bun's fetch goes through libcurl (probably
  // ending up at Bionic getaddrinfo, which honors Android's Private DNS),
  // while dns/promises hits c-ares against Termux's hardcoded resolv.conf.
  // Two different worlds. PR author confirmed plain fetch() works on their
  // device, so we're banking on that. If someone shows up saying "DoH on
  // but it still hangs" — yeah, the assumption broke. Least-bad fix is
  // probably to skip safeFetch at the callsite when DoH succeeded, since
  // we just validated the IP. Custom lookup-into-fetch is dead (bun#27890
  // breaks TLS), URL→IP rewriting is dead (breaks SNI). Sorry.
  if (v4Addrs.size === 0 && v6Addrs.size === 0) {
    const dns = getEffectiveDnsSettings();
    if (dns.dohFallbackEnabled) {
      try {
        const doh = await resolveViaDoh(hostname, dns.dohEndpoint, DOH_TIMEOUT_MS);
        doh.v4.forEach((a) => v4Addrs.add(a));
        doh.v6.forEach((a) => v6Addrs.add(a));
      } catch {
        // DoH itself failed (network down, endpoint unreachable). Fall
        // through to the standard resolution error below.
      }
    }
  }

  if (v4Addrs.size === 0 && v6Addrs.size === 0) {
    throw new SSRFError(
      timedOut
        ? `DNS resolution timed out after ${dnsTimeoutMs}ms for hostname: ${hostname}`
        : `Could not resolve hostname: ${hostname}`
    );
  }

  for (const ip of v4Addrs) {
    if (allowsLoopback(options) && isLoopbackIPv4(ip)) continue;
    if (options?.allowPrivate && isPrivateIPv4(ip)) continue;
    if (isPrivateIPv4(ip)) {
      throw new SSRFError(`URL resolves to private IP: ${ip} (from ${hostname})`);
    }
  }

  for (const ip of v6Addrs) {
    if (allowsLoopback(options) && isLoopbackIPv6(ip)) continue;
    if (options?.allowPrivate && isPrivateIPv6(ip)) continue;
    if (isPrivateIPv6(ip)) {
      throw new SSRFError(`URL resolves to private IP: ${ip} (from ${hostname})`);
    }
  }
}

// ─── safeFetch ────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: string;
  body?: BodyInit | null;
  maxBytes?: number;
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  headers?: HeadersInit;
  allowLoopback?: boolean;
  allowPrivate?: boolean;
}

export async function safeFetch(
  url: string,
  options?: SafeFetchOptions
): Promise<Response> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  let currentUrl = url;
  let method = options?.method ?? "GET";
  let body = options?.body ?? null;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SSRFError(`Invalid URL: ${currentUrl}`);
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SSRFError(`Only http and https URLs are allowed, got: ${parsed.protocol}`);
    }

    await validateHost(parsed.hostname, {
      allowLoopback: options?.allowLoopback,
      allowPrivate: options?.allowPrivate,
      dnsTimeoutMs: options?.dnsTimeoutMs,
    });
    // Warm Bun's DNS cache with the validated answer so the connect() that
    // fetch performs immediately below does not re-resolve and potentially
    // hit a flipped record.
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    pinDnsCache(parsed.hostname, port);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        body,
        redirect: "manual",
        signal: controller.signal,
        headers: options?.headers,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new SSRFError(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects manually so we can re-validate each hop
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SSRFError(`Redirect with no Location header (status ${response.status})`);
      }
      // Resolve relative redirects
      const previousUrl = currentUrl;
      currentUrl = new URL(location, currentUrl).toString();
      const upperMethod = method.toUpperCase();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && upperMethod === "POST")) {
        method = "GET";
        body = null;
      }
      if (new URL(previousUrl).origin !== new URL(currentUrl).origin && options?.headers) {
        const redirectedHeaders = new Headers(options.headers);
        redirectedHeaders.delete("authorization");
        redirectedHeaders.delete("cookie");
        redirectedHeaders.delete("proxy-authorization");
        options = { ...options, headers: redirectedHeaders };
      }
      continue;
    }

    // Enforce response size limit
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new SSRFError(`Response too large: ${contentLength} bytes (max ${maxBytes})`);
    }

    return response;
  }

  throw new SSRFError(`Too many redirects (max ${MAX_REDIRECTS})`);
}

/**
 * SSRF-safe fetch utility.
 *
 * Validates URLs before fetching to prevent requests to private/internal networks.
 * Resolves hostnames to IPs and checks against reserved ranges.
 * Follows redirects safely by re-validating each hop.
 */

import { lookup, resolve4, resolve6 } from "dns/promises";
import { isIP } from "node:net";
import { dns as bunDns } from "bun";
import { getEffectiveDnsSettings } from "../services/dns-settings.service";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_USER_AGENT = (() => {
  try {
    const pkg = require("../../package.json") as { version?: string };
    const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "unknown";
    return `Lumiverse/${version}`;
  } catch {
    return "Lumiverse/unknown";
  }
})();

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

function ipv6ToWords(ip: string): number[] | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) !== 6) return null;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let expanded = normalized;
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]);
    expanded = `${normalized.slice(0, -dotted[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length > 1 ? 8 - left.length - right.length : 0;
  if (zeros < 0 || (halves.length === 1 && left.length !== 8)) return null;
  return [...left, ...Array(zeros).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
}

function mappedIPv4(ip: string): string | null {
  const words = ipv6ToWords(ip);
  if (!words || words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return null;
  return `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
}

function isPrivateIPv6(ip: string): boolean {
  const words = ipv6ToWords(ip);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 0 || words[7] === 1)) return true;
  const mapped = mappedIPv4(ip);
  if (mapped) return isPrivateIPv4(mapped);
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return (words[0] & 0xffc0) === 0xfe80; // fe80::/10 link-local
}

function isLoopbackIPv6(ip: string): boolean {
  const words = ipv6ToWords(ip);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  const mapped = mappedIPv4(ip);
  return mapped ? isLoopbackIPv4(mapped) : false;
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
  signal?: AbortSignal;
  method?: string;
  body?: BodyInit | null;
  maxBytes?: number;
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  headers?: HeadersInit;
  allowLoopback?: boolean;
  allowPrivate?: boolean;
  /** Restrict the initial URL and every redirect hop to these exact origins. */
  allowedOrigins?: readonly string[];
}

export async function safeFetch(
  url: string,
  options?: SafeFetchOptions
): Promise<Response> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const allowedOrigins = options?.allowedOrigins
    ? new Set(options.allowedOrigins.map((origin) => new URL(origin).origin.toLowerCase()))
    : null;

  let currentUrl = url;
  let method = options?.method ?? "GET";
  let body = options?.body ?? null;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    options?.signal?.throwIfAborted();
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SSRFError(`Invalid URL: ${currentUrl}`);
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SSRFError(`Only http and https URLs are allowed, got: ${parsed.protocol}`);
    }
    if (allowedOrigins && !allowedOrigins.has(parsed.origin.toLowerCase())) {
      throw new SSRFError(`URL origin is not allowed: ${parsed.origin.toLowerCase()}`);
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      const headers = new Headers(options?.headers);
      if (!headers.get("user-agent")?.trim()) {
        headers.set("User-Agent", DEFAULT_USER_AGENT);
      }
      response = await fetch(currentUrl, {
        method,
        body,
        redirect: "manual",
        signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        headers,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new SSRFError(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    // Handle redirects manually so we can re-validate each hop
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
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

    // Check the declared size early, then cap the actual stream as servers can
    // omit or understate Content-Length (including on chunked responses).
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      clearTimeout(timer);
      throw new SSRFError(`Response too large: ${contentLength} bytes (max ${maxBytes})`);
    }
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    const reader = response.body.getReader();
    let received = 0;
    const clearBodyTimer = () => clearTimeout(timer);
    const limitedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearBodyTimer();
            controller.close();
            reader.releaseLock();
            return;
          }
          received += value.byteLength;
          if (received > maxBytes) {
            clearBodyTimer();
            await reader.cancel();
            controller.error(new SSRFError(`Response too large: more than ${maxBytes} bytes`));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          clearBodyTimer();
          controller.error(timedOut ? new SSRFError(`Request timed out after ${timeoutMs}ms`) : error);
        }
      },
      async cancel(reason) {
        clearBodyTimer();
        await reader.cancel(reason);
      },
    });
    return new Response(limitedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  throw new SSRFError(`Too many redirects (max ${MAX_REDIRECTS})`);
}

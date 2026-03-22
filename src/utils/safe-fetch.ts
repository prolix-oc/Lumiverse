/**
 * SSRF-safe fetch utility.
 *
 * Validates URLs before fetching to prevent requests to private/internal networks.
 * Resolves hostnames to IPs and checks against reserved ranges.
 * Follows redirects safely by re-validating each hop.
 */

import { lookup, resolve4, resolve6 } from "dns/promises";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFError";
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
    if ((addr & mask) === network) return true;
  }
  return false;
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

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

// ─── DNS resolution + validation ──────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

export async function validateHost(hostname: string): Promise<void> {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new SSRFError(`Blocked hostname: ${hostname}`);
  }

  // If hostname is already an IP literal, check directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      throw new SSRFError(`URL resolves to private IP: ${hostname}`);
    }
    return;
  }
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIPv6(bare)) {
      throw new SSRFError(`URL resolves to private IP: ${bare}`);
    }
    return;
  }

  // Resolve and check all IPs
  let v4Addrs: string[] = [];
  let v6Addrs: string[] = [];

  try {
    v4Addrs = await resolve4(hostname);
  } catch {
    // No A records — that's fine, try AAAA
  }

  try {
    v6Addrs = await resolve6(hostname);
  } catch {
    // No AAAA records
  }

  if (v4Addrs.length === 0 && v6Addrs.length === 0) {
    try {
      const lookupAddrs = await lookup(hostname, { all: true });
      for (const addr of lookupAddrs) {
        if (addr.family === 4) v4Addrs.push(addr.address);
        if (addr.family === 6) v6Addrs.push(addr.address);
      }
    } catch {
      // Fall through to the standard resolution error below.
    }
  }

  if (v4Addrs.length === 0 && v6Addrs.length === 0) {
    throw new SSRFError(`Could not resolve hostname: ${hostname}`);
  }

  for (const ip of v4Addrs) {
    if (isPrivateIPv4(ip)) {
      throw new SSRFError(`URL resolves to private IP: ${ip} (from ${hostname})`);
    }
  }

  for (const ip of v6Addrs) {
    if (isPrivateIPv6(ip)) {
      throw new SSRFError(`URL resolves to private IP: ${ip} (from ${hostname})`);
    }
  }
}

// ─── safeFetch ────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function safeFetch(
  url: string,
  options?: SafeFetchOptions
): Promise<Response> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  let currentUrl = url;

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

    await validateHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
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
      currentUrl = new URL(location, currentUrl).toString();
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

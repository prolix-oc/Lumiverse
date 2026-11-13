import { isIP } from "node:net";

import { isPrivateIp } from "../../utils/safe-fetch";

const LOCAL_EXACT_HOSTS = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
]);

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

/**
 * Normalize a provider endpoint to `scheme://host[:port]` so two requests to
 * the same server compare equal regardless of path, query, or casing.
 *
 * Returns null for anything that is not an absolute HTTP(S) URL. A bare
 * `host:port` is accepted for convenience and treated as `http://`.
 */
export function normalizeEndpointOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
}

function bareHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * True when the origin targets the same machine or the local network.
 * `includePrivateNetwork` only relaxes RFC1918 / ULA / link-local matching;
 * loopback and mDNS-style hostnames are always local.
 */
export function isLocalEndpointOrigin(origin: string, includePrivateNetwork = true): boolean {
  let hostname: string;
  try {
    hostname = bareHostname(new URL(origin).hostname);
  } catch {
    return false;
  }

  if (!hostname) return false;
  if (hostname === "::1") return true;
  if (LOCAL_EXACT_HOSTS.has(hostname)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) return true;
  if (/^127\./.test(hostname)) return true;
  if (!includePrivateNetwork) return false;
  // `isPrivateIp` assumes an IP literal; hostnames must never reach it because
  // its numeric conversion maps non-IP strings to 0.0.0.0 (which is in a
  // private CIDR).
  if (isIP(hostname) === 0) return false;
  return isPrivateIp(hostname);
}

/** Host displays without the scheme; used for compact diagnostics labels. */
export function formatOriginLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return origin;
  }
}

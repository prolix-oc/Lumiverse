import { getConnInfo } from "hono/bun";
import type { Context } from "hono";

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function normalizeIpToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = stripQuotes(String(raw).trim());
  if (!value || /^unknown$/i.test(value)) return null;

  if (/^for=/i.test(value)) {
    value = stripQuotes(value.slice(4).trim());
  }

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close > 0) {
      value = value.slice(1, close);
    }
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }

  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(value)) {
    value = value.slice(7);
  }

  const lower = value.toLowerCase();
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower);
  const isIpv6 = /^[0-9a-f:]+$/i.test(lower) && lower.includes(":");
  return isIpv4 || isIpv6 ? lower : null;
}

function parseForwardedHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    for (const token of part.split(";")) {
      const [key, ...rest] = token.split("=");
      if (key?.trim().toLowerCase() !== "for") continue;
      const candidate = normalizeIpToken(rest.join("="));
      if (candidate) return candidate;
    }
  }
  return null;
}

function parseXForwardedFor(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const candidate = normalizeIpToken(part);
    if (candidate) return candidate;
  }
  return null;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
}

function shouldTrustForwarded(remoteIp: string | null): boolean {
  if (!remoteIp) return false;
  return remoteIp.includes(":") ? isPrivateIpv6(remoteIp) : isPrivateIpv4(remoteIp);
}

export function getConnectionIp(c: Context): string | null {
  try {
    return normalizeIpToken(getConnInfo(c).remote.address ?? null);
  } catch {
    return null;
  }
}

export function getClientIp(c: Context): string {
  const remoteIp = getConnectionIp(c);
  if (shouldTrustForwarded(remoteIp)) {
    const forwarded =
      parseForwardedHeader(c.req.header("forwarded")) ||
      parseXForwardedFor(c.req.header("x-forwarded-for")) ||
      normalizeIpToken(c.req.header("x-real-ip"));
    if (forwarded) return forwarded;
  }
  return remoteIp ?? "unknown";
}

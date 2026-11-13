import { createHash } from "node:crypto";
import { env } from "../env";
import { getEncryptionKeyHex } from "../crypto/init";

export const DESKTOP_OAUTH_CLIENT_ID = "lumiverse-desktop";
export const DESKTOP_STATUS_SCOPE = "desktop:instance-status:read";
export const DESKTOP_OAUTH_RESOURCE = "urn:lumiverse:desktop-api";
export const DESKTOP_OAUTH_FALLBACK_ORIGIN = `http://localhost:${env.port}`;

function normalizeConfiguredOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const parsed = new URL(value.trim());
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("AUTH_BASE_URL must be an HTTP(S) origin without a path, query, or credentials");
  }
  return parsed.origin;
}

/** Optional single-origin override. Otherwise Better Auth resolves an approved host per request. */
export const DESKTOP_OAUTH_CONFIGURED_ORIGIN = normalizeConfiguredOrigin(
  process.env.AUTH_BASE_URL,
);

export function getDesktopOAuthIssuer(origin: string): string {
  return new URL("/api/auth", `${origin.replace(/\/$/, "")}/`).toString().replace(/\/$/, "");
}

/** Stable, non-secret identifier derived from the installation identity. */
export function getDesktopServerInstanceId(): string {
  return `lvdi_${createHash("sha256")
    .update("lumiverse-desktop-instance-v1\0", "utf8")
    .update(getEncryptionKeyHex(), "utf8")
    .digest("base64url")
    .slice(0, 32)}`;
}

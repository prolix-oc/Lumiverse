/**
 * Runtime guards for inbound LumiHub WebSocket payloads.
 *
 * The WS protocol is JSON-over-WS with no schema enforcement on the wire, so
 * a compromised LumiHub server (or a future protocol mismatch) can otherwise
 * smuggle oversized strings, gigantic galleryImageUrls arrays, or bogus
 * `importUrl` schemes that would reach the installer.
 */

import type { InstallCharacterPayload, InstallWorldbookPayload } from "./types";

const MAX_STRING_LEN = 64 * 1024; // 64 KB per string field
const MAX_CARD_DATA_BYTES = 4 * 1024 * 1024; // 4 MB JSON-blob ceiling
const MAX_AVATAR_BASE64_BYTES = 12 * 1024 * 1024; // base64 expands ~33% — caps raw at ~9 MB
const MAX_GALLERY_URLS = 50;
const MAX_WORLDBOOK_ENTRIES = 5_000;
const ALLOWED_SOURCES = new Set(["lumihub", "chub"] as const);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max = MAX_STRING_LEN): value is string {
  return typeof value === "string" && value.length <= max;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateInstallCharacterPayload(
  raw: unknown,
): ValidationResult<InstallCharacterPayload> {
  if (!isPlainObject(raw)) return { ok: false, error: "payload must be an object" };

  if (!ALLOWED_SOURCES.has(raw.source as "lumihub" | "chub")) {
    return { ok: false, error: "source must be 'lumihub' or 'chub'" };
  }
  if (!isString(raw.characterId, 256)) {
    return { ok: false, error: "characterId must be a string ≤256 chars" };
  }
  if (!isString(raw.characterName, 512)) {
    return { ok: false, error: "characterName must be a string ≤512 chars" };
  }

  if (raw.cardData !== undefined) {
    if (!isPlainObject(raw.cardData)) return { ok: false, error: "cardData must be an object" };
    // Cap the serialized card size — defends against giant nested cards.
    const serializedSize = JSON.stringify(raw.cardData).length;
    if (serializedSize > MAX_CARD_DATA_BYTES) {
      return { ok: false, error: `cardData exceeds ${MAX_CARD_DATA_BYTES} bytes` };
    }
  }

  if (raw.avatarBase64 !== undefined) {
    if (typeof raw.avatarBase64 !== "string" || raw.avatarBase64.length > MAX_AVATAR_BASE64_BYTES) {
      return { ok: false, error: `avatarBase64 must be a string ≤${MAX_AVATAR_BASE64_BYTES} chars` };
    }
  }
  if (raw.avatarMime !== undefined && !isString(raw.avatarMime, 128)) {
    return { ok: false, error: "avatarMime must be a string ≤128 chars" };
  }
  if (raw.importUrl !== undefined && !isHttpUrl(raw.importUrl)) {
    return { ok: false, error: "importUrl must be an http(s) URL" };
  }
  if (raw.importEmbeddedWorldbook !== undefined && typeof raw.importEmbeddedWorldbook !== "boolean") {
    return { ok: false, error: "importEmbeddedWorldbook must be a boolean" };
  }
  if (raw.chubSlug !== undefined && !isString(raw.chubSlug, 512)) {
    return { ok: false, error: "chubSlug must be a string ≤512 chars" };
  }

  if (raw.galleryImageUrls !== undefined) {
    if (!Array.isArray(raw.galleryImageUrls)) {
      return { ok: false, error: "galleryImageUrls must be an array" };
    }
    if (raw.galleryImageUrls.length > MAX_GALLERY_URLS) {
      return { ok: false, error: `galleryImageUrls must contain ≤${MAX_GALLERY_URLS} entries` };
    }
    for (const entry of raw.galleryImageUrls) {
      if (!isHttpUrl(entry)) {
        return { ok: false, error: "galleryImageUrls entries must be http(s) URLs" };
      }
    }
  }

  return { ok: true, value: raw as unknown as InstallCharacterPayload };
}

export function validateInstallWorldbookPayload(
  raw: unknown,
): ValidationResult<InstallWorldbookPayload> {
  if (!isPlainObject(raw)) return { ok: false, error: "payload must be an object" };

  if (!ALLOWED_SOURCES.has(raw.source as "lumihub" | "chub")) {
    return { ok: false, error: "source must be 'lumihub' or 'chub'" };
  }
  if (!isString(raw.worldbookId, 256)) {
    return { ok: false, error: "worldbookId must be a string ≤256 chars" };
  }
  if (!isString(raw.worldbookName, 512)) {
    return { ok: false, error: "worldbookName must be a string ≤512 chars" };
  }

  if (raw.worldbookData !== undefined) {
    if (!isPlainObject(raw.worldbookData)) {
      return { ok: false, error: "worldbookData must be an object" };
    }
    const wb = raw.worldbookData;
    if (typeof wb.name !== "string") return { ok: false, error: "worldbookData.name must be a string" };
    if (typeof wb.description !== "string") return { ok: false, error: "worldbookData.description must be a string" };
    if (!Array.isArray(wb.entries)) return { ok: false, error: "worldbookData.entries must be an array" };
    if (wb.entries.length > MAX_WORLDBOOK_ENTRIES) {
      return { ok: false, error: `worldbookData.entries must contain ≤${MAX_WORLDBOOK_ENTRIES} rows` };
    }
  }

  if (raw.importUrl !== undefined && !isHttpUrl(raw.importUrl)) {
    return { ok: false, error: "importUrl must be an http(s) URL" };
  }

  return { ok: true, value: raw as unknown as InstallWorldbookPayload };
}

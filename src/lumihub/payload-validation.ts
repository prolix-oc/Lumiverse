/**
 * Runtime guards for inbound LumiHub WebSocket payloads.
 *
 * The WS protocol is JSON-over-WS with no schema enforcement on the wire, so
 * a compromised LumiHub server (or a future protocol mismatch) can otherwise
 * smuggle oversized strings, gigantic galleryImageUrls arrays, or bogus
 * `importUrl` schemes that would reach the installer.
 */

import type { InstallCharacterPayload, InstallPresetPayload, InstallThemePayload, InstallWorldbookPayload } from "./types";

const MAX_STRING_LEN = 64 * 1024; // 64 KB per string field
const MAX_CARD_DATA_BYTES = 4 * 1024 * 1024; // 4 MB JSON-blob ceiling
const MAX_AVATAR_BASE64_BYTES = 12 * 1024 * 1024; // base64 expands ~33% — caps raw at ~9 MB
const MAX_GALLERY_URLS = 50;
const MAX_WORLDBOOK_ENTRIES = 5_000;
const MAX_THEME_DATA_BYTES = 64 * 1024 * 1024;
const MAX_PRESET_DATA_BYTES = 2 * 1024 * 1024;
const ALLOWED_SOURCES = new Set(["lumihub", "chub"] as const);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Validate and clone a metadata bag without invoking accessors or accepting
 * values that cannot be represented by the JSON-over-WebSocket contract.
 */
export function isSafePlainJsonObject(value: unknown): value is Record<string, unknown> {
  try {
    cloneSafeJsonValue(value, new Set<object>());
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function cloneSafePlainJsonObject(value: unknown): Record<string, unknown> {
  const cloned = cloneSafeJsonValue(value, new Set<object>());
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new Error("value must be a plain JSON object");
  }
  return cloned as Record<string, unknown>;
}

function cloneSafeJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("value is not JSON-compatible");
  if (seen.has(value)) throw new Error("value contains a cycle");

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error("array has an invalid prototype");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error("array has an invalid length");
    }

    const length = lengthDescriptor.value;
    const cloned: unknown[] = new Array(length);
    seen.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string") throw new Error("array has a symbol key");
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw new Error("array has a non-index property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new Error("array has an accessor, hidden property, or hole");
        }
        Object.defineProperty(cloned, key, {
          value: cloneSafeJsonValue(descriptor.value, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, String(index))) throw new Error("array has a hole");
      }
      return cloned;
    } finally {
      seen.delete(value);
    }
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("object has an invalid prototype");
  }

  const cloned = Object.create(prototype === null ? null : Object.prototype) as Record<string, unknown>;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("object has a symbol key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("object has an accessor or hidden property");
      }
      Object.defineProperty(cloned, key, {
        value: cloneSafeJsonValue(descriptor.value, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return cloned;
  } finally {
    seen.delete(value);
  }
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
  if (raw.worldbookCreator !== undefined && !isString(raw.worldbookCreator, 256)) {
    return { ok: false, error: "worldbookCreator must be a string ≤256 chars" };
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

export function validateInstallThemePayload(
  raw: unknown,
): ValidationResult<InstallThemePayload> {
  if (!isPlainObject(raw)) return { ok: false, error: "payload must be an object" };

  if (raw.source !== "lumihub") {
    return { ok: false, error: "source must be 'lumihub'" };
  }
  if (!isString(raw.themeId, 256)) {
    return { ok: false, error: "themeId must be a string ≤256 chars" };
  }
  if (!isString(raw.themeName, 512)) {
    return { ok: false, error: "themeName must be a string ≤512 chars" };
  }
  if (!isPlainObject(raw.themeData)) {
    return { ok: false, error: "themeData must be an object" };
  }
  if (JSON.stringify(raw.themeData).length > MAX_THEME_DATA_BYTES) {
    return { ok: false, error: `themeData exceeds ${MAX_THEME_DATA_BYTES} bytes` };
  }

  return { ok: true, value: raw as unknown as InstallThemePayload };
}

export function validateInstallPresetPayload(
  raw: unknown,
): ValidationResult<InstallPresetPayload> {
  if (!isPlainObject(raw)) return { ok: false, error: "payload must be an object" };

  if (raw.source !== "lumihub") {
    return { ok: false, error: "source must be 'lumihub'" };
  }
  if (!isString(raw.presetId, 256)) {
    return { ok: false, error: "presetId must be a string ≤256 chars" };
  }
  if (!isString(raw.presetName, 512)) {
    return { ok: false, error: "presetName must be a string ≤512 chars" };
  }
  if (!isPlainObject(raw.presetData)) {
    return { ok: false, error: "presetData must be an object" };
  }
  const presetData = raw.presetData;
  const presetDescriptor = Object.getOwnPropertyDescriptor(presetData, "preset");
  const preset = presetDescriptor && Object.hasOwn(presetDescriptor, "value") && isPlainObject(presetDescriptor.value)
    ? presetDescriptor.value
    : null;
  if (preset) {
    try {
      for (const key of ["passthroughMetadata", "metadata"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(preset, key);
        if (!descriptor) continue;
        if (!Object.hasOwn(descriptor, "value") || !isSafePlainJsonObject(descriptor.value)) {
          return { ok: false, error: `preset.${key} must be a plain JSON object` };
        }
      }
    } catch {
      return { ok: false, error: "preset metadata must be a plain JSON object" };
    }
  }
  let serializedPresetData: string;
  try {
    serializedPresetData = JSON.stringify(presetData);
  } catch {
    return { ok: false, error: "presetData must contain valid JSON" };
  }
  if (serializedPresetData.length > MAX_PRESET_DATA_BYTES) {
    return { ok: false, error: `presetData exceeds ${MAX_PRESET_DATA_BYTES} bytes` };
  }
  if (raw.presetVersion != null && !isString(raw.presetVersion, 64)) {
    return { ok: false, error: "presetVersion must be a string ≤64 chars" };
  }
  if (raw.presetCreator != null && !isString(raw.presetCreator, 256)) {
    return { ok: false, error: "presetCreator must be a string ≤256 chars" };
  }
  if (raw.presetSlug != null && !isString(raw.presetSlug, 512)) {
    return { ok: false, error: "presetSlug must be a string ≤512 chars" };
  }
  if (raw.sealedPreset != null) {
    if (!isPlainObject(raw.sealedPreset)) {
      return { ok: false, error: "sealedPreset must be an object" };
    }
    const sealed = raw.sealedPreset as Record<string, unknown>;
    if (sealed.version != null && !isString(sealed.version, 64)) {
      return { ok: false, error: "sealedPreset.version must be a string ≤64 chars" };
    }
    if (!Array.isArray(sealed.blocks)) {
      return { ok: false, error: "sealedPreset.blocks must be an array" };
    }
    if (sealed.blocks.length > 200) {
      return { ok: false, error: "sealedPreset.blocks exceeds 200 entries" };
    }
    for (const block of sealed.blocks) {
      if (!isPlainObject(block)) return { ok: false, error: "sealedPreset.blocks entries must be objects" };
      if (!isString(block.key, 256)) return { ok: false, error: "sealedPreset block key must be a string ≤256 chars" };
      if (typeof block.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(block.sha256)) {
        return { ok: false, error: "sealedPreset block sha256 must be a 64-character hexadecimal digest" };
      }
    }
  }

  return { ok: true, value: raw as unknown as InstallPresetPayload };
}

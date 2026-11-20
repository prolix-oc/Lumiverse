import * as settingsSvc from "./settings.service";

export type AvatarCaptionSubject = "character" | "persona";

export interface AvatarCaptionCache {
  image_id: string;
  caption: string;
  fingerprint: string;
  updated_at: number;
}

export interface CaptionFingerprintInput {
  presetId?: string | null;
  prompt?: string;
  parserConnectionId?: string | null;
  parserProvider?: string;
  parserApiUrl?: string;
  parserMetadata?: Record<string, any>;
  parserModel?: string;
  parserParameters?: Record<string, any>;
}

function cacheKey(subject: AvatarCaptionSubject, entityId: string): string {
  return `imageGenAvatarCaption:${subject}:${entityId}`;
}

function isValidCache(value: unknown): value is AvatarCaptionCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.image_id === "string"
    && row.image_id.length > 0
    && typeof row.caption === "string"
    && row.caption.length > 0
    && typeof row.fingerprint === "string"
    && row.fingerprint.length > 0
    && typeof row.updated_at === "number"
    && Number.isFinite(row.updated_at)
  );
}

export function buildCaptionFingerprint(input: CaptionFingerprintInput): string {
  const payload = {
    presetId: input.presetId || null,
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    parserConnectionId: input.parserConnectionId || null,
    parserProvider: input.parserProvider || "",
    parserApiUrl: input.parserApiUrl || "",
    parserMetadata: input.parserMetadata || {},
    parserModel: typeof input.parserModel === "string" ? input.parserModel : "",
    parserParameters: input.parserParameters && typeof input.parserParameters === "object" && !Array.isArray(input.parserParameters)
      ? input.parserParameters
      : {},
  };
  const json = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getCachedCaption(
  userId: string,
  subject: AvatarCaptionSubject,
  entityId: string,
): AvatarCaptionCache | null {
  if (!entityId) return null;
  const row = settingsSvc.getSetting(userId, cacheKey(subject, entityId));
  if (!row) return null;
  if (!isValidCache(row.value)) {
    settingsSvc.deleteSetting(userId, cacheKey(subject, entityId));
    return null;
  }
  return row.value;
}

export function lookupCachedCaption(
  userId: string,
  subject: AvatarCaptionSubject,
  entityId: string,
  imageId: string,
  fingerprint: string,
): string | null {
  const cached = getCachedCaption(userId, subject, entityId);
  if (!cached) return null;
  if (cached.image_id !== imageId || cached.fingerprint !== fingerprint) return null;
  return cached.caption;
}

export function setCachedCaption(
  userId: string,
  subject: AvatarCaptionSubject,
  entityId: string,
  input: { image_id: string; caption: string; fingerprint: string },
): AvatarCaptionCache {
  const image_id = String(input.image_id || "").trim();
  const caption = String(input.caption || "").trim();
  const fingerprint = String(input.fingerprint || "").trim();
  if (!entityId) throw new Error("entityId is required");
  if (!image_id) throw new Error("image_id is required");
  if (!caption) throw new Error("caption is required");
  if (!fingerprint) throw new Error("fingerprint is required");

  const entry: AvatarCaptionCache = {
    image_id,
    caption,
    fingerprint,
    updated_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, cacheKey(subject, entityId), entry);
  return entry;
}

export function clearCachedCaption(
  userId: string,
  subject: AvatarCaptionSubject,
  entityId: string,
): boolean {
  if (!entityId) return false;
  return settingsSvc.deleteSetting(userId, cacheKey(subject, entityId));
}

/**
 * Immutable media-domain ceilings shared by writers and archive portability.
 * Keep these values independent of service/database modules so archive export
 * and import cannot drift from the normal storage boundary.
 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_OR_VIDEO_BYTES = 250 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 50 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 50 * 1024 * 1024;
export const MAX_THEME_ASSET_BYTES = 50 * 1024 * 1024;
export const MAX_WALLPAPER_VIDEO_BYTES = MAX_IMAGE_OR_VIDEO_BYTES;
export const MAX_DATABANK_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_NOTIFICATION_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Provider-bound current-turn media remains bounded before base64 expansion. */
export const MAX_NATIVE_MESSAGE_MEDIA_PARTS = 8;
export const MAX_NATIVE_MESSAGE_MEDIA_TOTAL_BYTES = 64 * 1024 * 1024;

export type MediaDomain =
  | "images"
  | "thumbnails"
  | "avatars"
  | "theme-assets"
  | "databank"
  | "audio"
  | "notification-sounds"
  | "artifacts";

export type MediaPolicy =
  | "image"
  | "image_or_video"
  | "audio"
  | "notification_audio"
  | "databank_document"
  | "theme_asset"
  | "artifact";

/** Return the canonical writer ceiling for an archive file bucket. */
export function mediaDomainLimit(bucket: string): number | null {
  switch (bucket) {
    case "images": return MAX_IMAGE_OR_VIDEO_BYTES;
    case "thumbnails": return MAX_THUMBNAIL_BYTES;
    case "avatars": return MAX_AVATAR_BYTES;
    case "theme-assets": return MAX_THEME_ASSET_BYTES;
    case "databank": return MAX_DATABANK_DOCUMENT_BYTES;
    case "audio": return MAX_AUDIO_BYTES;
    case "notification-sounds": return MAX_NOTIFICATION_SOUND_BYTES;
    case "artifacts": return MAX_ARTIFACT_BYTES;
    default: return null;
  }
}

export function mediaPolicyLimit(policy: string): number | null {
  switch (policy) {
    case "image": return MAX_IMAGE_BYTES;
    case "image_or_video": return MAX_IMAGE_OR_VIDEO_BYTES;
    case "audio": return MAX_AUDIO_BYTES;
    case "notification_audio": return MAX_NOTIFICATION_SOUND_BYTES;
    case "databank_document": return MAX_DATABANK_DOCUMENT_BYTES;
    case "theme_asset": return MAX_THEME_ASSET_BYTES;
    case "artifact": return MAX_ARTIFACT_BYTES;
    default: return null;
  }
}

/**
 * Combine a registry-declared cap with the normal writer cap. Invalid
 * declarations are ignored here; registry shape validation rejects them.
 * A registry media policy is authoritative over the storage bucket because
 * one bucket may contain ordinary images and larger image/video sidecars.
 */
export function strictestMediaLimit(
  bucket: string,
  declared: unknown,
  policy?: string,
): number | null {
  const domain = policy ? mediaPolicyLimit(policy) : mediaDomainLimit(bucket);
  const registry = typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : null;
  if (domain === null) return registry;
  if (registry === null) return domain;
  return Math.min(domain, registry);
}

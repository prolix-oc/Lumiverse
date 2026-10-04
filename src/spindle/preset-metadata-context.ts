/**
 * Preset metadata exposure for Spindle interceptors.
 *
 * The generation pipeline pins the resolved preset's full metadata on the
 * shared interceptor context under an internal key. Each extension only ever
 * receives (and is only ever matched against) its own namespace,
 * `preset.metadata[<manifest identifier>]`, mirroring the frontend preset
 * editor helper's scoping.
 */
export const INTERNAL_PRESET_METADATA_KEY = "__spindlePresetMetadata";

// Loom-owned preset metadata keys. Mirrors isLoomOwnedPresetMetadataKey in
// frontend/src/lib/loom/service.ts: an extension whose identifier collides
// with one of these does not own a namespace.
const LOOM_OWNED_PRESET_METADATA_KEYS = new Set([
  "source",
  "modelProfiles",
  "schemaVersion",
  "description",
  "coverUrl",
  "cover_url",
  "isDefault",
  "lastProfileKey",
  "promptVariables",
]);

/** The extension's own preset metadata namespace on a shared context, uncloned. */
export function readOwnPresetMetadata(
  context: unknown,
  identifier: string | undefined,
): unknown {
  if (!identifier || !context || typeof context !== "object") return undefined;
  if (LOOM_OWNED_PRESET_METADATA_KEYS.has(identifier) || identifier.startsWith("_lumiverse_")) {
    return undefined;
  }
  const metadata = (context as Record<string, unknown>)[INTERNAL_PRESET_METADATA_KEY];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return Object.prototype.hasOwnProperty.call(metadata, identifier)
    ? (metadata as Record<string, unknown>)[identifier]
    : undefined;
}

/**
 * Shallow-copy a shared interceptor context for one extension: drop the full
 * preset metadata and expose a deep clone of only that extension's namespace.
 */
export function projectPresetMetadataContext(
  context: unknown,
  identifier: string,
): Record<string, unknown> {
  const projected =
    context && typeof context === "object"
      ? { ...(context as Record<string, unknown>) }
      : {};
  const own = readOwnPresetMetadata(projected, identifier);
  delete projected[INTERNAL_PRESET_METADATA_KEY];
  projected.presetMetadata = own === undefined ? undefined : structuredClone(own);
  return projected;
}

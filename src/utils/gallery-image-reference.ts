export const GALLERY_IMAGE_REFERENCE_PREFIX = "gallery://";

const GALLERY_REFERENCE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_GALLERY_REFERENCE_TOKEN_RE = /^image-([1-9][0-9]*)$/;

/**
 * Turn a user-facing gallery image name into a portable reference token.
 * Keeping this normalization on the server makes every client and import path
 * agree on the final `gallery://...` value.
 */
export function normalizeGalleryImageReferenceName(name: string): string {
  const withoutPrefix = name.trim().replace(/^gallery:\/\//i, "");
  const token = withoutPrefix
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 128)
    .replace(/[._-]+$/g, "");

  if (!GALLERY_REFERENCE_TOKEN_RE.test(token)) {
    throw new Error("Reference name must contain at least one letter or number");
  }
  return token;
}

export function createGalleryImageReference(token: string): string {
  if (!GALLERY_REFERENCE_TOKEN_RE.test(token)) {
    throw new Error("Invalid gallery image reference token");
  }
  return `${GALLERY_IMAGE_REFERENCE_PREFIX}${token}`;
}

export function parseGalleryImageReference(reference: string): string | null {
  if (!reference.startsWith(GALLERY_IMAGE_REFERENCE_PREFIX)) return null;
  const token = reference.slice(GALLERY_IMAGE_REFERENCE_PREFIX.length);
  return GALLERY_REFERENCE_TOKEN_RE.test(token) ? token : null;
}

export function parseCanonicalGalleryImageReference(reference: string): number | null {
  const token = parseGalleryImageReference(reference);
  if (!token) return null;
  const match = CANONICAL_GALLERY_REFERENCE_TOKEN_RE.exec(token);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

export function createCanonicalGalleryImageReference(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Invalid gallery image reference sequence");
  }
  return createGalleryImageReference(`image-${sequence}`);
}

export function galleryArchiveStem(token: string): string {
  createGalleryImageReference(token);
  return `gallery_${token}`;
}

export function galleryReferenceFromArchivePath(path: string): string | null {
  const base = path.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (!stem.startsWith("gallery_")) return null;
  const token = stem.slice("gallery_".length);
  return GALLERY_REFERENCE_TOKEN_RE.test(token)
    ? `${GALLERY_IMAGE_REFERENCE_PREFIX}${token}`
    : null;
}

export function findGalleryImageReference(
  assetMap: unknown,
  imageId: string,
  preferredToken?: string,
): string | null {
  if (!assetMap || typeof assetMap !== "object" || Array.isArray(assetMap)) return null;
  const map = assetMap as Record<string, unknown>;

  if (preferredToken && GALLERY_REFERENCE_TOKEN_RE.test(preferredToken)) {
    const preferred = `${GALLERY_IMAGE_REFERENCE_PREFIX}${preferredToken}`;
    if (map[preferred] === imageId) return preferred;
  }

  for (const [reference, mappedImageId] of Object.entries(map)) {
    if (mappedImageId === imageId && parseGalleryImageReference(reference)) return reference;
  }
  return null;
}

export function findCanonicalGalleryImageReference(
  assetMap: unknown,
  imageId: string,
): string | null {
  if (!assetMap || typeof assetMap !== "object" || Array.isArray(assetMap)) return null;
  const matches = Object.entries(assetMap as Record<string, unknown>)
    .filter(([reference, mappedImageId]) =>
      mappedImageId === imageId && parseCanonicalGalleryImageReference(reference) !== null
    )
    .sort((a, b) =>
      parseCanonicalGalleryImageReference(a[0])! - parseCanonicalGalleryImageReference(b[0])!
    );
  return matches[0]?.[0] ?? null;
}

/**
 * Replace image identifiers in a greeting-background map while preserving its
 * greeting indices and any unknown entries. CHARX export uses this to replace
 * local image IDs with portable gallery references; import applies the inverse
 * mapping after the bundled gallery images receive their new local IDs.
 */
export function remapGreetingBackgrounds(
  backgrounds: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (!backgrounds || typeof backgrounds !== "object" || Array.isArray(backgrounds)) {
    return backgrounds;
  }

  const current = backgrounds as Record<string, unknown>;
  let remapped: Record<string, unknown> | null = null;
  for (const [greetingIndex, imageId] of Object.entries(current)) {
    if (typeof imageId !== "string") continue;
    const replacement = replacements.get(imageId);
    if (!replacement || replacement === imageId) continue;
    remapped ??= { ...current };
    remapped[greetingIndex] = replacement;
  }

  return remapped ?? backgrounds;
}

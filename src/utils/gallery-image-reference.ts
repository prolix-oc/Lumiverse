export const GALLERY_IMAGE_REFERENCE_PREFIX = "gallery://";

const GALLERY_REFERENCE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_GALLERY_REFERENCE_TOKEN_RE = /^image-([1-9][0-9]*)$/;

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

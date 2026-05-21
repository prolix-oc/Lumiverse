// Path validators for the import side. Every archive entry path must pass
// through one of these before any disk I/O so a malicious archive can't
// write outside the prescribed buckets or escape via "../" traversal.

const PREFIX_RE =
  /^(?:database\/|files\/(?:images|thumbnails|avatars|databank|theme-assets|notification-sounds)\/|lancedb\/|secrets\/(?:encrypted\.ndjson|index\.json)$|manifest\.json$|manifest-stats\.json$)/;

const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-zA-Z0-9]{1,8})?$/;

const THUMB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_thumb_(?:sm|lg)_v2\.webp$/;

const AVATAR_RE = /^[A-Za-z0-9._-]+$/;

const THEME_ASSET_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+$/;

const DATABANK_FILE_RE = /^[A-Za-z0-9._-]+$/;

const SOUND_FILE_RE = /^completion\.(mp3|wav|ogg|aac|m4a)$/;

const NDJSON_RE = /^[a-z_]+\.ndjson$/;

export interface SanitizedEntry {
  /** "database" | "files" | "lancedb" | "manifest" | "secrets" */
  kind: "database" | "files" | "lancedb" | "manifest" | "secrets";
  /** For files/: the bucket name. */
  bucket?: "images" | "thumbnails" | "avatars" | "databank" | "theme-assets" | "notification-sounds";
  /** For database/ and lancedb/: the table name (without .ndjson). */
  table?: string;
  /** Path inside the bucket (basename for images/thumbs, subpath for theme-assets/databank). */
  inner: string;
  /** Original full entry path for logging. */
  raw: string;
}

export class SanitizeError extends Error {
  constructor(message: string, public entry: string) {
    super(`${message}: ${entry}`);
    this.name = "SanitizeError";
  }
}

/**
 * Validates an archive entry name and returns a parsed descriptor.
 *
 * Throws SanitizeError if:
 * - the path contains traversal segments ("..", absolute, drive letters)
 * - the prefix doesn't match the allowed buckets
 * - the inner name doesn't match the bucket's expected pattern
 */
export function sanitizeEntry(rawPath: string): SanitizedEntry {
  if (!rawPath || typeof rawPath !== "string") {
    throw new SanitizeError("empty entry path", String(rawPath));
  }
  if (rawPath.length > 4096) {
    throw new SanitizeError("entry path too long", rawPath);
  }
  // Reject any control or NUL bytes outright.
  if (/[\x00-\x1f]/.test(rawPath)) {
    throw new SanitizeError("entry path contains control characters", rawPath);
  }
  // Reject Windows drive letters, UNC, and absolute-from-root paths.
  if (/^([a-zA-Z]:|\\\\|\/)/.test(rawPath)) {
    throw new SanitizeError("entry path is absolute", rawPath);
  }
  // Normalise backslashes to forward slashes for comparison.
  const path = rawPath.replace(/\\/g, "/");
  // Reject any segment equal to "." or ".." anywhere.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new SanitizeError("entry path contains traversal segment", rawPath);
    }
  }
  // Top-level prefix check.
  if (!PREFIX_RE.test(path)) {
    throw new SanitizeError("entry path uses an unknown prefix", rawPath);
  }

  if (path === "manifest.json" || path === "manifest-stats.json") {
    return { kind: "manifest", inner: path, raw: rawPath };
  }

  if (path.startsWith("database/")) {
    const file = path.slice("database/".length);
    if (!NDJSON_RE.test(file)) {
      throw new SanitizeError("database/ entry name is not a valid NDJSON", rawPath);
    }
    return {
      kind: "database",
      table: file.replace(/\.ndjson$/, ""),
      inner: file,
      raw: rawPath,
    };
  }

  if (path.startsWith("lancedb/")) {
    const file = path.slice("lancedb/".length);
    if (!NDJSON_RE.test(file)) {
      throw new SanitizeError("lancedb/ entry name is not a valid NDJSON", rawPath);
    }
    return {
      kind: "lancedb",
      table: file.replace(/\.ndjson$/, ""),
      inner: file,
      raw: rawPath,
    };
  }

  if (path.startsWith("secrets/")) {
    const file = path.slice("secrets/".length);
    if (file !== "encrypted.ndjson" && file !== "index.json") {
      throw new SanitizeError("secrets/ entry name is not allowlisted", rawPath);
    }
    return { kind: "secrets", inner: file, raw: rawPath };
  }

  // files/{bucket}/...
  const match = /^files\/([^/]+)\/(.+)$/.exec(path);
  if (!match) {
    throw new SanitizeError("files/ entry must include a bucket and inner path", rawPath);
  }
  const bucket = match[1] as SanitizedEntry["bucket"];
  const inner = match[2];

  switch (bucket) {
    case "images":
      if (!IMAGE_ID_RE.test(inner)) {
        throw new SanitizeError("files/images entry must be UUID-shaped", rawPath);
      }
      break;
    case "thumbnails":
      if (!THUMB_RE.test(inner)) {
        throw new SanitizeError("files/thumbnails entry must be a UUID_thumb file", rawPath);
      }
      break;
    case "avatars":
      if (!AVATAR_RE.test(inner)) {
        throw new SanitizeError("files/avatars entry name is invalid", rawPath);
      }
      break;
    case "databank":
      if (!DATABANK_FILE_RE.test(inner)) {
        throw new SanitizeError("files/databank entry name is invalid", rawPath);
      }
      break;
    case "theme-assets":
      if (!THEME_ASSET_RE.test(inner)) {
        throw new SanitizeError("files/theme-assets entry must be bundleId/slug", rawPath);
      }
      break;
    case "notification-sounds":
      if (!SOUND_FILE_RE.test(inner)) {
        throw new SanitizeError("files/notification-sounds entry must be completion.{ext}", rawPath);
      }
      break;
    default:
      throw new SanitizeError("files/ entry uses an unknown bucket", rawPath);
  }

  return { kind: "files", bucket, inner, raw: rawPath };
}

/**
 * Joins a sanitized inner path onto a base directory and re-verifies that the
 * resolved absolute path is still inside the base. Defends against any
 * sanitizer bug or future relaxation of the entry-name check.
 */
export function safeJoin(baseDir: string, inner: string): string {
  // Already passed sanitizeEntry; this is a belt-and-braces final check.
  const { resolve, sep } = require("node:path") as typeof import("path");
  const normalizedBase = resolve(baseDir);
  const candidate = resolve(normalizedBase, inner);
  if (
    candidate !== normalizedBase &&
    !candidate.startsWith(normalizedBase + sep)
  ) {
    throw new SanitizeError("resolved path escapes base directory", inner);
  }
  return candidate;
}

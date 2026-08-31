import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { mediaPolicyLimit, type MediaPolicy } from "../../types/media-limits";
export type ArchiveMediaBucket = "images" | "thumbnails" | "avatars" | "theme-assets" | "databank" | "artifacts";
export type SafeMediaKind = "image" | "video" | "other";

export interface SafeMediaValidationOptions {
  filename: string;
  bucket: ArchiveMediaBucket;
  mediaPolicy: MediaPolicy;
  expectedMimeType?: string | null;
  /** Published content-addressed artifacts use a `.blob` path. */
  allowExtensionlessArtifact?: boolean;
}

export interface SafeMediaValidation {
  extension: string;
  contentType: string;
  kind: SafeMediaKind;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
});

const VIDEO_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
});

const ACTIVE_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".shtml",
  ".svg",
  ".xhtml",
  ".xml",
  ".js",
  ".mjs",
  ".cjs",
]);

const ACTIVE_MIME_TYPES = new Set([
  "application/javascript",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
  "text/xml",
]);

const MEDIA_MIME_TYPES = new Set([
  ...Object.values(IMAGE_TYPES),
  ...Object.values(VIDEO_TYPES),
]);

const DATABANK_DOCUMENT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/yaml",
  "application/rtf",
  "text/rtf",
]);
const DATABANK_DOCUMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".log", ".rst", ".rtf",
]);

const MAX_MARKUP_SCAN_BYTES = 64 * 1024;

/** RFC 9110 allows optional whitespace around the parameter delimiter. */
function normalizeMime(value: string | null | undefined): string {
  return typeof value === "string" ? (value.toLowerCase().split(";", 1)[0] ?? "").trim() : "";
}

function isActiveMime(value: string): boolean {
  return ACTIVE_MIME_TYPES.has(normalizeMime(value));
}

function readSample(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength <= MAX_MARKUP_SCAN_BYTES * 2) return bytes;
  const sample = new Uint8Array(MAX_MARKUP_SCAN_BYTES * 2);
  sample.set(bytes.subarray(0, MAX_MARKUP_SCAN_BYTES), 0);
  sample.set(bytes.subarray(bytes.byteLength - MAX_MARKUP_SCAN_BYTES), MAX_MARKUP_SCAN_BYTES);
  return sample;
}

function containsActiveMarkup(bytes: Uint8Array): boolean {
  const text = Buffer.from(readSample(bytes)).toString("utf8").toLowerCase();
  return /(?:^|[^a-z0-9])<(?:!doctype\s+html|html(?:[\s>])|svg(?:[\s>])|script(?:[\s>]))/.test(text);
}

function startsWith(bytes: Uint8Array, ...values: number[]): boolean {
  return values.length <= bytes.byteLength && values.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
}

function detectIsoBmff(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= bytes.byteLength && offset < 128; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  if (brands.some((brand) => brand === "qt  ")) return "video/quicktime";
  if (brands.some((brand) => brand === "M4V " || brand === "m4v ")) return "video/x-m4v";
  if (brands.some((brand) => /^(?:isom|iso[2-9]|mp4[12]|avc1|hvc1|hev1|3gp[4-9])$/.test(brand))) {
    return "video/mp4";
  }
  return null;
}

function detectMagic(bytes: Uint8Array): string | null {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (startsWith(bytes, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return detectIsoBmff(bytes);
}

function typeForExtension(extension: string): { contentType: string; kind: SafeMediaKind } | null {
  const image = IMAGE_TYPES[extension];
  if (image) return { contentType: image, kind: "image" };
  const video = VIDEO_TYPES[extension];
  if (video) return { contentType: video, kind: "video" };
  return null;
}

function mimeCompatible(expected: string, actual: string, extension: string): boolean {
  if (!expected) return true;
  if (expected === actual) return true;
  // JPEG has two common filename spellings and MP4-family containers have
  // historical MIME aliases. The extension still determines the served type.
  if (actual === "image/jpeg" && expected === "image/jpg") return true;
  if (actual === "video/mp4" && extension === ".m4v" && expected === "video/x-m4v") return true;
  if (actual === "video/quicktime" && extension === ".mov" && expected === "video/mp4") return true;
  return false;
}

function validateDatabankDocument(
  bytes: Uint8Array,
  filename: string,
  extension: string,
  expectedMime: string,
): SafeMediaValidation {
  if (!DATABANK_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(`databank document extension is not allowlisted: ${filename}`);
  }
  if (expectedMime && !DATABANK_DOCUMENT_MIME_TYPES.has(expectedMime)) {
    throw new Error(`databank document MIME type is not allowlisted: ${filename}`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`databank document is not valid UTF-8 data: ${filename}`);
  }
  return {
    extension,
    contentType: expectedMime || "text/plain",
    kind: "other",
  };
}

function assertNoActiveContent(
  filename: string,
  expectedMimeType: string | null | undefined,
  bytes: Uint8Array,
): void {
  const extension = extname(filename).toLowerCase();
  const expected = normalizeMime(expectedMimeType);
  if (ACTIVE_EXTENSIONS.has(extension) || isActiveMime(expected) || containsActiveMarkup(bytes)) {
    throw new Error(`active content is not allowed in archive file: ${filename}`);
  }
}

export function validateSafeMediaBytes(
  bytes: Uint8Array,
  options: SafeMediaValidationOptions,
): SafeMediaValidation {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`archive media is empty: ${options.filename}`);
  }
  const maxBytes = mediaPolicyLimit(options.mediaPolicy);
  if (maxBytes === null) {
    throw new Error(`archive media policy is unsupported: ${options.filename}`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`archive media exceeds the ${options.bucket} byte ceiling: ${options.filename}`);
  }
  const extension = extname(options.filename).toLowerCase();
  const expectedMime = normalizeMime(options.expectedMimeType);
  if (options.mediaPolicy === "databank_document") {
    return validateDatabankDocument(bytes, options.filename, extension, expectedMime);
  }
  assertNoActiveContent(options.filename, expectedMime, bytes);

  const extensionType = typeForExtension(extension);
  const requiresMedia = options.bucket === "images"
    || options.bucket === "thumbnails"
    || options.bucket === "avatars"
    || (options.bucket === "artifacts" && options.allowExtensionlessArtifact)
    || extensionType !== null
    || MEDIA_MIME_TYPES.has(expectedMime);

  if (!requiresMedia) {
    return {
      extension,
      contentType: expectedMime || "application/octet-stream",
      kind: "other",
    };
  }

  if (!extensionType) {
    if (options.bucket === "artifacts" && options.allowExtensionlessArtifact) {
      const actual = detectMagic(bytes);
      const expectedIsMedia = MEDIA_MIME_TYPES.has(expectedMime);
      if (expectedIsMedia && (!actual || !mimeCompatible(expectedMime, actual, extension))) {
        throw new Error(`archive artifact MIME type does not match content: ${options.filename}`);
      }
      if (actual && expectedMime && !mimeCompatible(expectedMime, actual, extension)) {
        throw new Error(`archive artifact MIME type does not match content: ${options.filename}`);
      }
      return {
        extension,
        contentType: (actual ?? expectedMime) || "application/octet-stream",
        kind: actual?.startsWith("image/") ? "image" : actual?.startsWith("video/") ? "video" : "other",
      };
    }
    throw new Error(`archive media extension is not allowlisted: ${options.filename}`);
  }
  if (options.bucket === "thumbnails" && extension !== ".webp") {
    throw new Error(`thumbnail extension is not allowlisted: ${options.filename}`);
  }
  if (options.bucket === "avatars" && extensionType.kind !== "image") {
    throw new Error(`avatar must use an image extension: ${options.filename}`);
  }
  if (expectedMime && !MEDIA_MIME_TYPES.has(expectedMime)) {
    throw new Error(`archive media MIME type is not allowlisted: ${options.filename}`);
  }
  if (expectedMime && !mimeCompatible(extensionType.contentType, expectedMime, extension)) {
    throw new Error(`archive media MIME type does not match extension: ${options.filename}`);
  }

  const actual = detectMagic(bytes);
  if (!actual || !mimeCompatible(extensionType.contentType, actual, extension)) {
    throw new Error(`archive media content does not match extension: ${options.filename}`);
  }
  if (!mimeCompatible(extensionType.contentType, actual, extension)) {
    throw new Error(`archive media content type is not allowlisted: ${options.filename}`);
  }

  return {
    extension,
    ...extensionType,
  };
}

export function validateSafeMediaFile(
  path: string,
  options: SafeMediaValidationOptions,
): SafeMediaValidation {
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`archive media is empty: ${options.filename}`);
  }
  const maxBytes = mediaPolicyLimit(options.mediaPolicy);
  if (maxBytes === null) {
    throw new Error(`archive media policy is unsupported: ${options.filename}`);
  }
  if (size > maxBytes) {
    throw new Error(`archive media exceeds the ${options.bucket} byte ceiling: ${options.filename}`);
  }
  if (options.mediaPolicy === "databank_document") {
    const bytes = new Uint8Array(size);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, bytes, 0, size, 0);
      if (read !== size) throw new Error(`archive media is truncated: ${options.filename}`);
    } finally {
      closeSync(fd);
    }
    return validateSafeMediaBytes(bytes, options);
  }
  const sampleSize = Math.min(size, MAX_MARKUP_SCAN_BYTES * 2);
  const bytes = new Uint8Array(sampleSize);
  const fd = openSync(path, "r");
  try {
    const headSize = Math.min(size, MAX_MARKUP_SCAN_BYTES);
    const headRead = readSync(fd, bytes, 0, headSize, 0);
    if (headRead !== headSize) throw new Error(`archive media is truncated: ${options.filename}`);
    if (size > MAX_MARKUP_SCAN_BYTES) {
      const tailSize = Math.min(size - MAX_MARKUP_SCAN_BYTES, MAX_MARKUP_SCAN_BYTES);
      const tailRead = readSync(fd, bytes, MAX_MARKUP_SCAN_BYTES, tailSize, size - tailSize);
      if (tailRead !== tailSize) throw new Error(`archive media is truncated: ${options.filename}`);
    }
  } finally {
    closeSync(fd);
  }
  return validateSafeMediaBytes(bytes, options);
}

export function isAllowlistedMediaContentType(value: string | null | undefined): boolean {
  return MEDIA_MIME_TYPES.has(normalizeMime(value));
}

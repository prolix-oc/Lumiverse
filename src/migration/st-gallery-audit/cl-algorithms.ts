/**
 * Faithful port of SillyTavern CharacterLibrary's gallery-folder and
 * media-localization algorithms.
 *
 * Sources (CharacterLibrary v7.2.2):
 *   app/library.js:6066  buildUniqueGalleryFolderName
 *   app/library.js:7546  getGalleryFolderName
 *   app/library.js:6042  generateGalleryId
 *   app/library.js:22347 extractSanitizedUrlName
 *   app/library.js:22376 mediaUrlHash8
 *   app/library.js:22394 qualifiedMediaName
 *   app/library.js:22421 computeEffectiveMediaNames
 *   app/library.js:22874 collectCardTextChunks
 *   app/library.js:22820 extractMediaUrls
 *   app/library.js:24864 sanitizeMediaFilename
 *   app/library.js:24936 buildMediaLocalizationMap  (index shape)
 *   app/library.js:25015 lookupLocalizedMedia       (match order)
 *   index.js:1088        sanitizeFolderName
 *   index.js:1408        localized-media filename pattern
 *
 * The audit is read-only, so these functions never touch disk; callers feed
 * them directory listings. Behavior that differs from CL is called out inline:
 * CL stores one candidate per key (last wins) because it only reads; the audit
 * keeps every candidate so a shared basename can be reported as ambiguous
 * instead of silently resolving to an arbitrary file.
 */

/** CL/index.js `sanitizeFolderName`: illegal chars become `_`, then trim. */
export function clSanitizeFolderName(name: string): string {
  if (!name) return "";
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

const ILLEGAL_CHARS_RE = /[/?<>\\:*|"]/g;
const CONTROL_CHARS_RE = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_RE = /^\.+$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_TRAILING_RE = /[\. ]+$/;
/** sanitize-filename truncates to 255 *bytes* (truncate-utf8-bytes). */
export const MAX_SANITIZED_NAME_BYTES = 255;

function truncateUtf8Bytes(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length <= maxBytes) return input;
  // Never cut a multi-byte sequence in half; walk back to a lead byte boundary.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * ST server-side `sanitize-filename` (SillyTavern/src/endpoints/images.js:65).
 * CL computes a folder name and hands it to ST as `ch_name`; ST re-sanitizes
 * it before `mkdir -p`. Illegal characters are removed (not replaced) here,
 * which is why a folder CL names `Foo_Bar` can land on disk as `FooBar`.
 */
export function stSanitizeFilename(input: string): string {
  let sanitized = input
    .replace(ILLEGAL_CHARS_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .replace(RESERVED_RE, "")
    .replace(WINDOWS_RESERVED_RE, "")
    .replace(WINDOWS_TRAILING_RE, "");
  sanitized = truncateUtf8Bytes(sanitized, MAX_SANITIZED_NAME_BYTES);
  return sanitized;
}

/**
 * CL `buildUniqueGalleryFolderName` + `getGalleryFolderName`:
 * unique folders OFF (CL default) → the raw character name; ON with a
 * `gallery_id` → `{sanitizedName}_{gallery_id}`; ON without one → raw name.
 */
export function galleryFolderName(
  characterName: string | null | undefined,
  galleryId: string | null | undefined,
  uniqueFolders: boolean,
): string {
  if (!characterName) return "";
  if (!uniqueFolders) return characterName;
  if (!galleryId) return characterName;
  return `${clSanitizeFolderName(characterName)}_${galleryId}`;
}

// ─── Card text surfaces ─────────────────────────────────────────────────────

/** CL `collectCardTextChunks` fieldsToCheck (creator is deliberately absent). */
export const CARD_TEXT_FIELDS = [
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
] as const;

export interface CardTextChunks {
  main: string[];
  lorebook: string[];
}

interface LooseRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null;
}

/**
 * Collect every card surface CL scans for media URLs. Literal inline images
 * (`data.extensions.*.tagline`) are included; nested lorebook entries land in
 * `lorebook` so each consumer applies its own `includeLorebook` gate.
 */
export function collectCardTextChunks(card: unknown): CardTextChunks {
  const chunks: CardTextChunks = { main: [], lorebook: [] };
  const root = asRecord(card);
  if (!root) return chunks;
  const data = asRecord(root.data) ?? root;

  for (const field of CARD_TEXT_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value) chunks.main.push(value);
  }

  const extensions = asRecord(data.extensions);
  if (extensions) {
    for (const providerData of Object.values(extensions)) {
      const tagline = asRecord(providerData)?.tagline;
      if (typeof tagline === "string" && tagline) chunks.main.push(tagline);
    }
  }

  const alternateGreetings = data.alternate_greetings;
  if (Array.isArray(alternateGreetings)) {
    for (const greeting of alternateGreetings) {
      if (typeof greeting === "string" && greeting) chunks.main.push(greeting);
    }
  }

  const entries = asRecord(data.character_book)?.entries;
  if (entries) {
    const entryList = Array.isArray(entries) ? entries : Object.values(asRecord(entries) ?? {});
    for (const entry of entryList) {
      const content = asRecord(entry)?.content;
      if (typeof content === "string" && content) chunks.lorebook.push(content);
    }
  }

  return chunks;
}

const MARKDOWN_MEDIA_RE = /!\[.*?\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)/g;
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
const HTML_AUDIO_RE = /<(?:audio|source)[^>]+src=["']([^"']+)["'][^>]*>/g;
const CSS_URL_RE =
  /url\(["']?(https?:\/\/[^"')\s]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))["']?\)/gi;
const RAW_MEDIA_URL_RE =
  /(https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|m4a))/gi;

/** CL `extractMediaUrls`, including its truncated-twin filter. */
export function extractMediaUrls(text: string): string[] {
  if (!text) return [];
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  MARKDOWN_MEDIA_RE.lastIndex = 0;
  while ((match = MARKDOWN_MEDIA_RE.exec(text)) !== null) {
    let url = match[1]!;
    // An unbalanced-paren URL makes the balanced branch swallow the closer.
    if (url.endsWith(")") && text[MARKDOWN_MEDIA_RE.lastIndex] !== ")") url = url.slice(0, -1);
    urls.push(url);
  }

  HTML_IMG_RE.lastIndex = 0;
  while ((match = HTML_IMG_RE.exec(text)) !== null) {
    if (match[1]!.startsWith("http")) urls.push(match[1]!);
  }

  HTML_AUDIO_RE.lastIndex = 0;
  while ((match = HTML_AUDIO_RE.exec(text)) !== null) {
    if (match[1]!.startsWith("http")) urls.push(match[1]!);
  }

  CSS_URL_RE.lastIndex = 0;
  while ((match = CSS_URL_RE.exec(text)) !== null) urls.push(match[1]!);

  RAW_MEDIA_URL_RE.lastIndex = 0;
  while ((match = RAW_MEDIA_URL_RE.exec(text)) !== null) urls.push(match[0]);

  const unique = [...new Set(urls)];
  // A proper prefix of a longer capture continuing with `/` is a truncated twin.
  return unique.filter((u) => !unique.some((o) => o !== u && o.startsWith(u) && o[u.length] === "/"));
}

export interface CharacterMediaUrls {
  embedded: string[];
  lorebook: string[];
}

/** CL `findCharacterMediaUrls`: dedupes across surfaces, lorebook gated. */
export function findCharacterMediaUrls(card: unknown, includeLorebook: boolean): CharacterMediaUrls {
  const { main, lorebook } = collectCardTextChunks(card);
  const embedded = new Set<string>();
  for (const chunk of main) {
    for (const url of extractMediaUrls(chunk)) {
      if (url.startsWith("http://") || url.startsWith("https://")) embedded.add(url);
    }
  }
  const loreOnly = new Set<string>();
  if (includeLorebook) {
    for (const chunk of lorebook) {
      for (const url of extractMediaUrls(chunk)) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
        if (!embedded.has(url)) loreOnly.add(url);
      }
    }
  }
  return { embedded: [...embedded], lorebook: [...loreOnly] };
}

// ─── URL → filename derivation ──────────────────────────────────────────────

/** CL `CDN_VARIANT_NAMES` (library.js:22343). */
export const CDN_VARIANT_NAMES: Record<string, true> = {
  public: true, original: true, raw: true, full: true, thumbnail: true, thumb: true,
  medium: true, small: true, large: true, xl: true, default: true, image: true,
  photo: true, download: true, view: true, highres: true, hires: true, high: true,
  lowres: true, lores: true, low: true, preview: true, avatar: true,
};

const SANITIZE_NAME_RE = /[^a-zA-Z0-9_-]/g;

function urlPathParts(url: string): string[] | null {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * CL `extractSanitizedUrlName`: pathname only (query/hash dropped), last
 * segment, drop the final extension, non-word chars → `_`, cap 40 chars, with
 * the CDN-variant parent prefix rule. Returns "" when the URL has no path.
 */
export function extractSanitizedUrlName(url: string): string {
  const parts = urlPathParts(url);
  if (!parts || parts.length === 0) return "";
  const lastPart = parts[parts.length - 1]!;
  const dot = lastPart.lastIndexOf(".");
  const nameWithoutExt = dot > 0 ? lastPart.substring(0, dot) : lastPart;
  const sanitized = nameWithoutExt.replace(SANITIZE_NAME_RE, "_").substring(0, 40);

  if (parts.length >= 2 && CDN_VARIANT_NAMES[sanitized.toLowerCase()]) {
    const parent = parts[parts.length - 2]!.replace(SANITIZE_NAME_RE, "_").substring(0, 30);
    if (parent.length >= 4) return `${parent}_${sanitized}`.substring(0, 40);
  }
  return sanitized;
}

/** CL `sanitizeMediaFilename`: bare form, no CDN parent rule. */
export function sanitizeMediaFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const nameWithoutExt = dot > 0 ? filename.substring(0, dot) : filename;
  return nameWithoutExt.replace(SANITIZE_NAME_RE, "_").substring(0, 40);
}

/** CL `extractFilenameFromUrl`: last path segment, never the query string. */
export function extractFilenameFromUrl(url: string): string {
  const parts = urlPathParts(url);
  if (parts) return parts[parts.length - 1] ?? "";
  const raw = url.split("/");
  return raw[raw.length - 1]?.split("?")[0] ?? "";
}

/** CL `mediaUrlHash8`: 8-hex FNV-1a of the full URL string. */
export function mediaUrlHash8(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * CL `qualifiedMediaName`: `{urlhash8}_{parent_}{bare}`, capped 40. The hash
 * prefix makes the name URL-exact, so a lookup can never hit a file written
 * for a different URL that happens to share parent + filename.
 */
export function qualifiedMediaName(url: string): string {
  const bare = extractSanitizedUrlName(url);
  if (!bare) return "";
  let parent = "";
  const parts = urlPathParts(url);
  if (parts && parts.length >= 2) {
    const lastRaw = parts[parts.length - 1]!;
    const dot = lastRaw.lastIndexOf(".");
    const lastNoExt = dot > 0 ? lastRaw.substring(0, dot) : lastRaw;
    const variantForm = !!CDN_VARIANT_NAMES[lastNoExt.replace(SANITIZE_NAME_RE, "_").toLowerCase()];
    if (!variantForm) {
      const p = parts[parts.length - 2]!.replace(SANITIZE_NAME_RE, "_").substring(0, 20);
      if (p.length >= 4) parent = `${p}_`;
    }
  }
  return `${mediaUrlHash8(url)}_${parent}${bare}`.substring(0, 40);
}

/**
 * CL `computeEffectiveMediaNames`: every URL keeps its bare name; only groups
 * of >= 2 distinct URLs sharing a bare name are promoted to the qualified form.
 */
export function computeEffectiveMediaNames(urls: readonly string[]): Map<string, string> {
  const effective = new Map<string, string>();
  const byBare = new Map<string, string[]>();
  for (const url of new Set(urls)) {
    const bare = extractSanitizedUrlName(url);
    effective.set(url, bare);
    if (!bare) continue;
    const key = bare.toLowerCase();
    const group = byBare.get(key);
    if (group) group.push(url);
    else byBare.set(key, [url]);
  }
  for (const group of byBare.values()) {
    if (group.length < 2) continue;
    for (const url of group) effective.set(url, qualifiedMediaName(url));
  }
  return effective;
}

// ─── Gallery file index ─────────────────────────────────────────────────────

/** CL `localizedPattern` (index.js:1410 / library.js:24979). */
const LOCALIZED_MEDIA_RE = /^(?:(?:localized_media|lorebook_media)_\d+|[a-z]+gallery_[a-f0-9]+)_(.+)\.[^.]+$/;
const MEDIA_FILE_RE = /\.(png|jpg|jpeg|webp|gif|bmp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i;

export type GalleryAssetClass =
  | "localized_media"
  | "lorebook_media"
  | "provider_gallery"
  | "original_name";

/** Classify a gallery filename the way CL's prefix-priority logic does. */
export function classifyGalleryAsset(fileName: string): GalleryAssetClass {
  if (fileName.startsWith("localized_media_")) return "localized_media";
  if (fileName.startsWith("lorebook_media_")) return "lorebook_media";
  if (/^[a-z]+gallery_[a-f0-9]+_/.test(fileName)) return "provider_gallery";
  return "original_name";
}

export interface GalleryFileIndex {
  /** `__sanitized__<suffix>` → candidate local filenames (all collisions kept). */
  sanitized: Map<string, string[]>;
  /** `__filename__<stem>` → candidate local filenames. */
  filename: Map<string, string[]>;
}

function pushCandidate(map: Map<string, string[]>, key: string, fileName: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(fileName)) existing.push(fileName);
  } else {
    map.set(key, [fileName]);
  }
}

/**
 * Rebuild CL's `buildMediaLocalizationMap` index over a directory listing.
 * Identical to CL's key space, except collisions keep all candidates so the
 * audit can surface ambiguity instead of silently overwriting.
 */
export function buildGalleryFileIndex(fileNames: readonly string[]): GalleryFileIndex {
  const index: GalleryFileIndex = { sanitized: new Map(), filename: new Map() };
  for (const fileName of fileNames) {
    if (!MEDIA_FILE_RE.test(fileName)) continue;
    const match = LOCALIZED_MEDIA_RE.exec(fileName);
    if (match) pushCandidate(index.sanitized, `__sanitized__${match[1]!}`, fileName);
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.substring(0, dot) : fileName;
    pushCandidate(index.filename, `__filename__${stem}`, fileName);
  }
  return index;
}

export type MediaMatchRule = "qualified" | "filename" | "sanitized" | "cdn";
export type MediaMatchStatus = "unique" | "ambiguous" | "missing";

export interface MediaLookupResult {
  status: MediaMatchStatus;
  /** Resolved filename for a unique match. */
  file?: string;
  /** Every candidate when the rule key is shared. */
  candidates?: string[];
  rule?: MediaMatchRule;
  /** The derived name that produced the hit (or the name tried when missing). */
  derivedName: string;
}

function lookupKey(
  index: GalleryFileIndex,
  kind: "sanitized" | "filename",
  key: string,
): { rule: MediaMatchRule; files: string[] } | null {
  const files = index[kind].get(key);
  if (!files || files.length === 0) return null;
  return { rule: kind === "sanitized" ? "sanitized" : "filename", files };
}

/**
 * CL `lookupLocalizedMedia` order: qualified → raw filename → sanitized →
 * CDN-aware. The audit reports ambiguity rather than choosing, so a key with
 * multiple candidates never silently resolves.
 */
export function lookupLocalizedMedia(index: GalleryFileIndex, url: string): MediaLookupResult {
  const qualified = qualifiedMediaName(url);
  if (qualified) {
    const hit = lookupKey(index, "sanitized", `__sanitized__${qualified}`);
    if (hit) return finalize(hit.files, "qualified", qualified);
  }

  const filename = extractFilenameFromUrl(url);
  if (filename) {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.substring(0, dot) : filename;
    const direct = lookupKey(index, "filename", `__filename__${stem}`);
    if (direct) return finalize(direct.files, "filename", stem);
  }

  const sanitizedName = sanitizeMediaFilename(filename);
  const bySanitized = lookupKey(index, "sanitized", `__sanitized__${sanitizedName}`);
  if (bySanitized) return finalize(bySanitized.files, "sanitized", sanitizedName);

  const cdnAwareName = extractSanitizedUrlName(url);
  if (cdnAwareName && cdnAwareName !== sanitizedName) {
    const byCdn = lookupKey(index, "sanitized", `__sanitized__${cdnAwareName}`);
    if (byCdn) return finalize(byCdn.files, "cdn", cdnAwareName);
  }

  return { status: "missing", derivedName: sanitizedName };
}

function finalize(files: string[], rule: MediaMatchRule, derivedName: string): MediaLookupResult {
  if (files.length > 1) {
    return { status: "ambiguous", candidates: [...files], rule, derivedName };
  }
  return { status: "unique", file: files[0]!, rule, derivedName };
}

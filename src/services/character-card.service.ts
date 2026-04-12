import { inflateSync } from "zlib";
import { unzipSync } from "fflate";
import type { CreateCharacterInput } from "../types/character";
import type { CreateRegexScriptInput, RegexTarget } from "../types/regex-script";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024; // 100 MB (PNG text chunks)
const MAX_CHARX_SIZE = 1000 * 1024 * 1024; // 1000 MB

/**
 * Reads PNG chunks and extracts the text value for a given keyword.
 * Handles tEXt, zTXt, and iTXt chunk types.
 */
function extractPngTextChunk(buffer: Buffer, keyword: string): string | null {
  // Verify PNG signature
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG file");
  }

  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd > buffer.length) break;

    if (type === "tEXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const key = data.toString("ascii", 0, nullIdx);
        if (key === keyword) {
          return data.toString("latin1", nullIdx + 1);
        }
      }
    } else if (type === "zTXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const key = data.toString("ascii", 0, nullIdx);
        if (key === keyword) {
          // byte after null is compression method (0 = deflate), then compressed data
          const compressed = data.subarray(nullIdx + 2);
          const decompressed = inflateSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
          return decompressed.toString("utf-8");
        }
      }
    } else if (type === "iTXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const key = data.toString("ascii", 0, nullIdx);
        if (key === keyword) {
          // iTXt: keyword\0 compression_flag(1) compression_method(1) language\0 translated_keyword\0 text
          const compressionFlag = data[nullIdx + 1];
          let pos = nullIdx + 3; // skip compression_flag + compression_method
          // skip language tag (null-terminated)
          const langEnd = data.indexOf(0, pos);
          if (langEnd === -1) break;
          pos = langEnd + 1;
          // skip translated keyword (null-terminated)
          const transEnd = data.indexOf(0, pos);
          if (transEnd === -1) break;
          pos = transEnd + 1;

          const textData = data.subarray(pos);
          if (compressionFlag === 1) {
            const decompressed = inflateSync(textData, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
            return decompressed.toString("utf-8");
          }
          return textData.toString("utf-8");
        }
      }
    } else if (type === "IEND") {
      break;
    }

    // Move to next chunk: length + type(4) + data(length) + crc(4)
    offset = dataEnd + 4;
  }

  return null;
}

// ── Image type detection ────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|avif|bmp|svg)$/i;

// ── JPEG+ZIP polyglot detection (RisuAI card format) ─────────────────────────

/**
 * Scans for a JPEG image followed by an appended ZIP archive (polyglot format).
 * Returns the byte offset where the ZIP data begins, or -1 if not a polyglot.
 *
 * RisuAI stores character cards as JPEG+ZIP polyglots: a small JPEG preview
 * image is prepended to the ZIP archive. Standard image viewers see the JPEG;
 * ZIP tools read the central directory from the end and see the archive.
 * fflate cannot parse these directly — the JPEG prefix must be stripped first.
 */
export function findJpegZipBoundary(data: Uint8Array): number {
  // Must start with JPEG SOI + marker (FF D8 FF)
  if (data.length < 10 || data[0] !== 0xFF || data[1] !== 0xD8 || data[2] !== 0xFF) {
    return -1;
  }

  // Scan for JPEG EOI (FF D9) immediately followed by ZIP local file header (PK\x03\x04).
  // JPEG portion is typically small (< 5 MB), so cap the scan range.
  const limit = Math.min(data.length - 5, 10_000_000);
  for (let i = 2; i < limit; i++) {
    if (
      data[i] === 0xFF && data[i + 1] === 0xD9 &&
      data[i + 2] === 0x50 && data[i + 3] === 0x4B &&
      data[i + 4] === 0x03 && data[i + 5] === 0x04
    ) {
      return i + 2; // ZIP starts right after the EOI marker
    }
  }

  return -1;
}

/**
 * Lightweight pre-filter: returns true if the buffer starts with a JPEG+ZIP polyglot.
 * Accepts a partial buffer (first N bytes) for cheap detection before reading the full file.
 */
export function looksLikeJpegZipPolyglot(header: Uint8Array): boolean {
  return findJpegZipBoundary(header) >= 0;
}

// ── RPack decode (RisuAI byte-substitution obfuscation) ──────────────────────

// prettier-ignore
const RPACK_DECODE_MAP = new Uint8Array([
  0x2c,0xf7,0x84,0x8b,0xc9,0x65,0xfb,0xb6,0x9f,0xae,0xb3,0x03,0x2d,0x01,0x69,0x74,
  0x1f,0xe4,0xa3,0xec,0xee,0x5c,0x34,0x21,0x93,0x4a,0x0f,0x6a,0xe2,0x62,0x02,0x9e,
  0x22,0x9c,0xfd,0x3c,0xfc,0x71,0xc7,0xc6,0xad,0x59,0x67,0x05,0x70,0x6d,0x8a,0x44,
  0x12,0xfa,0x24,0x86,0x5f,0xaf,0xd1,0x7a,0x47,0xce,0xfe,0x50,0x63,0xdd,0x51,0x06,
  0x6f,0x18,0xe0,0x52,0xa8,0x09,0x9d,0x56,0x73,0x4c,0xb8,0x53,0x6c,0xc3,0xa0,0x0e,
  0x19,0xcf,0x3e,0x0d,0x7e,0x07,0x32,0x68,0x46,0xea,0x48,0xf9,0x99,0x2e,0xab,0xa4,
  0x49,0x20,0x5e,0x55,0x35,0x38,0x0c,0xbc,0xd3,0xb1,0x58,0x16,0x79,0x28,0x0a,0x1a,
  0xe1,0xf2,0xcd,0xc4,0x39,0xdb,0xa2,0xba,0x60,0x72,0x76,0x7d,0x95,0xef,0x7f,0xc8,
  0xc0,0xde,0x37,0x94,0xbf,0xb5,0x14,0x81,0x92,0x25,0x45,0xac,0xe7,0xf5,0x66,0xa7,
  0x2b,0x36,0x5a,0xc1,0x13,0xe3,0x4b,0x3a,0xe8,0x8d,0x83,0x1b,0x7c,0x27,0xb0,0x9a,
  0x42,0xeb,0x87,0xaa,0xdc,0x54,0x8e,0x78,0x26,0xd2,0x57,0x29,0xd4,0xb7,0xf8,0x2f,
  0x8f,0x89,0x75,0xf0,0x41,0x77,0xc2,0x1e,0xff,0xd8,0x15,0x11,0xe5,0x04,0x97,0x17,
  0xf3,0x31,0xd0,0x9b,0x00,0xd7,0xca,0xb4,0x4f,0x2a,0x3b,0xd9,0xb2,0x6b,0xda,0x5d,
  0xa1,0x3f,0x30,0x61,0xbd,0x91,0x3d,0x4e,0xe6,0xdf,0xbe,0x4d,0x82,0x8c,0x1d,0x23,
  0x10,0x98,0x64,0xf4,0x85,0x33,0x7b,0x90,0x43,0xbb,0xa9,0x88,0xf1,0xd6,0xa5,0x1c,
  0xf6,0xcc,0x6e,0xb9,0x5b,0x0b,0x96,0xed,0xd5,0xe9,0xc5,0xcb,0x08,0xa6,0x80,0x40,
]);

const RPACK_MAGIC = 111;
const RPACK_VERSION = 0;

export interface RisuModule {
  name: string;
  description: string;
  lorebook?: RisuLorebook[];
  regex?: RisuRegex[];
  trigger?: unknown[];
  assets?: [string, string, string][];
}

interface RisuLorebook {
  key: string;
  secondkey?: string;
  comment?: string;
  content: string;
  mode?: string;
  insertorder?: number;
  alwaysActive?: boolean;
  selective?: boolean;
  [key: string]: unknown;
}

interface RisuRegex {
  comment: string;
  in: string;
  out: string;
  type: string;
  ableFlag?: boolean;
}

/**
 * Decodes an RPack-encoded buffer using the static byte substitution table.
 */
function decodeRPack(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = RPACK_DECODE_MAP[data[i]];
  }
  return result;
}

/**
 * Parses a .risum (RisuAI module) binary blob.
 * Format: magic(1) + version(1) + payloadLen(u32 LE) + RPack-encoded JSON + [assets...] + 0x00
 */
export function decodeRisuModule(data: Uint8Array): RisuModule | null {
  if (data.length < 7) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] !== RPACK_MAGIC || data[1] !== RPACK_VERSION) return null;

  const payloadLen = view.getUint32(2, true);
  if (6 + payloadLen > data.length) return null;

  const encoded = data.subarray(6, 6 + payloadLen);
  const decoded = decodeRPack(encoded);
  const jsonStr = new TextDecoder().decode(decoded);

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed?.type === "risuModule" && parsed.module) {
      return parsed.module as RisuModule;
    }
  } catch { /* malformed JSON — skip */ }

  return null;
}

const RISU_TYPE_TO_TARGET: Record<string, RegexTarget> = {
  editdisplay: "display",
  editprocess: "prompt",
  editoutput: "response",
  editinput: "prompt",
};

/**
 * Converts RisuAI module regex scripts to Lumiverse CreateRegexScriptInput[].
 */
export function convertRisuRegexScripts(
  regexes: RisuRegex[],
  characterId: string
): CreateRegexScriptInput[] {
  const results: CreateRegexScriptInput[] = [];

  for (let i = 0; i < regexes.length; i++) {
    const r = regexes[i];
    if (!r.in) continue;

    const target = RISU_TYPE_TO_TARGET[r.type] ?? "display";

    results.push({
      name: r.comment || `Imported RisuAI Script ${i + 1}`,
      find_regex: r.in,
      replace_string: r.out ?? "",
      flags: "gs",
      placement: ["ai_output"],
      scope: "character",
      scope_id: characterId,
      target,
      disabled: r.ableFlag === false,
      sort_order: i,
      description: `Imported from RisuAI module`,
      metadata: { source: "risuai_module", original_type: r.type },
    });
  }

  return results;
}

/**
 * Maps raw character card data (V1/V2/V3 spec) to our CreateCharacterInput.
 */
function mapCardToInput(data: Record<string, any>): CreateCharacterInput {
  const name = data.name;
  if (!name || (typeof name === "string" && name.trim() === "")) {
    throw new Error("Character card is missing required 'name' field");
  }

  const input: CreateCharacterInput = { name };

  const directFields = [
    "description", "personality", "scenario", "first_mes", "mes_example",
    "creator", "creator_notes", "system_prompt", "post_history_instructions",
  ] as const;

  for (const field of directFields) {
    if (data[field] !== undefined) {
      input[field] = String(data[field]);
    }
  }

  if (Array.isArray(data.tags)) input.tags = data.tags;
  if (Array.isArray(data.alternate_greetings)) input.alternate_greetings = data.alternate_greetings;

  const extensions: Record<string, any> = data.extensions && typeof data.extensions === "object"
    ? { ...data.extensions }
    : {};

  if (data.character_book) extensions.character_book = data.character_book;
  if (data.character_version !== undefined) extensions.character_version = data.character_version;

  if (Object.keys(extensions).length > 0) input.extensions = extensions;

  return input;
}

/**
 * Extracts character card JSON from a PNG file's tEXt/zTXt/iTXt chunk.
 * Checks for "chara" (V1/V2 standard) and "ccv3" (V3 standard) keywords.
 */
export async function extractCardFromPng(file: File): Promise<CreateCharacterInput> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const charaText = extractPngTextChunk(buffer, "chara") ?? extractPngTextChunk(buffer, "ccv3");

  if (!charaText) {
    throw new Error("PNG does not contain a character card (no 'chara' or 'ccv3' text chunk found)");
  }

  // Character cards store base64-encoded JSON in the text chunk
  const jsonStr = Buffer.from(charaText, "base64").toString("utf-8");

  let json: any;
  try {
    json = JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse character card JSON from PNG text chunk");
  }

  return parseCardJson(json);
}

/**
 * Parses character card JSON — handles V1 (flat), V2, and V3 (wrapped) formats.
 */
export function parseCardJson(json: unknown): CreateCharacterInput {
  if (!json || typeof json !== "object") {
    throw new Error("Invalid character card: expected a JSON object");
  }

  const obj = json as Record<string, any>;

  // V2/V3 wrapped format
  if ((obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3") && obj.data) {
    return mapCardToInput(obj.data);
  }

  // V1 flat format or plain CreateCharacterInput
  return mapCardToInput(obj);
}

const GALLERY_ASSET_RE = /^assets\/(icon|other)\//i;

const MIME_MAP: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", svg: "image/svg+xml",
};

function imageFileFromBytes(bytes: Uint8Array, path: string): File {
  const basename = path.split("/").pop() || "image.png";
  const ext = basename.split(".").pop()?.toLowerCase() || "png";
  return new File([new Uint8Array(bytes).buffer as ArrayBuffer], basename, { type: MIME_MAP[ext] || "image/png" });
}

// ── RisuAI expression heuristic ───────────────────────────────────────────────

/** Keywords whose presence in an expression label indicates NSFW content. */
const NSFW_CONTENT_KEYWORDS = [
  "cumshot", "creampie", "position", "missionary", "cowgirl", "doggystyle",
  "fellatio", "blowjob", "footjob", "paizuri", "handjob", "titjob", "boobjob",
  "masturbation", "fingering", "congress", "straddle", "nelson", "spooning",
  "mating press", "riding", "penetrat", "thrust",
  "nude", "naked", "topless", "bottomless", "undress",
  "showing armpit", "showing nude", "breast caress",
  "nsfw", "lewd", "sex", "orgasm",
  "anal", "vaginal", "oral",
];

/** Pattern for generic non-expression asset names (backgrounds, UI, etc.). */
const NON_EXPRESSION_NAME_RE = /^(bg\d*|background\d*|overlay|ui|icon|banner|logo|header|footer|frame|border)$/i;

/** Returns true if the label looks like an expression asset (not a background/UI element). */
function isExpressionAsset(label: string): boolean {
  const suffix = label.includes("_") ? label.slice(label.lastIndexOf("_") + 1) : label;
  if (NON_EXPRESSION_NAME_RE.test(suffix.trim())) return false;
  if (NON_EXPRESSION_NAME_RE.test(label.trim())) return false;
  return true;
}

/** Returns true if an expression label contains NSFW content keywords. */
export function isNsfwExpressionLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return NSFW_CONTENT_KEYWORDS.some((kw) => lower.includes(kw));
}

export interface CharxExpressionAsset {
  /** Expression label derived from the asset name. */
  label: string;
  /** The image File ready for upload. */
  file: File;
}

// ── Multi-character expression group analysis ────────────────────────────────

export interface ExpressionGroupAnalysis {
  /** True when multiple distinct character groups are detected in the expression assets. */
  isMultiCharacter: boolean;
  /**
   * Character name → { cleanLabel → originalAssetLabel }.
   * `cleanLabel` is the expression/outfit portion (e.g., "Clothed_angry").
   * `originalAssetLabel` is the full asset name for risuAssetMap lookup (e.g., "Zhu Yuan_Clothed_angry.webp").
   * The special key `_default` holds labels that had no character prefix (just outfit_expression).
   */
  groups: Record<string, Record<string, string>>;
}

/**
 * Analyzes expression asset labels for multi-character grouping patterns.
 *
 * Naming convention (RisuAI): `{CharacterName}_{Outfit}_{Expression}.ext`
 * where character names use spaces (not underscores) and fields are separated by `_`.
 *
 * Detection heuristic: split each label on the first `_` and group by prefix.
 * If ≥3 prefixes share the same suffix count, they are character groups.
 * Prefixes that also appear as sub-prefixes within other groups' suffixes
 * are outfit names (e.g., "Nude", "Clothed"), not character names.
 */
export function analyzeExpressionGroups(labels: string[]): ExpressionGroupAnalysis {
  const empty: ExpressionGroupAnalysis = { isMultiCharacter: false, groups: {} };
  if (labels.length < 10) return empty;

  // First pass: split on first underscore, group by prefix
  const prefixGroups = new Map<string, string[]>();
  for (const label of labels) {
    const idx = label.indexOf("_");
    if (idx > 0) {
      const prefix = label.slice(0, idx);
      const suffix = label.slice(idx + 1);
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
      prefixGroups.get(prefix)!.push(suffix);
    }
  }

  if (prefixGroups.size < 3) return empty;

  // Detect outfit-only prefixes: a prefix P is an outfit if it appears
  // as a sub-prefix within another group's suffixes (e.g., "Nude" appears
  // in "Zhu Yuan"'s suffixes as "Nude_angry.webp")
  const outfitPrefixes = new Set<string>();
  for (const [, suffixes] of prefixGroups) {
    for (const suffix of suffixes) {
      const subIdx = suffix.indexOf("_");
      if (subIdx > 0) {
        const subPrefix = suffix.slice(0, subIdx);
        if (prefixGroups.has(subPrefix)) {
          outfitPrefixes.add(subPrefix);
        }
      }
    }
  }

  // Count group sizes to find the dominant pattern (character groups share a size)
  const sizeToPrefix = new Map<number, string[]>();
  for (const [prefix, suffixes] of prefixGroups) {
    if (outfitPrefixes.has(prefix)) continue; // skip outfit-only prefixes
    const size = suffixes.length;
    if (!sizeToPrefix.has(size)) sizeToPrefix.set(size, []);
    sizeToPrefix.get(size)!.push(prefix);
  }

  // Find the largest cluster of prefixes that share the same suffix count
  let characterPrefixes: string[] = [];
  for (const [, prefixes] of sizeToPrefix) {
    if (prefixes.length > characterPrefixes.length) {
      characterPrefixes = prefixes;
    }
  }

  if (characterPrefixes.length < 3) return empty;

  // Build groups: characterName → { cleanLabel → originalAssetLabel }
  const characterSet = new Set(characterPrefixes);
  const groups: Record<string, Record<string, string>> = {};

  for (const [prefix, suffixes] of prefixGroups) {
    if (!characterSet.has(prefix)) continue;
    const mapping: Record<string, string> = {};
    for (const suffix of suffixes) {
      const cleanLabel = suffix.replace(/\.\w+$/, ""); // strip file extension
      mapping[cleanLabel] = `${prefix}_${suffix}`;
    }
    groups[prefix] = mapping;
  }

  // Outfit-only labels (no character prefix) → _default group
  if (outfitPrefixes.size > 0) {
    const defaultMapping: Record<string, string> = {};
    for (const outfit of outfitPrefixes) {
      for (const suffix of prefixGroups.get(outfit) || []) {
        const cleanLabel = `${outfit}_${suffix}`.replace(/\.\w+$/, "");
        defaultMapping[cleanLabel] = `${outfit}_${suffix}`;
      }
    }
    if (Object.keys(defaultMapping).length > 0) {
      groups["_default"] = defaultMapping;
    }
  }

  return { isMultiCharacter: true, groups };
}

export interface BundledRegexScript {
  name: string;
  find_regex: string;
  replace_string: string;
  flags: string;
  placement: string[];
  scope: string;
  scope_id: string | null;
  target: string;
  min_depth: number | null;
  max_depth: number | null;
  trim_strings: string[];
  run_on_edit: boolean;
  substitute_macros: string;
  disabled: boolean;
  sort_order: number;
  description: string;
  metadata: Record<string, any>;
}

export interface LumiverseModules {
  version: number;
  /** True when any expression label matches NSFW content keywords. */
  has_nsfw_expressions?: boolean;
  expressions?: {
    enabled: boolean;
    defaultExpression: string;
    mappings: Record<string, string>; // label → archive path
  };
  /** Multi-character expression groups: characterName → { label → archivePath }. */
  expression_groups?: {
    groups: Record<string, Record<string, string>>;
  };
  alternate_fields?: Record<string, Array<{ id: string; label: string; content: string }>>;
  alternate_avatars?: Array<{ id: string; label: string; path: string }>;
  world_books?: Record<string, any>[];
  regex_scripts?: BundledRegexScript[];
}

export interface CharxResult {
  card: CreateCharacterInput;
  /** The avatar image file extracted from the archive, if found. */
  avatarFile: File | null;
  /** Additional images from assets/icon/ and assets/other/ for the gallery. */
  galleryFiles: File[];
  /** Decoded RisuAI module from module.risum, if present in the archive. */
  risuModule: RisuModule | null;
  /** Expression-like images detected from x-risu-asset entries via heuristic. */
  expressionAssets: CharxExpressionAsset[];
  /** Decoded Lumiverse modules from lumiverse_modules.json, if present. */
  lumiverseModules: LumiverseModules | null;
  /** All image files keyed by their archive path (for Lumiverse module asset lookup). */
  assetFiles: Map<string, File>;
  /** Multi-character expression grouping analysis, if expression assets were detected. */
  expressionGroupAnalysis: ExpressionGroupAnalysis | null;
  /** For JPEG+ZIP polyglots: the JPEG portion as a fallback avatar image. */
  polyglotJpegAvatar: File | null;
}

/**
 * Extracts a character card and optional avatar from a .charx ZIP archive.
 *
 * Per the CCV3 spec, the ZIP must contain `card.json` at the root.
 * Avatar images are searched in `assets/icon/images/` first, then any
 * image file in the archive root or `assets/` tree.
 *
 * Uses fflate with a filter callback to only decompress card.json and
 * image files, skipping all other assets (audio, video, etc.) for speed.
 */
export async function extractCardFromCharx(file: File): Promise<CharxResult> {
  const arrayBuf = await file.arrayBuffer();
  if (arrayBuf.byteLength > MAX_CHARX_SIZE) {
    throw new Error(`CHARX file too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)} MB, max ${MAX_CHARX_SIZE / 1024 / 1024} MB)`);
  }

  let data = new Uint8Array(arrayBuf);

  // Handle JPEG+ZIP polyglot (e.g., RisuAI card files where a JPEG preview
  // is prepended to the ZIP archive). fflate cannot parse these directly —
  // the JPEG prefix must be stripped first.
  let polyglotJpegAvatar: File | null = null;
  const zipBoundary = findJpegZipBoundary(data);
  if (zipBoundary > 0) {
    polyglotJpegAvatar = new File(
      [data.slice(0, zipBoundary)],
      "avatar.jpg",
      { type: "image/jpeg" },
    );
    data = data.subarray(zipBoundary);
  }

  // Only decompress card.json, module files, and image files — skip everything else
  const unzipped = unzipSync(data, {
    filter: (entry) =>
      entry.name === "card.json" ||
      entry.name === "module.risum" ||
      entry.name === "lumiverse_modules.json" ||
      IMAGE_EXTENSIONS.test(entry.name),
  });

  const cardBytes = unzipped["card.json"];
  if (!cardBytes) {
    throw new Error("CHARX archive does not contain card.json at the root");
  }

  let json: any;
  try {
    json = JSON.parse(new TextDecoder().decode(cardBytes));
  } catch {
    throw new Error("Failed to parse card.json from CHARX archive");
  }

  const card = parseCardJson(json);

  // Find the best avatar image:
  // 1. assets/icon/images/* (spec-recommended location)
  // 2. Any image at the root
  // 3. Any image anywhere in assets/
  const imagePaths = Object.keys(unzipped).filter(
    (p) => p !== "card.json" && IMAGE_EXTENSIONS.test(p)
  );

  const avatarPath =
    imagePaths.find((p) => p.startsWith("assets/icon/image/")) ??
    imagePaths.find((p) => !p.includes("/")) ??
    imagePaths.find((p) => p.startsWith("assets/"));

  let avatarFile = avatarPath
    ? imageFileFromBytes(unzipped[avatarPath], avatarPath)
    : null;

  // Collect additional images from assets/icon/ and assets/other/ for the gallery
  const galleryFiles: File[] = [];
  for (const p of imagePaths) {
    if (p === avatarPath) continue;
    if (GALLERY_ASSET_RE.test(p)) {
      galleryFiles.push(imageFileFromBytes(unzipped[p], p));
    }
  }

  // Decode RisuAI module if present
  let risuModule: RisuModule | null = null;
  const moduleBytes = unzipped["module.risum"];
  if (moduleBytes) {
    try {
      risuModule = decodeRisuModule(moduleBytes);
    } catch { /* malformed module — skip */ }
  }

  // Detect expression-like images from x-risu-asset entries
  const expressionAssets: CharxExpressionAsset[] = [];
  const rawData = (json as Record<string, any>).data ?? json;
  const cardAssets: any[] = Array.isArray(rawData.assets) ? rawData.assets : [];
  const risuExprAssets = cardAssets.filter(
    (a: any) => a.type === "x-risu-asset" && a.name && a.uri
  );

  if (risuExprAssets.length > 0) {
    for (const asset of risuExprAssets) {
      if (!isExpressionAsset(asset.name)) continue;

      // Resolve embeded:// URI → ZIP path (e.g. "embeded://assets/other/image/X.webp" → "assets/other/image/X.webp")
      const zipPath = (asset.uri as string).replace(/^embeded:\/\//, "");
      const bytes = unzipped[zipPath];
      if (!bytes || bytes.length === 0) continue;

      const label = asset.name as string;
      expressionAssets.push({ label, file: imageFileFromBytes(bytes, zipPath) });
    }
  }

  // Decode Lumiverse modules if present
  let lumiverseModules: LumiverseModules | null = null;
  const lumiverseBytes = unzipped["lumiverse_modules.json"];
  if (lumiverseBytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(lumiverseBytes));
      if (parsed && typeof parsed === "object" && typeof parsed.version === "number") {
        lumiverseModules = parsed as LumiverseModules;
      }
    } catch { /* malformed modules JSON — skip */ }
  }

  // Build assetFiles map (archive-path → File) for Lumiverse module asset lookup
  const assetFiles = new Map<string, File>();
  for (const p of imagePaths) {
    assetFiles.set(p, imageFileFromBytes(unzipped[p], p));
  }

  // Analyze expression grouping for multi-character detection
  const expressionGroupAnalysis = expressionAssets.length > 0
    ? analyzeExpressionGroups(expressionAssets.map((a) => a.label))
    : null;

  // For polyglot files: use JPEG avatar as fallback if no avatar found in the archive
  if (!avatarFile && polyglotJpegAvatar) {
    avatarFile = polyglotJpegAvatar;
    polyglotJpegAvatar = null; // consumed — don't return as separate field
  }

  return {
    card, avatarFile, galleryFiles, risuModule, expressionAssets,
    lumiverseModules, assetFiles, expressionGroupAnalysis, polyglotJpegAvatar,
  };
}

// ── Inline asset reference resolution ────────────────────────────────────────

const INLINE_IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const INLINE_MD_IMG_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const INLINE_RISU_IMG_RE = /<img="([^"]+)">/gi;

/** Extracts the stem (filename without extension) from a path or filename. */
export function fileStem(pathOrName: string): string {
  const base = pathOrName.split("/").pop() || pathOrName;
  const dotIdx = base.lastIndexOf(".");
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}

/**
 * Resolves inline asset references (`embeded://`, relative filenames) in
 * character text fields to `/api/v1/images/{id}` URLs.
 *
 * Called at CharX import time after all archive images have been uploaded.
 * Builds a multi-level lookup (exact path → basename → stem) to match
 * references that may differ in path prefix or file extension.
 *
 * @param fields Text fields to scan (string or string[] values)
 * @param assetImageMap Archive path → uploaded image ID
 * @returns Object with only the fields that were modified (empty if none changed)
 */
export function resolveInlineAssetReferences(
  fields: Record<string, string | string[] | undefined>,
  assetImageMap: Map<string, string>,
): Record<string, string | string[]> {
  if (assetImageMap.size === 0) return {};

  // Build tiered lookup tables — higher priority first
  const exactLookup = new Map<string, string>();   // full path / embeded:// URI
  const baseLookup = new Map<string, string>();     // basename (with extension)
  const stemLookup = new Map<string, string>();     // stem (without extension)

  for (const [archivePath, imageId] of assetImageMap) {
    const apiUrl = `/api/v1/images/${imageId}`;
    exactLookup.set(archivePath, apiUrl);
    exactLookup.set(`embeded://${archivePath}`, apiUrl);

    const basename = archivePath.split("/").pop()!;
    if (!baseLookup.has(basename)) baseLookup.set(basename, apiUrl);

    const stem = fileStem(basename);
    if (!stemLookup.has(stem)) stemLookup.set(stem, apiUrl);
  }

  function resolve(src: string): string | undefined {
    return exactLookup.get(src)
      ?? baseLookup.get(src)
      ?? stemLookup.get(fileStem(src));
  }

  function resolveText(text: string): string {
    let result = text;

    // Resolve <img ... src="..."> tags
    INLINE_IMG_SRC_RE.lastIndex = 0;
    result = result.replace(INLINE_IMG_SRC_RE, (match, src) => {
      const resolved = resolve(src);
      return resolved ? match.replace(src, resolved) : match;
    });

    // Resolve ![alt](src) markdown images
    INLINE_MD_IMG_RE.lastIndex = 0;
    result = result.replace(INLINE_MD_IMG_RE, (match, src) => {
      const resolved = resolve(src);
      return resolved ? match.replace(src, resolved) : match;
    });

    // Resolve Risu-style <img="AssetName"> tags → <img src="/api/v1/images/{id}">
    INLINE_RISU_IMG_RE.lastIndex = 0;
    result = result.replace(INLINE_RISU_IMG_RE, (match, assetName) => {
      const resolved = resolve(assetName);
      return resolved ? `<img src="${resolved}">` : match;
    });

    return result;
  }

  const changes: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    if (typeof value === "string") {
      const resolved = resolveText(value);
      if (resolved !== value) changes[key] = resolved;
    } else if (Array.isArray(value)) {
      let changed = false;
      const resolved = value.map((v) => {
        const r = resolveText(v);
        if (r !== v) changed = true;
        return r;
      });
      if (changed) changes[key] = resolved;
    }
  }

  return changes;
}

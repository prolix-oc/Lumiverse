/**
 * Lightweight, bounded PNG metadata reader for the ST gallery audit.
 *
 * SillyTavern character cards store their payload as base64 JSON inside a
 * `chara` (V1/V2) or `ccv3` (V3) tEXt/zTXt/iTXt chunk near the start of the
 * file. The card image itself is tens of megabytes; the metadata is a few KB.
 *
 * This reader walks only the chunk header chain with positioned reads, so a
 * 17k-card audit touches a small fraction of the bytes on disk rather than the
 * whole library. It never decodes pixel data (IDAT) and never inflates more
 * than MAX_DECOMPRESSED_SIZE.
 */

import { inflateSync } from "node:zlib";
import { readFileRange } from "../../file-connections/range";
import type { FileSystem } from "../../file-connections/types";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNK_TYPES: Record<string, true> = { tEXt: true, zTXt: true, iTXt: true };
const CARD_KEYWORDS = ["chara", "ccv3"] as const;

/** Decompression bombs: a card payload is never legitimately larger than this. */
export const MAX_DECOMPRESSED_SIZE = 32 * 1024 * 1024;
/** Guard against a corrupt chunk length steering a *data read* off the file. */
const MAX_READABLE_CHUNK_BYTES = 64 * 1024 * 1024;

export interface CardMetadataResult {
  /** First present card payload key, preferring `chara` (matches Lumiverse's importer). */
  keyword: "chara" | "ccv3" | null;
  /** Decoded, parsed card JSON. Null when absent or unparseable. */
  json: Record<string, unknown> | null;
  /** Base64 payloads as stored, retained so callers can hash the raw text. */
  rawPayloads: Partial<Record<"chara" | "ccv3", string>>;
  /** True when at least one payload existed but could not be decoded/parsed. */
  malformed: boolean;
  error?: string;
}

interface TextChunk {
  keyword: string;
  text: string;
}

function decodeTextChunk(type: string, data: Buffer, nullIdx: number): string | null {
  if (type === "tEXt") {
    return data.subarray(nullIdx + 1).toString("latin1");
  }
  if (type === "zTXt") {
    const compressed = data.subarray(nullIdx + 2);
    return inflateSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_SIZE }).toString("latin1");
  }
  // iTXt: compression flag, compression method, language tag\0, translated keyword\0, text
  const compressedFlag = data[nullIdx + 1];
  const afterFlags = data.subarray(nullIdx + 3);
  const langEnd = afterFlags.indexOf(0);
  if (langEnd === -1) return null;
  const transKeyEnd = afterFlags.indexOf(0, langEnd + 1);
  if (transKeyEnd === -1) return null;
  const valueBytes = afterFlags.subarray(transKeyEnd + 1);
  if (!compressedFlag) return valueBytes.toString("utf8");
  return inflateSync(valueBytes, { maxOutputLength: MAX_DECOMPRESSED_SIZE }).toString("utf8");
}

/**
 * Walk PNG chunks with positioned reads, returning every requested text chunk.
 * Reads exactly 8 header bytes per chunk plus the payload of requested text
 * chunks, so pixel data (IDAT) is never touched. Stops at IEND or once every
 * requested keyword has been found.
 */
async function readTextChunks(
  fs: FileSystem,
  path: string,
  keywords: readonly string[],
): Promise<TextChunk[]> {
  const signature = await readFileRange(fs, path, 0, 8);
  if (signature.length < 8 || !signature.equals(PNG_SIGNATURE)) {
    throw new Error("not a valid PNG");
  }

  const found: TextChunk[] = [];
  const wanted = new Set<string>(keywords);
  let offset = 8;

  for (;;) {
    const header = await readFileRange(fs, path, offset, 8);
    if (header.length < 8) return found; // truncated file
    const length = header.readUInt32BE(0);
    const type = header.toString("ascii", 4, 8);
    const dataStart = offset + 8;

    if (type === "IEND") return found;

    // Never read a chunk larger than the guard. A card payload is small, so an
    // oversized tEXt/zTXt/iTXt is corruption; IDAT is simply skipped by seeking
    // (PNG data chunks can legitimately exceed 64 MB).
    if (length > MAX_READABLE_CHUNK_BYTES) {
      if (TEXT_CHUNK_TYPES[type]) {
        throw new Error(`implausible ${type} chunk length ${length}`);
      }
      offset = dataStart + length + 4;
      continue;
    }

    if (TEXT_CHUNK_TYPES[type]) {
      const data = await readFileRange(fs, path, dataStart, length);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = data.toString("ascii", 0, nullIdx);
        if (wanted.has(keyword)) {
          const decoded = decodeTextChunk(type, data, nullIdx);
          if (decoded !== null) found.push({ keyword, text: decoded });
          if (found.length >= keywords.length) return found;
        }
      }
    }

    // 4 length + 4 type + N data + 4 CRC
    offset = dataStart + length + 4;
  }
}

function decodeCardPayload(raw: string): Record<string, unknown> {
  const decoded = Buffer.from(raw.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("card payload is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Extract a character card from a PNG without reading the image data.
 * Prefers `chara` over `ccv3`, matching `character-card.service.extractCardFromPng`.
 */
export async function readCardMetadata(
  fs: FileSystem,
  path: string,
): Promise<CardMetadataResult> {
  let chunks: TextChunk[];
  try {
    chunks = await readTextChunks(fs, path, CARD_KEYWORDS);
  } catch (err) {
    return {
      keyword: null,
      json: null,
      rawPayloads: {},
      malformed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const byKeyword = new Map<string, string>();
  for (const chunk of chunks) {
    if (!byKeyword.has(chunk.keyword)) byKeyword.set(chunk.keyword, chunk.text);
  }

  const rawPayloads: CardMetadataResult["rawPayloads"] = {};
  if (byKeyword.has("chara")) rawPayloads.chara = byKeyword.get("chara");
  if (byKeyword.has("ccv3")) rawPayloads.ccv3 = byKeyword.get("ccv3");

  if (!rawPayloads.chara && !rawPayloads.ccv3) {
    return { keyword: null, json: null, rawPayloads, malformed: false };
  }

  for (const keyword of CARD_KEYWORDS) {
    const raw = rawPayloads[keyword];
    if (!raw) continue;
    try {
      return { keyword, json: decodeCardPayload(raw), rawPayloads, malformed: false };
    } catch (err) {
      return {
        keyword,
        json: null,
        rawPayloads,
        malformed: true,
        error: `${keyword} payload: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { keyword: null, json: null, rawPayloads, malformed: false };
}

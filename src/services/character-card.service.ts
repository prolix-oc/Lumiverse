import { inflateSync, inflateRawSync } from "zlib";
import type { CreateCharacterInput } from "../types/character";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_LOCAL_HEADER = 0x04034b50;
const MAX_DECOMPRESSED_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_CHARX_SIZE = 50 * 1024 * 1024; // 50 MB

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

// ── Minimal ZIP reader ──────────────────────────────────────────────────────

interface ZipEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number; // 0 = stored, 8 = deflate
  dataOffset: number;
}

/**
 * Parses ZIP local file headers to build an entry list.
 * Handles store (0) and deflate (8) compression methods.
 */
function parseZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== ZIP_LOCAL_HEADER) break;

    const compressionMethod = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const filenameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const filename = buf.toString("utf-8", offset + 30, offset + 30 + filenameLen);
    const dataOffset = offset + 30 + filenameLen + extraLen;

    entries.push({ filename, compressedSize, uncompressedSize, compressionMethod, dataOffset });

    // Advance past this entry's data
    offset = dataOffset + compressedSize;
  }

  return entries;
}

/**
 * Extracts the raw bytes of a ZIP entry.
 */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // Stored (uncompressed)
    return raw;
  } else if (entry.compressionMethod === 8) {
    // Deflate
    return inflateRawSync(raw, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
  }

  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

// ── Image type detection ────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|avif|bmp|svg)$/i;

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

export interface CharxResult {
  card: CreateCharacterInput;
  /** The avatar image file extracted from the archive, if found. */
  avatarFile: File | null;
}

/**
 * Extracts a character card and optional avatar from a .charx ZIP archive.
 *
 * Per the CCV3 spec, the ZIP must contain `card.json` at the root.
 * Avatar images are searched in `assets/icon/images/` first, then any
 * image file in the archive root or `assets/` tree.
 */
export async function extractCardFromCharx(file: File): Promise<CharxResult> {
  const arrayBuf = await file.arrayBuffer();
  if (arrayBuf.byteLength > MAX_CHARX_SIZE) {
    throw new Error(`CHARX file too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)} MB, max ${MAX_CHARX_SIZE / 1024 / 1024} MB)`);
  }

  const buf = Buffer.from(arrayBuf);

  // Validate ZIP signature
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    throw new Error("Not a valid CHARX file (invalid ZIP signature)");
  }

  const entries = parseZipEntries(buf);

  // Find card.json at the root of the archive
  const cardEntry = entries.find((e) => e.filename === "card.json");
  if (!cardEntry) {
    throw new Error("CHARX archive does not contain card.json at the root");
  }

  const cardBytes = readZipEntry(buf, cardEntry);
  let json: any;
  try {
    json = JSON.parse(cardBytes.toString("utf-8"));
  } catch {
    throw new Error("Failed to parse card.json from CHARX archive");
  }

  const card = parseCardJson(json);

  // Find the best avatar image:
  // 1. assets/icon/images/* (spec-recommended location)
  // 2. Any image at the root
  // 3. Any image anywhere in assets/
  let avatarEntry: ZipEntry | undefined;

  // Priority 1: spec-recommended icon path
  avatarEntry = entries.find(
    (e) => e.filename.startsWith("assets/icon/images/") && IMAGE_EXTENSIONS.test(e.filename)
  );

  // Priority 2: image at root level
  if (!avatarEntry) {
    avatarEntry = entries.find(
      (e) => !e.filename.includes("/") && IMAGE_EXTENSIONS.test(e.filename)
    );
  }

  // Priority 3: any image in assets/
  if (!avatarEntry) {
    avatarEntry = entries.find(
      (e) => e.filename.startsWith("assets/") && IMAGE_EXTENSIONS.test(e.filename)
    );
  }

  let avatarFile: File | null = null;
  if (avatarEntry) {
    const imageBytes = readZipEntry(buf, avatarEntry);
    const basename = avatarEntry.filename.split("/").pop() || "avatar.png";
    const ext = basename.split(".").pop()?.toLowerCase() || "png";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", avif: "image/avif",
      bmp: "image/bmp", svg: "image/svg+xml",
    };
    avatarFile = new File([imageBytes], basename, { type: mimeMap[ext] || "image/png" });
  }

  return { card, avatarFile };
}

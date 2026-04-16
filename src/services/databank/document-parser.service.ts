/**
 * Document Parser Service — Extracts plain text from various file formats.
 */

import { env } from "../../env";
import { join } from "path";

export interface ParsedDocument {
  text: string;
  metadata: Record<string, unknown>;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv",
  ".json", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".log", ".rst", ".rtf",
]);

export function isSupportedFormat(filename: string): boolean {
  const ext = filename.lastIndexOf(".") >= 0 ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function getSupportedExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS];
}

/**
 * Parse a file into plain text. Reads from the databank upload directory.
 */
export async function parseDocument(userId: string, filePath: string): Promise<ParsedDocument> {
  const fullPath = join(env.dataDir, "databank", userId, filePath);
  const file = Bun.file(fullPath);

  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = await file.text();
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";

  switch (ext) {
    case ".csv":
    case ".tsv":
      return parseCsv(raw, ext === ".tsv" ? "\t" : ",");
    case ".json":
      return parseJson(raw);
    case ".xml":
      return parseXml(raw);
    case ".html":
    case ".htm":
      return parseHtml(raw);
    case ".rtf":
      return parseRtf(raw);
    default:
      // .txt, .md, .markdown, .yaml, .yml, .log, .rst — read as-is
      return { text: raw, metadata: { format: ext.replace(".", "") } };
  }
}

function parseCsv(raw: string, delimiter: string): ParsedDocument {
  const records = parseCsvRecords(raw, delimiter);
  if (records.length === 0) return { text: "", metadata: { format: "csv", rows: 0 } };

  const headers = records[0];

  // Format as readable text: each row as "Header: Value" pairs
  const rows: string[] = [];
  for (let i = 1; i < records.length; i++) {
    const cols = records[i];
    const pairs = headers.map((h, j) => `${h}: ${cols[j] ?? ""}`);
    rows.push(pairs.join(", "));
  }

  return {
    text: `Columns: ${headers.join(", ")}\n\n${rows.join("\n")}`,
    metadata: { format: "csv", columns: headers, rows: rows.length },
  };
}

/**
 * RFC 4180-aware CSV record parser. Handles quoted fields, embedded delimiters
 * inside quotes ("Smith, John"), escaped quotes (""), and multi-line fields.
 * The previous naive split() corrupted any cell containing the delimiter.
 */
function parseCsvRecords(raw: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (raw[i + 1] === "\"") {
          // Escaped quote
          field += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      current.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Treat \r and \r\n as one record separator
      if (raw[i + 1] === "\n") i++;
      current.push(field);
      if (current.length > 1 || current[0] !== "") records.push(current);
      current = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      current.push(field);
      if (current.length > 1 || current[0] !== "") records.push(current);
      current = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing record (no terminator)
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (current.length > 1 || current[0] !== "") records.push(current);
  }
  return records;
}

function parseJson(raw: string): ParsedDocument {
  try {
    const parsed = JSON.parse(raw);
    return {
      text: JSON.stringify(parsed, null, 2),
      metadata: { format: "json", type: Array.isArray(parsed) ? "array" : typeof parsed },
    };
  } catch {
    // If invalid JSON, treat as plain text
    return { text: raw, metadata: { format: "json", valid: false } };
  }
}

function parseXml(raw: string): ParsedDocument {
  // Strip XML tags, keeping text content
  const text = raw
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { text, metadata: { format: "xml" } };
}

function parseHtml(raw: string): ParsedDocument {
  // Strip HTML: remove script/style blocks, then all tags
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
  return { text, metadata: { format: "html" } };
}

/** Decode RTF hex escape \'XX to the corresponding Windows-1252 character. */
function decodeRtfHex(_match: string, hex: string): string {
  const code = parseInt(hex, 16);
  // Windows-1252 has special mappings for 0x80-0x9F that differ from Latin-1
  const win1252: Record<number, number> = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178,
  };
  const codePoint = win1252[code] ?? code;
  return String.fromCodePoint(codePoint);
}

// RTF parsing uses a chain of regexes whose worst-case time grows with input
// size. Cap the input so a maliciously constructed multi-megabyte RTF blob
// can't tie up the worker for seconds.
const MAX_RTF_INPUT_BYTES = 5 * 1024 * 1024;

function parseRtf(raw: string): ParsedDocument {
  if (raw.length > MAX_RTF_INPUT_BYTES) {
    throw new Error(
      `RTF document exceeds parser cap (${MAX_RTF_INPUT_BYTES} bytes)`,
    );
  }
  // Basic RTF → plaintext: strip control words and groups
  const text = raw
    .replace(/\{\\[^{}]*\}/g, "")           // Remove nested groups like {\fonttbl...}
    .replace(/\\[a-z]+\d*\s?/gi, "")        // Remove control words like \par, \b0
    .replace(/[{}]/g, "")                     // Remove remaining braces
    .replace(/\\\\/g, "\\")                   // Unescape backslashes
    .replace(/\\'([0-9a-f]{2})/gi, decodeRtfHex)  // Decode hex escapes to characters
    .replace(/\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, metadata: { format: "rtf" } };
}

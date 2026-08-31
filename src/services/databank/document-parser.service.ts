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
  const text = parseStrictXmlText(raw);
  if (text !== null) {
    return { text, metadata: { format: "xml", valid: true } };
  }
  // Preserve the old lenient behavior for malformed or HTML-flavoured XML.
  return {
    text: stripXmlLikeText(raw),
    metadata: { format: "xml", valid: false },
  };
}

function decodeXmlText(raw: string): string | null {
  let decoded = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const ampersand = raw.indexOf("&", cursor);
    if (ampersand < 0) return decoded + raw.slice(cursor);
    decoded += raw.slice(cursor, ampersand);
    const semicolon = raw.indexOf(";", ampersand + 1);
    if (semicolon < 0) return null;
    const entity = raw.slice(ampersand + 1, semicolon);
    switch (entity) {
      case "amp": decoded += "&"; break;
      case "lt": decoded += "<"; break;
      case "gt": decoded += ">"; break;
      case "quot": decoded += '"'; break;
      case "apos": decoded += "'"; break;
      default: {
        const hex = /^#x([0-9a-f]+)$/i.exec(entity);
        const decimal = /^#([0-9]+)$/.exec(entity);
        const codePoint = hex
          ? Number.parseInt(hex[1]!, 16)
          : decimal
            ? Number.parseInt(decimal[1]!, 10)
            : -1;
        const validCodePoint = codePoint === 0x09
          || codePoint === 0x0a
          || codePoint === 0x0d
          || (codePoint >= 0x20 && codePoint <= 0xd7ff)
          || (codePoint >= 0xe000 && codePoint <= 0xfffd)
          || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
        if (!validCodePoint) return null;
        decoded += String.fromCodePoint(codePoint);
      }
    }
    cursor = semicolon + 1;
  }
  return decoded;
}

function findXmlTagEnd(raw: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function parseStrictXmlText(raw: string): string | null {
  const openElements: string[] = [];
  const textParts: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < raw.length) {
    if (raw[cursor] !== "<") {
      const nextTag = raw.indexOf("<", cursor);
      const end = nextTag < 0 ? raw.length : nextTag;
      const decoded = decodeXmlText(raw.slice(cursor, end));
      if (decoded === null) return null;
      if (openElements.length === 0) {
        if (decoded.trim().length > 0) return null;
      } else if (decoded.length > 0) {
        textParts.push(decoded);
      }
      cursor = end;
      continue;
    }

    if (raw.startsWith("<!--", cursor)) {
      const end = raw.indexOf("-->", cursor + 4);
      if (end < 0 || raw.slice(cursor + 4, end).includes("--")) return null;
      cursor = end + 3;
      continue;
    }
    if (raw.startsWith("<?", cursor)) {
      const end = raw.indexOf("?>", cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (raw.startsWith("<![CDATA[", cursor)) {
      if (openElements.length === 0) return null;
      const end = raw.indexOf("]]>", cursor + 9);
      if (end < 0) return null;
      textParts.push(raw.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (raw.startsWith("<!", cursor)) return null;

    const end = findXmlTagEnd(raw, cursor + 1);
    if (end < 0) return null;
    const body = raw.slice(cursor + 1, end).trim();
    const closing = /^\/\s*([A-Za-z_:][A-Za-z0-9_.:-]*)\s*$/.exec(body);
    if (closing) {
      if (openElements.pop() !== closing[1]) return null;
      if (openElements.length === 0) rootClosed = true;
      cursor = end + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(body);
    const openingBody = selfClosing ? body.replace(/\/\s*$/, "").trimEnd() : body;
    const opening = /^([A-Za-z_:][A-Za-z0-9_.:-]*)(?=\s|$)/.exec(openingBody);
    if (!opening || openingBody.includes("<")) return null;
    const attributes = openingBody.slice(opening[0].length);
    if (decodeXmlText(attributes) === null) return null;
    if (openElements.length === 0) {
      if (rootSeen || rootClosed) return null;
      rootSeen = true;
    }
    if (selfClosing) {
      if (openElements.length === 0) rootClosed = true;
    } else {
      openElements.push(opening[1]!);
    }
    cursor = end + 1;
  }

  if (!rootSeen || openElements.length > 0) return null;
  return textParts.join(" ").replace(/\s+/g, " ").trim();
}

function stripXmlLikeText(raw: string): string {
  return raw
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

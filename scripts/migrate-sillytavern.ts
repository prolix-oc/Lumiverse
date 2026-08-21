#!/usr/bin/env bun
/**
 * SillyTavern → Lumiverse Migration Tool
 *
 * Interactive CLI that walks users through importing characters, chats,
 * world books, and personas from a SillyTavern installation.
 *
 * Run with: bun run migrate:st
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { inflateSync } from "zlib";
import { homedir } from "os";
import { join, basename, extname, resolve } from "path";
import { createInterface } from "readline";
import {
  printBanner,
  printStepHeader,
  printSummary,
  printDivider,
  promptLabel,
  inputHint,
  theme,
} from "./ui";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
// Size-based batching: max ~30 MB of file data per request, max 50 files.
const BATCH_MAX_BYTES = 30 * 1024 * 1024;
const BATCH_MAX_FILES = 50;

// ─── Input helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` ${inputHint(`(${defaultValue})`)}` : "";
  return new Promise((resolve) => {
    rl.question(`${promptLabel(question)}${hint} `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${promptLabel(question)} `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let input = "";
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\n" || c === "\r") {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "\u007F" || c === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else {
        input += c;
        process.stdout.write(`${theme.muted}*${theme.reset}`);
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ─── Progress bar ───────────────────────────────────────────────────────────

function printProgress(label: string, current: number, total: number): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 100;
  const barWidth = 20;
  const filled = Math.round((current / Math.max(total, 1)) * barWidth);
  const empty = barWidth - filled;
  const bar = `${theme.secondary}${"=".repeat(filled)}${theme.muted}${" ".repeat(empty)}${theme.reset}`;
  process.stdout.write(`\r  [${bar}] ${pct}% ${label} (${current}/${total})   `);
}

function clearProgress(): void {
  process.stdout.write("\r" + " ".repeat(80) + "\r");
}

// ─── API helpers ────────────────────────────────────────────────────────────

let baseUrl = "";
let authCookie = "";

async function apiRequest(method: string, path: string, body?: any, formData?: FormData): Promise<any> {
  const url = `${baseUrl}/api/v1${path}`;
  const headers: Record<string, string> = {
    Cookie: authCookie,
  };

  let reqBody: BodyInit | undefined;

  if (formData) {
    reqBody = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: reqBody });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${method} ${path} returned ${res.status}: ${text}`);
  }

  return res.json();
}

async function apiRequestWithRetry(method: string, path: string, body?: any, formData?: FormData): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiRequest(method, path, body, formData);
    } catch (err: any) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

// ─── Date parsing ───────────────────────────────────────────────────────────

function parseDateString(value: string): number | null {
  // Strip @ characters ST sometimes uses in create_date ("2025-07-07@21h44m33s")
  let cleaned = value.replace(/@/g, " ").replace(/(\d+)h(\d+)m(\d+)s/, "$1:$2:$3").trim();

  // Numeric string (unix timestamp)
  const num = Number(cleaned);
  if (!isNaN(num) && cleaned.length > 0 && /^\d+(\.\d+)?$/.test(cleaned)) {
    if (num > 1_000_000_000_000) return Math.floor(num / 1000);
    if (num > 1_000_000_000) return Math.floor(num);
    return null; // too small to be a timestamp
  }

  // ST human-readable format: "July 7, 2025 9:44pm" — normalize am/pm for Date parser
  // Insert space before am/pm if missing: "9:44pm" → "9:44 PM"
  cleaned = cleaned.replace(/(\d)(am|pm)/i, "$1 $2").toUpperCase().replace(/ (AM|PM)/, " $1");

  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) {
    return Math.floor(parsed.getTime() / 1000);
  }

  return null;
}

/**
 * Extract the best timestamp from an ST message object.
 * Priority: gen_started > gen_finished > send_date > fallback to now.
 */
function parseMessageDate(msg: any): number {
  // Prefer ISO 8601 machine timestamps from ST generation metadata
  for (const field of ["gen_started", "gen_finished"]) {
    const val = msg[field];
    if (typeof val === "string" && val.length > 0) {
      const ts = parseDateString(val);
      if (ts) return ts;
    }
  }

  // Fall back to send_date (human-readable in modern ST)
  const sendDate = msg.send_date;

  if (sendDate === undefined || sendDate === null) {
    return Math.floor(Date.now() / 1000);
  }

  if (typeof sendDate === "number") {
    if (sendDate > 1_000_000_000_000) return Math.floor(sendDate / 1000);
    if (sendDate > 1_000_000_000) return Math.floor(sendDate);
    return Math.floor(Date.now() / 1000);
  }

  if (typeof sendDate === "string") {
    const ts = parseDateString(sendDate);
    if (ts) return ts;
  }

  return Math.floor(Date.now() / 1000);
}

// PNG character name reader
// Reads the embedded character name from a PNG file's tEXt/zTXt/iTXt chunk
interface PNGCharaInfo {
  embeddedName: string | null;
  hasCharaData: boolean;
  parseError?: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CHARA_KEYWORDS = new Set(["chara", "ccv3"]);

function readPNGCharaName(filePath: string): PNGCharaInfo {
  try {
    const buf = readFileSync(filePath);

    if (buf.length < 8 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
      return { embeddedName: null, hasCharaData: false, parseError: "not a valid PNG" };
    }

    let offset = 8;
    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
      const data = buf.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length; // 4 length + 4 type + N data + 4 CRC

      if (type === "IEND") break;
      if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;

      const nullIdx = data.indexOf(0);
      if (nullIdx === -1) continue;
      const keyword = data.subarray(0, nullIdx).toString("ascii");
      if (!CHARA_KEYWORDS.has(keyword)) continue;

      try {
        const value = decodeTextChunk(type, data, nullIdx);
        if (value !== null) return extractNameFromBase64JSON(value, keyword);
      } catch {
        return { embeddedName: null, hasCharaData: true, parseError: `${type} decode failed` };
      }
    }

    return { embeddedName: null, hasCharaData: false };
  } catch (err: any) {
    return { embeddedName: null, hasCharaData: false, parseError: err.message };
  }
}

function decodeTextChunk(type: string, data: Buffer, nullIdx: number): string | null {
  if (type === "tEXt") {
    return data.subarray(nullIdx + 1).toString("latin1");
  }
  if (type === "zTXt") {
    return inflateSync(data.subarray(nullIdx + 2)).toString("latin1");
  }
  // iTXt: skip compression flag + method, language tag + \0, translated keyword + \0
  const compressedFlag = data[nullIdx + 1];
  const afterFlags = data.subarray(nullIdx + 3);
  const langEnd = afterFlags.indexOf(0);
  if (langEnd === -1) return null;
  const transKeyEnd = afterFlags.indexOf(0, langEnd + 1);
  if (transKeyEnd === -1) return null;
  const valueBytes = afterFlags.subarray(transKeyEnd + 1);
  return compressedFlag
    ? inflateSync(valueBytes).toString("utf8")
    : valueBytes.toString("utf8");
}

function extractNameFromBase64JSON(raw: string, keyword: string): PNGCharaInfo {
  try {
    const decoded = Buffer.from(raw.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // account for v3 and v2/1
    const name: string | null = parsed.data?.name || parsed.name || null;
    return { embeddedName: name, hasCharaData: true };
  } catch {
    return { embeddedName: null, hasCharaData: true, parseError: `${keyword} JSON decode failed` };
  }
}

// Character scan

interface ScanEntry {
  filename: string;
  stem: string;
  embeddedName: string | null;
  hasData: boolean;
  parseError?: string;
  sizeBytes: number;
}

function scanCharacters(charsDir: string): ScanEntry[] {
  const pngFiles = readdirSync(charsDir).filter((f) => {
    if (extname(f).toLowerCase() !== ".png") return false;
    try { return statSync(join(charsDir, f)).isFile(); } catch { return false; }
  });

  const results: ScanEntry[] = [];
  for (let i = 0; i < pngFiles.length; i++) {
    const filename = pngFiles[i];
    const filePath = join(charsDir, filename);
    printProgress("Scanning character files", i + 1, pngFiles.length);
    try {
      const sizeBytes = statSync(filePath).size;
      const info = readPNGCharaName(filePath);
      results.push({
        filename,
        stem: basename(filename, ".png"),
        embeddedName: info.embeddedName,
        hasData: info.hasCharaData,
        parseError: info.parseError,
        sizeBytes,
      });
    } catch {
      results.push({
        filename,
        stem: basename(filename, ".png"),
        embeddedName: null,
        hasData: false,
        sizeBytes: 0,
      });
    }
  }
  clearProgress();
  return results;
}

//Checkpoint helpers
//
// A checkpoint file is saved after characters are successfully imported.
// This lets the user resume chat/worldbook import without re-uploading all PNGs
// if something were to fail partway through.

interface Checkpoint {
  baseUrl: string;
  effectiveDataDir: string;
  filenameToId: Record<string, string>;
  savedAt: number;
}

function checkpointPath(stDataDir: string): string {
  return join(stDataDir, ".lumiverse-migration-checkpoint.json");
}

function loadCheckpoint(stDataDir: string): Checkpoint | null {
  const path = checkpointPath(stDataDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(stDataDir: string, checkpoint: Checkpoint): void {
  try {
    writeFileSync(checkpointPath(stDataDir), JSON.stringify(checkpoint, null, 2), "utf-8");
  } catch {
    // don't crash if we can't write the checkpoint
  }
}

function deleteCheckpoint(stDataDir: string): void {
  const path = checkpointPath(stDataDir);
  if (existsSync(path)) {
    try { require("fs").unlinkSync(path); } catch { /* ignore */ }
  }
}

// ─── SillyTavern data scanning ──────────────────────────────────────────────

interface STDataCounts {
  characters: number;
  chatDirs: number;
  totalChatFiles: number;
  groupChats: number;
  groupChatFiles: number;
  worldBooks: number;
  personas: number;
}

function scanSTData(stDataDir: string): STDataCounts {
  const counts: STDataCounts = {
    characters: 0,
    chatDirs: 0,
    totalChatFiles: 0,
    groupChats: 0,
    groupChatFiles: 0,
    worldBooks: 0,
    personas: 0,
  };

  // Characters (PNG files)
  const charsDir = join(stDataDir, "characters");
  if (existsSync(charsDir)) {
    counts.characters = readdirSync(charsDir).filter(
      (f) => extname(f).toLowerCase() === ".png"
    ).length;
  }

  // Chats (JSONL files in subdirectories)
  const chatsDir = join(stDataDir, "chats");
  if (existsSync(chatsDir)) {
    const charDirs = readdirSync(chatsDir).filter((f) => {
      try {
        return statSync(join(chatsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
    counts.chatDirs = charDirs.length;
    for (const dir of charDirs) {
      counts.totalChatFiles += readdirSync(join(chatsDir, dir)).filter(
        (f) => extname(f).toLowerCase() === ".jsonl"
      ).length;
    }
  }

  // Group chats (JSON definitions in groups/, JSONL files in group chats/)
  const groupsDir = join(stDataDir, "groups");
  if (existsSync(groupsDir)) {
    counts.groupChats = readdirSync(groupsDir).filter(
      (f) => extname(f).toLowerCase() === ".json"
    ).length;
  }
  const groupChatsDir = join(stDataDir, "group chats");
  if (existsSync(groupChatsDir)) {
    counts.groupChatFiles = readdirSync(groupChatsDir).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    ).length;
  }

  // World books (JSON files)
  const worldsDir = join(stDataDir, "worlds");
  if (existsSync(worldsDir)) {
    counts.worldBooks = readdirSync(worldsDir).filter(
      (f) => extname(f).toLowerCase() === ".json"
    ).length;
  }

  // Personas from settings.json → power_user.personas / power_user.persona_descriptions
  const settingsPath = join(stDataDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const pu = settings.power_user || {};
      const allKeys = new Set([
        ...Object.keys(pu.personas || {}),
        ...Object.keys(pu.persona_descriptions || {}),
      ]);
      counts.personas = allKeys.size;
    } catch {
      // settings parse error, personas = 0
    }
  }

  return counts;
}

// ─── Import functions ───────────────────────────────────────────────────────

async function importCharacters(
  stDataDir: string
): Promise<{
  imported: number;
  skipped: number;
  failed: number;
  filenameToId: Map<string, string>;
  failedFiles: Array<{ filename: string; reason: string }>;
}> {
  const charsDir = join(stDataDir, "characters");
  const filenameToId = new Map<string, string>();
  const failedFiles: Array<{ filename: string; reason: string }> = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  if (!existsSync(charsDir)) {
    return { imported, skipped, failed, filenameToId, failedFiles };
  }

  const pngFiles = readdirSync(charsDir).filter((f) => {
    if (extname(f).toLowerCase() !== ".png") return false;
    try {
      return statSync(join(charsDir, f)).isFile();
    } catch {
      return false;
    }
  });
  const total = pngFiles.length;

  // Build size-based batches — keeps requests small enough to avoid timeouts
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBatchBytes = 0;

  for (const filename of pngFiles) {
    const fileSize = statSync(join(charsDir, filename)).size;
    if (currentBatch.length > 0 && (
      currentBatchBytes + fileSize > BATCH_MAX_BYTES ||
      currentBatch.length >= BATCH_MAX_FILES
    )) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }
    currentBatch.push(filename);
    currentBatchBytes += fileSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  let processedSoFar = 0;

  for (const batch of batches) {
    const formData = new FormData();
    formData.set("skip_duplicates", "true");

    const readableFiles: string[] = [];
    for (const filename of batch) {
      const filePath = join(charsDir, filename);
      try {
        const fileData = readFileSync(filePath);
        const blob = new Blob([fileData], { type: "image/png" });
        formData.append("files", blob, filename);
        readableFiles.push(filename);
      } catch (err: any) {
        clearProgress();
        console.log(`    ${theme.warning}Could not read ${filename}: ${err.message}${theme.reset}`);
        failedFiles.push({ filename, reason: `read error: ${err.message}` });
        failed++;
      }
    }

    if (readableFiles.length === 0) {
      processedSoFar += batch.length;
      printProgress("Importing characters", processedSoFar, total);
      continue;
    }

    try {
      const result = await apiRequestWithRetry("POST", "/characters/import-bulk", undefined, formData);
      if (result.results) {
        for (const r of result.results) {
          const stem = basename(r.filename || "", ".png");
          if (r.skipped) {
            skipped++;
            if (r.character?.id && stem) {
              filenameToId.set(stem, r.character.id);
            }
          } else if (r.success && r.character) {
            imported++;
            if (stem) filenameToId.set(stem, r.character.id);
          } else {
            failed++;
            if (r.filename) {
              failedFiles.push({ filename: r.filename, reason: r.error || "server rejected" });
            }
          }
        }
      }
    } catch (err: any) {
      // Whole batch failed — retry each file individually to get per-file results
      clearProgress();
      console.log(`\n    ${theme.warning}Batch of ${readableFiles.length} failed (${err.message}), retrying individually...${theme.reset}`);

      for (const filename of readableFiles) {
        const filePath = join(charsDir, filename);
        try {
          const fileData = readFileSync(filePath);
          const singleForm = new FormData();
          singleForm.set("skip_duplicates", "true");
          singleForm.append("files", new Blob([fileData], { type: "image/png" }), filename);

          const result = await apiRequestWithRetry("POST", "/characters/import-bulk", undefined, singleForm);
          const r = result.results?.[0];
          const stem = basename(filename, ".png");
          if (r?.skipped) {
            skipped++;
            if (r.character?.id) filenameToId.set(stem, r.character.id);
          } else if (r?.success && r?.character) {
            imported++;
            filenameToId.set(stem, r.character.id);
          } else {
            failed++;
            failedFiles.push({ filename, reason: r?.error || "server rejected" });
          }
        } catch (singleErr: any) {
          failed++;
          failedFiles.push({ filename, reason: singleErr.message });
        }
        printProgress("Importing characters", ++processedSoFar, total);
      }
      continue;
    }

    processedSoFar += readableFiles.length;
    printProgress("Importing characters", processedSoFar, total);
  }

  clearProgress();
  return { imported, skipped, failed, filenameToId, failedFiles };
}

async function importWorldBooks(
  stDataDir: string
): Promise<{ imported: number; failed: number; totalEntries: number; nameToId: Map<string, string> }> {
  const worldsDir = join(stDataDir, "worlds");
  const nameToId = new Map<string, string>();
  let imported = 0;
  let failed = 0;
  let totalEntries = 0;

  if (!existsSync(worldsDir)) {
    return { imported, failed, totalEntries, nameToId };
  }

  const jsonFiles = readdirSync(worldsDir).filter(
    (f) => extname(f).toLowerCase() === ".json"
  );
  const total = jsonFiles.length;

  // Collect all world books
  const worldBooks: Array<{ name?: string; description?: string; entries: any }> = [];

  for (let i = 0; i < jsonFiles.length; i++) {
    const filePath = join(worldsDir, jsonFiles[i]);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      worldBooks.push({
        name: data.name || data.originalName || basename(jsonFiles[i], ".json"),
        description: data.description || "",
        entries: data.entries || [],
      });
    } catch (err) {
      console.log(`\n    ${theme.warning}Could not parse ${jsonFiles[i]}, skipping${theme.reset}`);
      failed++;
    }
    printProgress("Reading world books", i + 1, total);
  }

  clearProgress();

  if (worldBooks.length > 0) {
    try {
      const result = await apiRequestWithRetry("POST", "/migrate/world-books", {
        world_books: worldBooks,
      });
      if (result.results) {
        for (const r of result.results) {
          if (r.success) {
            imported++;
            totalEntries += r.entry_count || 0;
            if (r.name && r.world_book_id) {
              nameToId.set(r.name, r.world_book_id);
            }
          } else {
            failed++;
          }
        }
      }
    } catch (err: any) {
      console.log(`\n    ${theme.error}World book import failed: ${err.message}${theme.reset}`);
      failed += worldBooks.length;
    }
  }

  return { imported, failed, totalEntries, nameToId };
}

async function importPersonas(
  stDataDir: string,
  worldBookNameToId: Map<string, string>
): Promise<{ imported: number; failed: number; avatarsUploaded: number; nameToId: Map<string, string> }> {
  const settingsPath = join(stDataDir, "settings.json");
  let imported = 0;
  let failed = 0;
  let avatarsUploaded = 0;
  const nameToId = new Map<string, string>();

  if (!existsSync(settingsPath)) {
    return { imported, failed, avatarsUploaded, nameToId };
  }

  let personaNames: Record<string, string>;
  let personaDescriptions: Record<string, any>;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const pu = settings.power_user || {};
    personaNames = pu.personas || {};
    personaDescriptions = pu.persona_descriptions || {};
  } catch {
    return { imported, failed, avatarsUploaded, nameToId };
  }

  const allKeys = new Set([...Object.keys(personaDescriptions), ...Object.keys(personaNames)]);
  if (allKeys.size === 0) {
    return { imported, failed, avatarsUploaded, nameToId };
  }

  const entries = Array.from(allKeys);

  const personas: Array<{ name: string; description?: string; title?: string; folder?: string; attached_world_book_id?: string; metadata?: Record<string, any> }> = [];

  for (const avatarKey of entries) {
    const name = personaNames[avatarKey] || basename(avatarKey, extname(avatarKey));
    const meta = personaDescriptions[avatarKey];
    const description = typeof meta === "string" ? meta : meta?.description || "";
    const title = typeof meta === "object" ? meta?.title || "" : "";

    const lorebookName = typeof meta === "object" ? meta?.lorebook || "" : "";
    const attached_world_book_id = lorebookName ? worldBookNameToId.get(lorebookName) : undefined;

    personas.push({ name, description, title, attached_world_book_id });
  }

  const total = personas.length;
  printProgress("Importing personas", 0, total);

  try {
    const result = await apiRequestWithRetry("POST", "/migrate/personas", { personas });

    if (result.results) {
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        if (r.success) {
          imported++;

          // Build name → persona_id map for chat attribution
          if (r.persona_id && r.name) {
            nameToId.set(r.name, r.persona_id);
          }

          // Try to upload avatar
          const avatarKey = entries[i];
          const avatarDir = join(stDataDir, "User Avatars");
          const avatarPath = join(avatarDir, avatarKey);

          if (existsSync(avatarPath) && r.persona_id) {
            try {
              const avatarData = readFileSync(avatarPath);
              const mimeType = avatarKey.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
              const blob = new Blob([avatarData], { type: mimeType });
              const formData = new FormData();
              formData.set("avatar", blob, avatarKey);

              await apiRequestWithRetry("POST", `/personas/${r.persona_id}/avatar`, undefined, formData);
              avatarsUploaded++;
            } catch {
              // Avatar upload failed, not critical
            }
          }
        } else {
          failed++;
        }
        printProgress("Importing personas", i + 1, total);
      }
    }
  } catch (err: any) {
    console.log(`\n    ${theme.error}Persona import failed: ${err.message}${theme.reset}`);
    failed += personas.length;
  }

  clearProgress();
  return { imported, failed, avatarsUploaded, nameToId };
}

async function importChats(
  stDataDir: string,
  filenameToId: Map<string, string>,
  personaNameToId: Map<string, string> = new Map()
): Promise<{ imported: number; failed: number; totalMessages: number; skippedChars: number }> {
  const chatsDir = join(stDataDir, "chats");
  let imported = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedChars = 0;

  if (!existsSync(chatsDir)) {
    return { imported, failed, totalMessages, skippedChars };
  }

  const charDirs = readdirSync(chatsDir).filter((f) => {
    try {
      return statSync(join(chatsDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  let processedChats = 0;
  let totalChats = 0;

  // Count total JSONL files first
  for (const dir of charDirs) {
    totalChats += readdirSync(join(chatsDir, dir)).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    ).length;
  }

  for (const charDirName of charDirs) {
    const characterId = filenameToId.get(charDirName);

    if (!characterId) {
      const chatFiles = readdirSync(join(chatsDir, charDirName)).filter(
        (f) => extname(f).toLowerCase() === ".jsonl"
      );
      skippedChars++;
      processedChats += chatFiles.length;
      clearProgress();
      console.log(`    ${theme.warning}No character found for "${charDirName}", skipping ${chatFiles.length} chat(s)${theme.reset}`);
      printProgress("Importing chats", processedChats, totalChats);
      continue;
    }

    const chatFiles = readdirSync(join(chatsDir, charDirName)).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    );

    const chatsPayload: Array<{
      name?: string;
      metadata?: Record<string, any>;
      created_at?: number;
      messages: Array<{
        is_user: boolean;
        name: string;
        content: string;
        send_date?: number;
        swipes?: string[];
        swipe_id?: number;
        extra?: Record<string, any>;
      }>;
    }> = [];

    for (const chatFile of chatFiles) {
      const filePath = join(chatsDir, charDirName, chatFile);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());

        if (lines.length === 0) {
          processedChats++;
          printProgress("Importing chats", processedChats, totalChats);
          continue;
        }

        // Line 0 is chat metadata in ST format — extract chat name and user_name (persona)
        let chatName = basename(chatFile, ".jsonl");
        let chatCreatedAt: number | undefined;
        let chatUserName: string | undefined;
        try {
          const meta = JSON.parse(lines[0]);
          if (meta.chat_metadata || meta.user_name !== undefined) {
            chatName = meta.chat_metadata?.name || chatName;
            chatUserName = meta.user_name;
            if (meta.create_date) {
              const ts = parseDateString(meta.create_date);
              if (ts) chatCreatedAt = ts;
            }
          }
        } catch {
          // Not valid JSON metadata, treat all lines as messages
        }

        // Parse messages — skip line 0 if it was metadata
        const startLine = (() => {
          try {
            const first = JSON.parse(lines[0]);
            if (first.user_name !== undefined || first.chat_metadata) return 1;
          } catch { /* ignore */ }
          return 0;
        })();

        const messages: Array<{
          is_user: boolean;
          name: string;
          content: string;
          send_date?: number;
          swipes?: string[];
          swipe_id?: number;
          extra?: Record<string, any>;
        }> = [];

        for (let i = startLine; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            const content = msg.mes || msg.content || "";
            if (!content && !msg.name) continue;

            const isUser = !!msg.is_user;
            const msgName = msg.name || (isUser ? "User" : charDirName);
            let extra = msg.extra || undefined;

            // Attribute user messages to imported personas by matching name
            if (isUser && personaNameToId.size > 0) {
              const personaId = personaNameToId.get(msgName) || (chatUserName ? personaNameToId.get(chatUserName) : undefined);
              if (personaId) {
                extra = { ...(extra || {}), persona_id: personaId };
              }
            }

            messages.push({
              is_user: isUser,
              name: msgName,
              content,
              send_date: parseMessageDate(msg),
              swipes: Array.isArray(msg.swipes) ? msg.swipes : undefined,
              swipe_id: typeof msg.swipe_id === "number" ? msg.swipe_id : undefined,
              extra,
            });
          } catch {
            // Skip unparseable lines
          }
        }

        if (messages.length > 0) {
          chatsPayload.push({
            name: chatName,
            created_at: chatCreatedAt,
            messages,
          });
        }

        processedChats++;
        printProgress("Importing chats", processedChats, totalChats);
      } catch (err) {
        clearProgress();
        console.log(`    ${theme.warning}Could not read ${chatFile}, skipping${theme.reset}`);
        failed++;
        processedChats++;
        printProgress("Importing chats", processedChats, totalChats);
      }
    }

    // Send batch for this character
    if (chatsPayload.length > 0) {
      try {
        const result = await apiRequestWithRetry("POST", "/migrate/chats", {
          character_id: characterId,
          character_name: charDirName,
          chats: chatsPayload,
        });
        if (result.results) {
          for (const r of result.results) {
            if (r.success) {
              imported++;
              totalMessages += r.message_count || 0;
            } else {
              failed++;
            }
          }
        }
      } catch (err: any) {
        clearProgress();
        console.log(`    ${theme.error}Chat import failed for "${charDirName}": ${err.message}${theme.reset}`);
        failed += chatsPayload.length;
      }
    }
  }

  clearProgress();
  return { imported, failed, totalMessages, skippedChars };
}

async function importGroupChats(
  stDataDir: string,
  filenameToId: Map<string, string>,
  personaNameToId: Map<string, string> = new Map()
): Promise<{ imported: number; failed: number; totalMessages: number; skippedGroups: number }> {
  const groupsDir = join(stDataDir, "groups");
  const groupChatsDir = join(stDataDir, "group chats");
  let imported = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedGroups = 0;

  if (!existsSync(groupsDir) || !existsSync(groupChatsDir)) {
    return { imported, failed, totalMessages, skippedGroups };
  }

  const groupFiles = readdirSync(groupsDir).filter(
    (f) => extname(f).toLowerCase() === ".json"
  );

  let processedChats = 0;
  let totalChatsToProcess = 0;

  for (const gf of groupFiles) {
    try {
      const group = JSON.parse(readFileSync(join(groupsDir, gf), "utf-8"));
      totalChatsToProcess += (group.chats || []).length;
    } catch { /* skip */ }
  }

  for (const groupFile of groupFiles) {
    let group: any;
    try {
      group = JSON.parse(readFileSync(join(groupsDir, groupFile), "utf-8"));
    } catch {
      failed++;
      continue;
    }

    const members: string[] = group.members || [];
    const groupName: string = group.name || "Imported Group Chat";
    const chatIds: string[] = group.chats || [];

    const memberCharIds: string[] = [];
    let missingMembers = false;
    for (const memberFile of members) {
      const stem = basename(memberFile, ".png");
      const charId = filenameToId.get(stem);
      if (charId) {
        memberCharIds.push(charId);
      } else {
        missingMembers = true;
      }
    }

    if (memberCharIds.length === 0) {
      skippedGroups++;
      processedChats += chatIds.length;
      clearProgress();
      console.log(`    ${theme.warning}No members found for group "${groupName}", skipping${theme.reset}`);
      printProgress("Importing group chats", processedChats, totalChatsToProcess);
      continue;
    }

    if (missingMembers) {
      clearProgress();
      console.log(`    ${theme.warning}Some members missing for "${groupName}", importing with available members${theme.reset}`);
    }

    for (const chatId of chatIds) {
      const chatFilePath = join(groupChatsDir, `${chatId}.jsonl`);
      if (!existsSync(chatFilePath)) {
        processedChats++;
        printProgress("Importing group chats", processedChats, totalChatsToProcess);
        continue;
      }

      try {
        const raw = readFileSync(chatFilePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());

        if (lines.length === 0) {
          processedChats++;
          printProgress("Importing group chats", processedChats, totalChatsToProcess);
          continue;
        }

        let chatCreatedAt: number | undefined;
        let chatUserName: string | undefined;
        try {
          const meta = JSON.parse(lines[0]);
          if (meta.chat_metadata || meta.user_name !== undefined) {
            chatUserName = meta.user_name;
            if (meta.create_date) {
              const ts = parseDateString(meta.create_date);
              if (ts) chatCreatedAt = ts;
            }
          }
        } catch { /* ignore */ }

        const startLine = (() => {
          try {
            const first = JSON.parse(lines[0]);
            if (first.chat_metadata || first.user_name !== undefined) return 1;
          } catch { /* ignore */ }
          return 0;
        })();

        const messages: Array<{
          is_user: boolean;
          name: string;
          content: string;
          send_date?: number;
          swipes?: string[];
          swipe_id?: number;
          extra?: Record<string, any>;
        }> = [];

        for (let i = startLine; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            const content = msg.mes || msg.content || "";
            if (!content && !msg.name) continue;

            const isUser = !!msg.is_user;
            const msgName = msg.name || (isUser ? "User" : "Unknown");
            let extra = msg.extra || undefined;

            // Attribute user messages to imported personas by matching name
            if (isUser && personaNameToId.size > 0) {
              const personaId = personaNameToId.get(msgName) || (chatUserName ? personaNameToId.get(chatUserName) : undefined);
              if (personaId) {
                extra = { ...(extra || {}), persona_id: personaId };
              }
            }

            messages.push({
              is_user: isUser,
              name: msgName,
              content,
              send_date: parseMessageDate(msg),
              swipes: Array.isArray(msg.swipes) ? msg.swipes : undefined,
              swipe_id: typeof msg.swipe_id === "number" ? msg.swipe_id : undefined,
              extra,
            });
          } catch {
            // Skip unparseable lines
          }
        }

        if (messages.length === 0) {
          processedChats++;
          printProgress("Importing group chats", processedChats, totalChatsToProcess);
          continue;
        }

        if (!chatCreatedAt && group.create_date) {
          const ts = parseDateString(group.create_date);
          if (ts) chatCreatedAt = ts;
        }

        const chatsPayload = [{
          name: groupName,
          created_at: chatCreatedAt,
          metadata: { group: true, character_ids: memberCharIds },
          messages,
        }];

        const result = await apiRequestWithRetry("POST", "/migrate/chats", {
          character_id: memberCharIds[0],
          character_name: groupName,
          chats: chatsPayload,
        });

        if (result.results) {
          for (const r of result.results) {
            if (r.success) {
              imported++;
              totalMessages += r.message_count || 0;
            } else {
              failed++;
            }
          }
        }
      } catch (err: any) {
        clearProgress();
        console.log(`    ${theme.warning}Failed to import group chat "${chatId}": ${err.message}${theme.reset}`);
        failed++;
      }

      processedChats++;
      printProgress("Importing group chats", processedChats, totalChatsToProcess);
    }
  }

  clearProgress();
  return { imported, failed, totalMessages, skippedGroups };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.LUMIVERSE_ALLOW_UPLOAD_ST_MIGRATOR !== "1") {
    console.error(
      "The upload-based SillyTavern migrator is retired. Use Settings → Data → SillyTavern migration in the app.\n" +
      "Set LUMIVERSE_ALLOW_UPLOAD_ST_MIGRATOR=1 only if you must force this script.",
    );
    process.exit(1);
  }

  printBanner("SillyTavern Migration Tool");
  printDivider();

  // ─── Step 1: Authentication ─────────────────────────────────────────────

  printStepHeader(1, 7, "Authentication", "Connect to your Lumiverse instance.");

  baseUrl = await ask("Lumiverse URL", "http://localhost:7860");
  baseUrl = baseUrl.replace(/\/+$/, "");

  const username = await ask("Username");
  const password = await askSecret("Password");

  if (!username || !password) {
    console.log(`\n  ${theme.error}Username and password are required.${theme.reset}`);
    process.exit(1);
  }

  console.log(`\n  ${theme.muted}Authenticating...${theme.reset}`);

  const emailVariants = [
    `${username}@lumiverse.local`,
    username,
  ];

  let authenticated = false;

  for (const email of emailVariants) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        redirect: "manual",
      });

      const setCookie = res.headers.getSetCookie?.() || [];
      const sessionCookie = setCookie.find((c: string) => c.includes("better-auth.session_token"));

      if (sessionCookie) {
        authCookie = sessionCookie.split(";")[0];
        authenticated = true;
        break;
      }

      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.token) {
          authCookie = `better-auth.session_token=${body.token}`;
          authenticated = true;
          break;
        }
      }
    } catch {
      // Try next variant
    }
  }

  if (!authenticated) {
    console.log(`\n  ${theme.error}Authentication failed. Check your credentials and server URL.${theme.reset}`);
    process.exit(1);
  }

  try {
    await apiRequest("GET", "/settings");
    console.log(`  ${theme.success}Authenticated successfully.${theme.reset}\n`);
  } catch {
    console.log(`\n  ${theme.error}Authentication token is invalid. Could not reach settings endpoint.${theme.reset}`);
    process.exit(1);
  }

  printDivider();

  // ─── Step 2: SillyTavern Directory ──────────────────────────────────────

  printStepHeader(2, 7, "SillyTavern Directory", "Point to your SillyTavern installation.");

  let stPath = await ask("SillyTavern path", "~/SillyTavern");
  stPath = stPath.replace(/^~/, homedir());
  stPath = resolve(stPath);

  if (!existsSync(stPath)) {
    console.log(`\n  ${theme.error}Directory not found: ${stPath}${theme.reset}`);
    process.exit(1);
  }

  const stUser = await ask("ST user directory", "default-user");
  const stDataDir = join(stPath, "data", stUser);

  let effectiveDataDir = stDataDir;
  if (!existsSync(stDataDir)) {
    if (existsSync(join(stPath, "public", "characters"))) {
      effectiveDataDir = join(stPath, "public");
      console.log(`  ${theme.muted}Using legacy directory structure: public/${theme.reset}`);
    } else {
      console.log(`\n  ${theme.error}Data directory not found: ${stDataDir}${theme.reset}`);
      console.log(`  ${theme.muted}Expected: {ST path}/data/{user}/${theme.reset}`);
      process.exit(1);
    }
  }

  console.log(`\n  ${theme.muted}Scanning data...${theme.reset}`);
  const counts = scanSTData(effectiveDataDir);

  console.log(`\n  ${theme.bold}Found:${theme.reset}`);
  console.log(`    Characters:   ${theme.secondary}${counts.characters}${theme.reset} PNG files`);
  console.log(`    Chats:        ${theme.secondary}${counts.totalChatFiles}${theme.reset} files across ${counts.chatDirs} characters`);
  console.log(`    Group Chats:  ${theme.secondary}${counts.groupChatFiles}${theme.reset} files across ${counts.groupChats} groups`);
  console.log(`    World Books:  ${theme.secondary}${counts.worldBooks}${theme.reset} JSON files`);
  console.log(`    Personas:     ${theme.secondary}${counts.personas}${theme.reset} entries`);
  console.log("");

  if (counts.characters + counts.totalChatFiles + counts.groupChatFiles + counts.worldBooks + counts.personas === 0) {
    console.log(`  ${theme.warning}No data found to import.${theme.reset}`);
    rl.close();
    return;
  }

  printDivider();

  // ─── Step 3: Pre-flight scan ─────────────────────────────────────────────

  printStepHeader(3, 7, "Pre-flight Scan", "Checking character files for potential issues.");

  // Check for an existing checkpoint from a previous run
  const checkpoint = loadCheckpoint(effectiveDataDir);
  let resumedFromCheckpoint = false;
  let filenameToId = new Map<string, string>();

  if (checkpoint && checkpoint.baseUrl === baseUrl) {
    const savedAt = new Date(checkpoint.savedAt).toLocaleString();
    console.log(`  ${theme.warning}Found a saved checkpoint from ${savedAt}.${theme.reset}`);
    console.log(`  ${theme.muted}This contains ${Object.keys(checkpoint.filenameToId).length} previously imported character ID mappings.${theme.reset}\n`);
    const resumeAns = await ask("Resume from checkpoint? (skips character re-import)", "y");
    if (resumeAns.toLowerCase() === "y") {
      filenameToId = new Map(Object.entries(checkpoint.filenameToId));
      resumedFromCheckpoint = true;
      console.log(`  ${theme.success}✓ Loaded ${filenameToId.size} character mappings from checkpoint.${theme.reset}\n`);
    }
  }

  if (!resumedFromCheckpoint && counts.characters > 0) {
    const charsDir = join(effectiveDataDir, "characters");
    console.log(`  ${theme.muted}Checking ${counts.characters} PNG files for read errors...${theme.reset}\n`);
    const scan = scanCharacters(charsDir);

    const noData = scan.filter((e) => !e.hasData);
    const parseErrors = scan.filter((e) => e.hasData && e.parseError);

    if (noData.length === 0 && parseErrors.length === 0) {
      console.log(`  ${theme.success}✓ All ${scan.length} character files look good.${theme.reset}\n`);
    } else {
      if (noData.length > 0) {
        console.log(`  ${theme.muted}${noData.length} PNG(s) have no embedded character data — they will be imported using their filename as the name.${theme.reset}`);
        const shown = noData.slice(0, 5);
        for (const e of shown) {
          console.log(`    ${theme.muted}·${theme.reset} ${e.filename}`);
        }
        if (noData.length > 5) {
          console.log(`    ${theme.muted}... and ${noData.length - 5} more${theme.reset}`);
        }
        console.log("");
      }

      if (parseErrors.length > 0) {
        console.log(`  ${theme.warning}${parseErrors.length} PNG(s) have unreadable embedded data and may fail to import:${theme.reset}`);
        const shown = parseErrors.slice(0, 5);
        for (const e of shown) {
          console.log(`    ${theme.warning}·${theme.reset} ${e.filename} ${theme.muted}(${e.parseError})${theme.reset}`);
        }
        if (parseErrors.length > 5) {
          console.log(`    ${theme.muted}... and ${parseErrors.length - 5} more${theme.reset}`);
        }
        console.log("");

        const proceedAns = await ask("Continue with migration? (y/n)", "y");
        if (proceedAns.toLowerCase() !== "y") {
          rl.close();
          return;
        }
      }
    }
  }

  printDivider();

  // ─── Step 4: Select What to Import ──────────────────────────────────────

  printStepHeader(4, 7, "Select Import Scope", "Choose what to migrate.");

  if (resumedFromCheckpoint) {
    console.log(`  ${theme.muted}Resuming from checkpoint — character import will be skipped.${theme.reset}\n`);
  }

  console.log("    1. Characters only");
  console.log("    2. World Books only");
  console.log("    3. Personas only");
  console.log("    4. Characters + Chat History (includes group chats)");
  console.log("    5. Everything");
  console.log("    6. Custom (select each)");
  console.log("");

  const choice = await ask("Selection", "5");

  let doCharacters = !resumedFromCheckpoint;
  let doWorldBooks = false;
  let doPersonas = false;
  let doChats = false;
  let doGroupChats = false;

  switch (choice) {
    case "1":
      doCharacters = !resumedFromCheckpoint;
      break;
    case "2":
      doCharacters = false;
      doWorldBooks = true;
      break;
    case "3":
      doCharacters = false;
      doPersonas = true;
      break;
    case "4":
      doCharacters = !resumedFromCheckpoint;
      doChats = true;
      doGroupChats = true;
      break;
    case "5":
      doCharacters = !resumedFromCheckpoint;
      doWorldBooks = true;
      doPersonas = true;
      doChats = true;
      doGroupChats = true;
      break;
    case "6": {
      if (!resumedFromCheckpoint) {
        const cAns = await ask("Import characters? (y/n)", "y");
        doCharacters = cAns.toLowerCase() === "y";
      }
      const wAns = await ask("Import world books? (y/n)", "y");
      doWorldBooks = wAns.toLowerCase() === "y";
      const pAns = await ask("Import personas? (y/n)", "y");
      doPersonas = pAns.toLowerCase() === "y";
      const chAns = await ask("Import chat history? (y/n)", "y");
      doChats = chAns.toLowerCase() === "y";
      const gAns = await ask("Import group chats? (y/n)", "y");
      doGroupChats = gAns.toLowerCase() === "y";
      break;
    }
    default:
      doCharacters = !resumedFromCheckpoint;
      doWorldBooks = true;
      doPersonas = true;
      doChats = true;
      doGroupChats = true;
  }

  // Warn if chats selected without characters
  if ((doChats || doGroupChats) && !doCharacters && !resumedFromCheckpoint) {
    console.log(`\n  ${theme.warning}Chat import requires characters to exist in Lumiverse.${theme.reset}`);
    const addChars = await ask("Also import characters? (y/n)", "y");
    if (addChars.toLowerCase() === "y") {
      doCharacters = true;
    }
  }

  console.log("");
  printDivider();

  // ─── Step 5: Execute Import ─────────────────────────────────────────────

  printStepHeader(5, 7, "Importing", "This may take a while for large collections.");

  let charResult = { imported: 0, skipped: 0, failed: 0, filenameToId, failedFiles: [] as Array<{ filename: string; reason: string }> };
  let wbResult = { imported: 0, failed: 0, totalEntries: 0, nameToId: new Map<string, string>() };
  let personaResult = { imported: 0, failed: 0, avatarsUploaded: 0, nameToId: new Map<string, string>() };
  let chatResult = { imported: 0, failed: 0, totalMessages: 0, skippedChars: 0 };
  let groupChatResult = { imported: 0, failed: 0, totalMessages: 0, skippedGroups: 0 };

  // 1. Characters
  if (doCharacters && counts.characters > 0) {
    console.log(`\n  ${theme.bold}Characters${theme.reset}`);
    charResult = await importCharacters(effectiveDataDir);
    // Merge newly imported IDs into our map (checkpoint may already have some)
    for (const [k, v] of charResult.filenameToId) {
      filenameToId.set(k, v);
    }
    charResult.filenameToId = filenameToId;
    console.log(`  ${theme.success}Done:${theme.reset} ${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`);

    // Save checkpoint so chat import can resume if something fails later
    saveCheckpoint(effectiveDataDir, {
      baseUrl,
      effectiveDataDir,
      filenameToId: Object.fromEntries(filenameToId),
      savedAt: Date.now(),
    });
  }

  // 2. World Books
  if (doWorldBooks && counts.worldBooks > 0) {
    console.log(`\n  ${theme.bold}World Books${theme.reset}`);
    wbResult = await importWorldBooks(effectiveDataDir);
    console.log(`  ${theme.success}Done:${theme.reset} ${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`);
  }

  // 3. Personas
  if (doPersonas && counts.personas > 0) {
    console.log(`\n  ${theme.bold}Personas${theme.reset}`);
    personaResult = await importPersonas(effectiveDataDir, wbResult.nameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${personaResult.imported} imported, ${personaResult.failed} failed, ${personaResult.avatarsUploaded} avatars`);
  }

  // 4. Chats
  if (doChats && counts.totalChatFiles > 0) {
    console.log(`\n  ${theme.bold}Chat History${theme.reset}`);
    chatResult = await importChats(effectiveDataDir, filenameToId, personaResult.nameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${chatResult.imported} chats (${chatResult.totalMessages} messages), ${chatResult.failed} failed`);
    if (chatResult.skippedChars > 0) {
      console.log(`  ${theme.warning}${chatResult.skippedChars} character(s) not found — their chats were skipped${theme.reset}`);
    }
  }

  // 5. Group Chats
  if (doGroupChats && counts.groupChats > 0) {
    console.log(`\n  ${theme.bold}Group Chats${theme.reset}`);
    groupChatResult = await importGroupChats(effectiveDataDir, filenameToId, personaResult.nameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${groupChatResult.imported} chats (${groupChatResult.totalMessages} messages), ${groupChatResult.failed} failed`);
    if (groupChatResult.skippedGroups > 0) {
      console.log(`  ${theme.warning}${groupChatResult.skippedGroups} group(s) skipped — no members found${theme.reset}`);
    }
  }

  console.log("");
  printDivider();

  // ─── Step 6: Summary ────────────────────────────────────────────────────

  printStepHeader(6, 7, "Summary", "Migration results.");

  const summaryItems: Array<{ label: string; value: string }> = [];
  const warnings: string[] = [];

  if (doCharacters) {
    summaryItems.push({
      label: "Characters",
      value: `${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`,
    });
  }
  if (doWorldBooks) {
    summaryItems.push({
      label: "World Books",
      value: `${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`,
    });
  }
  if (doPersonas) {
    summaryItems.push({
      label: "Personas",
      value: `${personaResult.imported} imported, ${personaResult.failed} failed`,
    });
  }
  if (doChats) {
    summaryItems.push({
      label: "Chats",
      value: `${chatResult.imported} imported (${chatResult.totalMessages} messages), ${chatResult.failed} failed`,
    });
  }
  if (doGroupChats && counts.groupChats > 0) {
    summaryItems.push({
      label: "Group Chats",
      value: `${groupChatResult.imported} imported (${groupChatResult.totalMessages} messages), ${groupChatResult.failed} failed`,
    });
  }

  const totalFailed =
    (doCharacters ? charResult.failed : 0) +
    (doWorldBooks ? wbResult.failed : 0) +
    (doPersonas ? personaResult.failed : 0) +
    (doChats ? chatResult.failed : 0) +
    (doGroupChats ? groupChatResult.failed : 0);

  if (totalFailed > 0) {
    warnings.push(`${totalFailed} item(s) failed to import.`);
  }

  printSummary("Migration Complete", summaryItems, warnings);

  // Show per-file failure details if any characters failed
  if (charResult.failedFiles.length > 0) {
    console.log(`  ${theme.warning}Failed character files:${theme.reset}`);
    const shown = charResult.failedFiles.slice(0, 15);
    for (const f of shown) {
      console.log(`    ${theme.muted}·${theme.reset} ${f.filename}  ${theme.muted}${f.reason}${theme.reset}`);
    }
    if (charResult.failedFiles.length > 15) {
      console.log(`    ${theme.muted}... and ${charResult.failedFiles.length - 15} more${theme.reset}`);
    }
    console.log("");
  }

  // Clean up checkpoint on successful completion (no failures)
  if (totalFailed === 0) {
    deleteCheckpoint(effectiveDataDir);
  } else {
    console.log(`  ${theme.muted}Checkpoint saved — re-run the tool and choose "Resume from checkpoint" to retry${theme.reset}`);
    console.log(`  ${theme.muted}without re-importing characters that already succeeded.${theme.reset}\n`);
  }

  // ─── Step 7: Post-Migration Notes ───────────────────────────────────────

  printStepHeader(7, 7, "Next Steps");

  console.log(`  ${theme.muted}1.${theme.reset} Refresh your Lumiverse browser tab to see imported content.`);
  console.log(`  ${theme.muted}2.${theme.reset} SillyTavern presets are not imported (architecture mismatch with Loom).`);
  console.log(`     Build new presets in Lumiverse's native preset system.`);
  console.log(`  ${theme.muted}3.${theme.reset} Your SillyTavern data has not been modified.`);
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error(`\n  ${theme.error}Migration failed:${theme.reset}`, err.message || err);
  rl.close();
  process.exit(1);
});

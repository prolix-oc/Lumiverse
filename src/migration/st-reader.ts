/**
 * SillyTavern filesystem readers — pure read-only functions.
 *
 * These extract data from a SillyTavern data directory without writing
 * anything. Designed for reuse by both the interactive CLI migration script
 * and the automated Docker migration.
 *
 * All functions accept an optional FileSystem parameter. When omitted,
 * the default LocalFileSystem is used (backwards-compatible).
 */

import { inflateSync } from "zlib";
import type { FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  progress(label: string, current: number, total: number): void;
}

export interface PNGCharaInfo {
  embeddedName: string | null;
  hasCharaData: boolean;
  parseError?: string;
}

export interface ScanEntry {
  filename: string;
  stem: string;
  embeddedName: string | null;
  hasData: boolean;
  parseError?: string;
  sizeBytes: number;
}

export interface STDataCounts {
  characters: number;
  chatDirs: number;
  totalChatFiles: number;
  groupChats: number;
  groupChatFiles: number;
  worldBooks: number;
  personas: number;
}

export interface WorldBookPayload {
  name: string;
  description: string;
  entries: any;
}

export interface PersonaPayload {
  avatarKey: string;
  name: string;
  description: string;
  title: string;
  lorebookName: string;
}

export interface ChatMessage {
  is_user: boolean;
  name: string;
  content: string;
  send_date?: number;
  swipes?: string[];
  swipe_id?: number;
  extra?: Record<string, any>;
}

export interface ChatPayload {
  name: string;
  created_at?: number;
  metadata?: Record<string, any>;
  messages: ChatMessage[];
}

export interface ParsedStJsonlChat {
  name: string;
  createdAt?: number;
  userName?: string;
  messages: ChatMessage[];
  speakerNameFallbackCount?: number;
}

export interface GroupDefinition {
  name: string;
  members: string[]; // PNG filenames
  chatIds: string[];
  createDate?: string;
}

// ─── Default filesystem singleton ──────────────────────────────────────────

const defaultFs = new LocalFileSystem();

// ─── PNG chunk parsing ──────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHARA_KEYWORDS = new Set(["chara", "ccv3"]);

export async function readPNGCharaName(filePath: string, fs: FileSystem = defaultFs): Promise<PNGCharaInfo> {
  try {
    const buf = await fs.readFile(filePath);

    if (buf.length < 8 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
      return { embeddedName: null, hasCharaData: false, parseError: "not a valid PNG" };
    }

    let offset = 8;
    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
      const data = buf.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;

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
  // iTXt
  const compressedFlag = data[nullIdx + 1];
  const afterFlags = data.subarray(nullIdx + 3);
  const langEnd = afterFlags.indexOf(0);
  if (langEnd === -1) return null;
  const transKeyEnd = afterFlags.indexOf(0, langEnd + 1);
  if (transKeyEnd === -1) return null;
  const valueBytes = afterFlags.subarray(transKeyEnd + 1);
  return compressedFlag ? inflateSync(valueBytes).toString("utf8") : valueBytes.toString("utf8");
}

function extractNameFromBase64JSON(raw: string, keyword: string): PNGCharaInfo {
  try {
    const decoded = Buffer.from(raw.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    const name: string | null = parsed.data?.name || parsed.name || null;
    return { embeddedName: name, hasCharaData: true };
  } catch {
    return { embeddedName: null, hasCharaData: true, parseError: `${keyword} JSON decode failed` };
  }
}

// ─── Date parsing ───────────────────────────────────────────────────────────

export function parseDateString(value: string): number | null {
  let cleaned = value.replace(/@/g, " ").replace(/(\d+)h(\d+)m(\d+)s/, "$1:$2:$3").trim();

  const num = Number(cleaned);
  if (!isNaN(num) && cleaned.length > 0 && /^\d+(\.\d+)?$/.test(cleaned)) {
    if (num > 1_000_000_000_000) return Math.floor(num / 1000);
    if (num > 1_000_000_000) return Math.floor(num);
    return null;
  }

  cleaned = cleaned.replace(/(\d)(am|pm)/i, "$1 $2").toUpperCase().replace(/ (AM|PM)/, " $1");

  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) {
    return Math.floor(parsed.getTime() / 1000);
  }

  return null;
}

export function parseMessageDate(msg: any): number {
  for (const field of ["gen_started", "gen_finished"]) {
    const val = msg[field];
    if (typeof val === "string" && val.length > 0) {
      const ts = parseDateString(val);
      if (ts) return ts;
    }
  }

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

export function resolveOriginalAvatarToCharacterId(
  originalAvatar: unknown,
  filenameToId?: Map<string, string>,
): string | undefined {
  if (!filenameToId || filenameToId.size === 0) return undefined;
  if (typeof originalAvatar !== "string" || originalAvatar.length === 0) return undefined;
  const stem = originalAvatar.toLowerCase().endsWith(".png")
    ? originalAvatar.slice(0, -4)
    : originalAvatar;
  return filenameToId.get(stem) || filenameToId.get(stem.toLowerCase());
}

function parseStHeader(firstLine: string): {
  hasHeader: boolean;
  name?: string;
  createdAt?: number;
  userName?: string;
} {
  try {
    const meta = JSON.parse(firstLine);
    if (meta.chat_metadata || meta.user_name !== undefined) {
      let createdAt: number | undefined;
      if (meta.create_date) {
        const ts = parseDateString(meta.create_date);
        if (ts) createdAt = ts;
      }
      return {
        hasHeader: true,
        name: meta.chat_metadata?.name,
        createdAt,
        userName: meta.user_name,
      };
    }
  } catch { /* ignore */ }
  return { hasHeader: false };
}

export function parseStChatJsonl(raw: string, fallbackName: string): ParsedStJsonlChat | null {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  const header = parseStHeader(lines[0]);
  const messages: ChatMessage[] = [];

  for (let i = header.hasHeader ? 1 : 0; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      const msgSwipes: string[] | undefined = Array.isArray(msg.swipes) ? msg.swipes : undefined;
      const swipeId: number | undefined = typeof msg.swipe_id === "number" ? msg.swipe_id : undefined;
      const content =
        msg.mes ||
        msg.content ||
        (msgSwipes && swipeId !== undefined ? msgSwipes[swipeId] : undefined) ||
        (msgSwipes ? msgSwipes[0] : undefined) ||
        "";

      if (!content && !msg.name) continue;

      const extra = {
        ...(msg.extra || {}),
        ...(typeof msg.original_avatar === "string" && msg.original_avatar
          ? { original_avatar: msg.original_avatar }
          : {}),
      };

      messages.push({
        is_user: !!msg.is_user,
        name: msg.name || (msg.is_user ? "User" : "Character"),
        content,
        send_date: parseMessageDate(msg),
        swipes: msgSwipes,
        swipe_id: swipeId,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      });
    } catch { /* skip unparseable lines */ }
  }

  if (messages.length === 0) return null;
  return {
    name: header.name || fallbackName,
    createdAt: header.createdAt,
    userName: header.userName,
    messages,
  };
}

export function parseStGroupChatJsonl(
  raw: string,
  fallbackName: string,
  personaNameToId: Map<string, string>,
  filenameToId?: Map<string, string>,
): ParsedStJsonlChat | null {
  const parsed = parseStChatJsonl(raw, fallbackName);
  if (!parsed) return null;

  let speakerNameFallbackCount = 0;

  const messages = parsed.messages.map((message) => {
    let extra = message.extra || undefined;

    if (message.is_user && personaNameToId.size > 0) {
      const personaId = personaNameToId.get(message.name) || (parsed.userName ? personaNameToId.get(parsed.userName) : undefined);
      if (personaId) extra = { ...(extra || {}), persona_id: personaId };
    }

    if (!message.is_user) {
      const avatarCharId = resolveOriginalAvatarToCharacterId(extra?.original_avatar, filenameToId);
      const nameCharId = resolveOriginalAvatarToCharacterId(message.name, filenameToId);
      const charId = avatarCharId || nameCharId;
      if (!avatarCharId && nameCharId) speakerNameFallbackCount++;
      if (charId) extra = { ...(extra || {}), character_id: charId };
    }

    return extra ? { ...message, extra } : message;
  });

  return { ...parsed, messages, speakerNameFallbackCount };
}

// ─── Directory scanners ─────────────────────────────────────────────────────

export async function scanSTData(stDataDir: string, fs: FileSystem = defaultFs): Promise<STDataCounts> {
  const counts: STDataCounts = {
    characters: 0,
    chatDirs: 0,
    totalChatFiles: 0,
    groupChats: 0,
    groupChatFiles: 0,
    worldBooks: 0,
    personas: 0,
  };

  const charsDir = fs.join(stDataDir, "characters");
  if (await fs.exists(charsDir)) {
    const entries = await fs.readdir(charsDir);
    counts.characters = entries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".png"
    ).length;
  }

  const chatsDir = fs.join(stDataDir, "chats");
  if (await fs.exists(chatsDir)) {
    const entries = await fs.readdir(chatsDir);
    const charDirs = entries.filter((e) => e.isDirectory);
    counts.chatDirs = charDirs.length;
    for (const dir of charDirs) {
      const chatEntries = await fs.readdir(fs.join(chatsDir, dir.name));
      counts.totalChatFiles += chatEntries.filter(
        (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
      ).length;
    }
  }

  const groupsDir = fs.join(stDataDir, "groups");
  if (await fs.exists(groupsDir)) {
    const entries = await fs.readdir(groupsDir);
    counts.groupChats = entries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".json"
    ).length;
  }
  const groupChatsDir = fs.join(stDataDir, "group chats");
  if (await fs.exists(groupChatsDir)) {
    const entries = await fs.readdir(groupChatsDir);
    counts.groupChatFiles = entries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
    ).length;
  }

  const worldsDir = fs.join(stDataDir, "worlds");
  if (await fs.exists(worldsDir)) {
    const entries = await fs.readdir(worldsDir);
    counts.worldBooks = entries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".json"
    ).length;
  }

  const settingsPath = fs.join(stDataDir, "settings.json");
  if (await fs.exists(settingsPath)) {
    try {
      const settings = JSON.parse(await fs.readText(settingsPath));
      const pu = settings.power_user || {};
      const allKeys = new Set([
        ...Object.keys(pu.personas || {}),
        ...Object.keys(pu.persona_descriptions || {}),
      ]);
      counts.personas = allKeys.size;
    } catch { /* ignore */ }
  }

  return counts;
}

export async function scanCharacterPNGs(charsDir: string, logger?: MigrationLogger, fs: FileSystem = defaultFs): Promise<ScanEntry[]> {
  const entries = await fs.readdir(charsDir);
  const pngFiles = entries.filter(
    (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".png"
  );

  const results: ScanEntry[] = [];
  for (let i = 0; i < pngFiles.length; i++) {
    const entry = pngFiles[i];
    const filePath = fs.join(charsDir, entry.name);
    logger?.progress("Scanning character files", i + 1, pngFiles.length);
    try {
      const info = await readPNGCharaName(filePath, fs);
      results.push({
        filename: entry.name,
        stem: fs.basename(entry.name, ".png"),
        embeddedName: info.embeddedName,
        hasData: info.hasCharaData,
        parseError: info.parseError,
        sizeBytes: entry.size,
      });
    } catch {
      results.push({
        filename: entry.name,
        stem: fs.basename(entry.name, ".png"),
        embeddedName: null,
        hasData: false,
        sizeBytes: 0,
      });
    }
  }
  return results;
}

// ─── Data readers ───────────────────────────────────────────────────────────

export async function readWorldBooksFromDisk(stDataDir: string, logger?: MigrationLogger, fs: FileSystem = defaultFs): Promise<WorldBookPayload[]> {
  const worldsDir = fs.join(stDataDir, "worlds");
  if (!(await fs.exists(worldsDir))) return [];

  const entries = await fs.readdir(worldsDir);
  const jsonFiles = entries.filter(
    (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".json"
  );
  const results: WorldBookPayload[] = [];

  for (let i = 0; i < jsonFiles.length; i++) {
    const filePath = fs.join(worldsDir, jsonFiles[i].name);
    logger?.progress("Reading world books", i + 1, jsonFiles.length);
    try {
      const data = JSON.parse(await fs.readText(filePath));
      results.push({
        name: data.name || data.originalName || fs.basename(jsonFiles[i].name, ".json"),
        description: data.description || "",
        entries: data.entries || [],
      });
    } catch {
      logger?.warn(`Could not parse ${jsonFiles[i].name}, skipping`);
    }
  }

  return results;
}

export async function readPersonasFromDisk(stDataDir: string, fs: FileSystem = defaultFs): Promise<PersonaPayload[]> {
  const settingsPath = fs.join(stDataDir, "settings.json");
  if (!(await fs.exists(settingsPath))) return [];

  let personaNames: Record<string, string>;
  let personaDescriptions: Record<string, any>;
  try {
    const settings = JSON.parse(await fs.readText(settingsPath));
    const pu = settings.power_user || {};
    personaNames = pu.personas || {};
    personaDescriptions = pu.persona_descriptions || {};
  } catch {
    return [];
  }

  const allKeys = new Set([...Object.keys(personaDescriptions), ...Object.keys(personaNames)]);
  if (allKeys.size === 0) return [];

  return Array.from(allKeys).map((avatarKey) => {
    const name = personaNames[avatarKey] || fs.basename(avatarKey, fs.extname(avatarKey));
    const meta = personaDescriptions[avatarKey];
    const description = typeof meta === "string" ? meta : meta?.description || "";
    const title = typeof meta === "object" ? meta?.title || "" : "";
    const lorebookName = typeof meta === "object" ? meta?.lorebook || "" : "";
    return { avatarKey, name, description, title, lorebookName };
  });
}

/**
 * Read all JSONL chat files for a given character directory.
 * Parses ST chat metadata (line 0) and message lines.
 */
export async function readChatsForCharacter(
  stDataDir: string,
  charDirName: string,
  personaNameToId: Map<string, string>,
  filenameToId?: Map<string, string>,
  logger?: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<ChatPayload[]> {
  const chatsDir = fs.join(stDataDir, "chats", charDirName);
  if (!(await fs.exists(chatsDir))) return [];

  const entries = await fs.readdir(chatsDir);
  const chatFiles = entries.filter(
    (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
  );
  const results: ChatPayload[] = [];

  for (const chatFileEntry of chatFiles) {
    const filePath = fs.join(chatsDir, chatFileEntry.name);
    try {
      const parsed = parseStGroupChatJsonl(
        await fs.readText(filePath),
        fs.basename(chatFileEntry.name, ".jsonl"),
        personaNameToId,
        filenameToId,
      );
      if (parsed) {
        results.push({ name: parsed.name, created_at: parsed.createdAt, messages: parsed.messages });
      }
    } catch {
      logger?.warn(`Could not read ${chatFileEntry.name}, skipping`);
    }
  }

  return results;
}

export async function readGroupDefinitions(stDataDir: string, fs: FileSystem = defaultFs): Promise<GroupDefinition[]> {
  const groupsDir = fs.join(stDataDir, "groups");
  if (!(await fs.exists(groupsDir))) return [];

  const entries = await fs.readdir(groupsDir);
  const groupFiles = entries.filter(
    (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".json"
  );
  const results: GroupDefinition[] = [];

  for (const groupFileEntry of groupFiles) {
    try {
      const group = JSON.parse(await fs.readText(fs.join(groupsDir, groupFileEntry.name)));
      results.push({
        name: group.name || "Imported Group Chat",
        members: group.members || [],
        chatIds: group.chats || [],
        createDate: group.create_date,
      });
    } catch { /* skip */ }
  }

  return results;
}

/**
 * Read a single group chat JSONL file.
 */
export async function readGroupChatFile(
  stDataDir: string,
  chatId: string,
  personaNameToId: Map<string, string>,
  filenameToId?: Map<string, string>,
  fs: FileSystem = defaultFs,
): Promise<{ messages: ChatMessage[]; createdAt?: number } | null> {
  const chatFilePath = fs.join(stDataDir, "group chats", `${chatId}.jsonl`);
  if (!(await fs.exists(chatFilePath))) return null;

  try {
    const parsed = parseStGroupChatJsonl(await fs.readText(chatFilePath), chatId, personaNameToId, filenameToId);
    if (!parsed) return null;
    return { messages: parsed.messages, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

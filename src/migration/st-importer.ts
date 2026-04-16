/**
 * Direct-service-call import functions for SillyTavern migration.
 *
 * These call Lumiverse service functions directly (no HTTP), accepting a
 * userId and data read by st-reader.ts. Used by the Docker migration
 * orchestrator.
 *
 * All functions accept an optional FileSystem parameter for remote sources.
 */

import type { FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";

import type { MigrationLogger } from "./st-reader";
import {
  readWorldBooksFromDisk,
  readPersonasFromDisk,
  readChatsForCharacter,
  readGroupDefinitions,
  readGroupChatFile,
  parseDateString,
} from "./st-reader";

import { extractCardFromPng } from "../services/character-card.service";
import {
  createCharacter,
  findCharacterBySourceFilename,
  setCharacterSourceFilename,
  setCharacterAvatar,
  setCharacterImage,
} from "../services/characters.service";
import { uploadImage } from "../services/images.service";
import { createPersona, setPersonaAvatar, setPersonaImage } from "../services/personas.service";
import { importWorldBookBulk } from "../services/world-books.service";
import { createChatRaw, bulkInsertMessages } from "../services/chats.service";

// ─── Default filesystem singleton ──────────────────────────────────────────

const defaultFs = new LocalFileSystem();

// ─── Result types ───────────────────────────────────────────────────────────

export interface CharacterImportResult {
  imported: number;
  skipped: number;
  failed: number;
  filenameToId: Map<string, string>;
}

export interface WorldBookImportResult {
  imported: number;
  failed: number;
  totalEntries: number;
  nameToId: Map<string, string>;
}

export interface PersonaImportResult {
  imported: number;
  failed: number;
  avatarsUploaded: number;
  nameToId: Map<string, string>;
}

export interface ChatImportResult {
  imported: number;
  failed: number;
  totalMessages: number;
  skippedChars: number;
}

export interface GroupChatImportResult {
  imported: number;
  failed: number;
  skipped: number;
  totalMessages: number;
}

// ─── Character import ───────────────────────────────────────────────────────

export async function importCharacters(
  userId: string,
  stDataDir: string,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<CharacterImportResult> {
  const charsDir = fs.join(stDataDir, "characters");
  const filenameToId = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  if (!(await fs.exists(charsDir))) return { imported, skipped, failed, filenameToId };

  const entries = await fs.readdir(charsDir);
  const pngFiles = entries.filter(
    (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".png"
  );

  const total = pngFiles.length;

  for (let i = 0; i < pngFiles.length; i++) {
    const filename = pngFiles[i].name;
    const stem = fs.basename(filename, ".png");
    const filePath = fs.join(charsDir, filename);

    logger.progress("Importing characters", i + 1, total);

    try {
      // Deduplication: skip if already imported
      const existing = findCharacterBySourceFilename(userId, filename);
      if (existing) {
        filenameToId.set(stem, existing.id);
        skipped++;
        continue;
      }

      const buffer = await fs.readFile(filePath);
      const bytes = new Uint8Array(buffer);
      const file = new File([bytes], filename, { type: "image/png" });

      const cardInput = await extractCardFromPng(file);
      const character = createCharacter(userId, cardInput);
      setCharacterSourceFilename(userId, character.id, filename);

      // Upload avatar from the same PNG
      try {
        const avatarFile = new File([bytes], filename, { type: "image/png" });
        const image = await uploadImage(userId, avatarFile);
        setCharacterImage(userId, character.id, image.id);
        setCharacterAvatar(userId, character.id, image.filename);
      } catch {
        // Avatar upload failed, not critical
      }

      filenameToId.set(stem, character.id);
      imported++;
    } catch (err: any) {
      logger.warn(`Failed to import ${filename}: ${err.message}`);
      failed++;
    }
  }

  return { imported, skipped, failed, filenameToId };
}

// ─── World book import ──────────────────────────────────────────────────────

export async function importWorldBooks(
  userId: string,
  stDataDir: string,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<WorldBookImportResult> {
  const nameToId = new Map<string, string>();
  let imported = 0;
  let failed = 0;
  let totalEntries = 0;

  const worldBooks = await readWorldBooksFromDisk(stDataDir, logger, fs);
  const total = worldBooks.length;

  for (let i = 0; i < worldBooks.length; i++) {
    const wb = worldBooks[i];
    logger.progress("Importing world books", i + 1, total);

    try {
      const result = importWorldBookBulk(userId, wb);
      imported++;
      totalEntries += result.entryCount;
      nameToId.set(wb.name, result.worldBook.id);
    } catch (err: any) {
      logger.warn(`Failed to import world book "${wb.name}": ${err.message}`);
      failed++;
    }
  }

  return { imported, failed, totalEntries, nameToId };
}

// ─── Persona import ─────────────────────────────────────────────────────────

export async function importPersonas(
  userId: string,
  stDataDir: string,
  worldBookNameToId: Map<string, string>,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<PersonaImportResult> {
  const nameToId = new Map<string, string>();
  let imported = 0;
  let failed = 0;
  let avatarsUploaded = 0;

  const personaPayloads = await readPersonasFromDisk(stDataDir, fs);
  const total = personaPayloads.length;

  for (let i = 0; i < personaPayloads.length; i++) {
    const p = personaPayloads[i];
    logger.progress("Importing personas", i + 1, total);

    try {
      const attachedWbId = p.lorebookName ? worldBookNameToId.get(p.lorebookName) : undefined;

      const persona = createPersona(userId, {
        name: p.name,
        description: p.description || undefined,
        title: p.title || undefined,
        attached_world_book_id: attachedWbId,
      });

      nameToId.set(p.name, persona.id);
      imported++;

      // Try avatar upload
      const avatarDir = fs.join(stDataDir, "User Avatars");
      const avatarPath = fs.join(avatarDir, p.avatarKey);

      if (await fs.exists(avatarPath)) {
        try {
          const avatarBuffer = await fs.readFile(avatarPath);
          const avatarBytes = new Uint8Array(avatarBuffer);
          const mimeType = p.avatarKey.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
          const file = new File([avatarBytes], p.avatarKey, { type: mimeType });
          const image = await uploadImage(userId, file);
          setPersonaImage(userId, persona.id, image.id);
          setPersonaAvatar(userId, persona.id, image.filename);
          avatarsUploaded++;
        } catch {
          // Avatar upload failed, not critical
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to import persona "${p.name}": ${err.message}`);
      failed++;
    }
  }

  return { imported, failed, avatarsUploaded, nameToId };
}

// ─── Chat import ────────────────────────────────────────────────────────────

export async function importChats(
  userId: string,
  stDataDir: string,
  filenameToId: Map<string, string>,
  personaNameToId: Map<string, string>,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<ChatImportResult> {
  const chatsDir = fs.join(stDataDir, "chats");
  let imported = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedChars = 0;

  if (!(await fs.exists(chatsDir))) return { imported, failed, totalMessages, skippedChars };

  const entries = await fs.readdir(chatsDir);
  const charDirs = entries.filter((e) => e.isDirectory);

  // Count total chats for progress
  let totalChats = 0;
  for (const dir of charDirs) {
    const chatEntries = await fs.readdir(fs.join(chatsDir, dir.name));
    totalChats += chatEntries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
    ).length;
  }

  let processedChats = 0;

  for (const charDirEntry of charDirs) {
    const charDirName = charDirEntry.name;
    const characterId = filenameToId.get(charDirName);

    if (!characterId) {
      const chatEntries = await fs.readdir(fs.join(chatsDir, charDirName));
      const chatCount = chatEntries.filter(
        (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
      ).length;
      skippedChars++;
      processedChats += chatCount;
      logger.warn(`No character found for "${charDirName}", skipping ${chatCount} chat(s)`);
      logger.progress("Importing chats", processedChats, totalChats);
      continue;
    }

    const chatPayloads = await readChatsForCharacter(stDataDir, charDirName, personaNameToId, logger, fs);

    for (const chatData of chatPayloads) {
      try {
        const chat = createChatRaw(userId, {
          character_id: characterId,
          name: chatData.name,
          metadata: chatData.metadata,
          created_at: chatData.created_at,
        });

        const msgCount = bulkInsertMessages(chat.id, chatData.messages);
        imported++;
        totalMessages += msgCount;
      } catch (err: any) {
        logger.warn(`Failed to import chat "${chatData.name}": ${err.message}`);
        failed++;
      }

      processedChats++;
      logger.progress("Importing chats", processedChats, totalChats);
    }

    // Account for chat files that produced no payloads
    const chatEntries = await fs.readdir(fs.join(chatsDir, charDirName));
    const jsonlCount = chatEntries.filter(
      (e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl"
    ).length;
    const remaining = jsonlCount - chatPayloads.length;
    if (remaining > 0) {
      processedChats += remaining;
      logger.progress("Importing chats", processedChats, totalChats);
    }
  }

  return { imported, failed, totalMessages, skippedChars };
}

// ─── Group chat import ──────────────────────────────────────────────────────

export async function importGroupChats(
  userId: string,
  stDataDir: string,
  filenameToId: Map<string, string>,
  personaNameToId: Map<string, string>,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<GroupChatImportResult> {
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let totalMessages = 0;

  const groupDefs = await readGroupDefinitions(stDataDir, fs);
  if (groupDefs.length === 0) return { imported, failed, skipped, totalMessages };

  // Count total chat files for progress
  let totalChatsToProcess = 0;
  for (const gd of groupDefs) totalChatsToProcess += gd.chatIds.length;

  let processedChats = 0;

  for (const group of groupDefs) {
    // Resolve member character IDs
    const memberCharIds: string[] = [];
    for (const memberFile of group.members) {
      const stem = fs.basename(memberFile, ".png");
      const charId = filenameToId.get(stem);
      if (charId) memberCharIds.push(charId);
    }

    if (memberCharIds.length === 0) {
      skipped++;
      processedChats += group.chatIds.length;
      logger.warn(`No members found for group "${group.name}", skipping`);
      logger.progress("Importing group chats", processedChats, totalChatsToProcess);
      continue;
    }

    for (const chatId of group.chatIds) {
      const chatData = await readGroupChatFile(stDataDir, chatId, personaNameToId, fs);

      if (!chatData) {
        processedChats++;
        logger.progress("Importing group chats", processedChats, totalChatsToProcess);
        continue;
      }

      try {
        let chatCreatedAt = chatData.createdAt;
        if (!chatCreatedAt && group.createDate) {
          const ts = parseDateString(group.createDate);
          if (ts) chatCreatedAt = ts;
        }

        const chat = createChatRaw(userId, {
          character_id: memberCharIds[0],
          name: group.name,
          metadata: { group: true, character_ids: memberCharIds },
          created_at: chatCreatedAt,
        });

        const msgCount = bulkInsertMessages(chat.id, chatData.messages);
        imported++;
        totalMessages += msgCount;
      } catch (err: any) {
        logger.warn(`Failed to import group chat "${group.name}/${chatId}": ${err.message}`);
        failed++;
      }

      processedChats++;
      logger.progress("Importing group chats", processedChats, totalChatsToProcess);
    }
  }

  return { imported, failed, skipped, totalMessages };
}

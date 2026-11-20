/**
 * Direct-service-call import functions for SillyTavern migration.
 *
 * These call Lumiverse service functions directly (no HTTP), accepting a
 * userId and data read by st-reader.ts. Used by the Docker migration
 * orchestrator and the UI-driven execute path.
 *
 * All functions accept an optional FileSystem parameter for remote sources.
 */

import type { FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";

import type { MigrationLogger } from "./st-reader";
import {
  readWorldBooksFromDisk,
  readPersonasFromDisk,
  readCharacterChatFile,
  readGroupDefinitions,
  readGroupChatFileEntries,
  readGroupChatFile,
  parseDateString,
} from "./st-reader";
import { mapWithConcurrency } from "./st-concurrency";

import { extractCardFromPng } from "../services/character-card.service";
import {
  createCharacter,
  listCharacterSourceFilenameIds,
} from "../services/characters.service";
import { uploadImages } from "../services/images.service";
import { createPersona, listPersonaSourceFilenameIds, setPersonaAvatar, setPersonaImage } from "../services/personas.service";
import {
  emitWorldBookLibraryChanged,
  importWorldBookBulk,
  listSillyTavernWorldBookSourceFilenameIds,
} from "../services/world-books.service";
import { bulkInsertMessages, createChatRaw, listChatSourceFilenameIds } from "../services/chats.service";
import { createCooperativeYielder, yieldToEventLoop } from "../llm/stream-utils";
import { getDb } from "../db/connection";
import { currentWorkerBudget } from "../utils/cpu-budget";

import type { CreateCharacterInput } from "../types/character";

const defaultFs = new LocalFileSystem();
const yieldEveryPersona = 8;
const yieldEveryChatBatch = 1;

function characterBatchSize(): number {
  return 10 * currentWorkerBudget().workerConcurrency;
}

function characterReadConcurrency(): number {
  return currentWorkerBudget().workerConcurrency;
}

function characterAvatarWriteConcurrency(): number {
  return currentWorkerBudget().workerConcurrency;
}

function chatReadConcurrency(): number {
  return Math.max(1, Math.ceil(currentWorkerBudget().workerConcurrency * 0.75));
}

function groupChatReadConcurrency(): number {
  return Math.max(1, Math.ceil(currentWorkerBudget().workerConcurrency / 2));
}

export interface CharacterImportResult {
  imported: number;
  skipped: number;
  failed: number;
  filenameToId: Map<string, string>;
}

export interface WorldBookImportResult {
  imported: number;
  skipped: number;
  failed: number;
  totalEntries: number;
  nameToId: Map<string, string>;
}

export interface PersonaImportResult {
  imported: number;
  skipped: number;
  failed: number;
  avatarsUploaded: number;
  nameToId: Map<string, string>;
}

export interface ChatImportResult {
  imported: number;
  skipped: number;
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

export function characterChatSourceKey(charDirName: string, chatFileName: string): string {
  return `chats/${charDirName}/${chatFileName}`;
}

export function groupChatSourceKey(chatId: string): string {
  const fileName = chatId.toLowerCase().endsWith(".jsonl") ? chatId : `${chatId}.jsonl`;
  return `group chats/${fileName}`;
}

type PreparedCharacter =
  | { kind: "existing"; filename: string; stem: string; characterId: string }
  | { kind: "failed"; filename: string }
  | {
      kind: "ready";
      filename: string;
      stem: string;
      bytes: Uint8Array;
      cardInput: CreateCharacterInput;
    };

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
  const existingByFilename = listCharacterSourceFilenameIds(userId);

  for (let batchStart = 0; batchStart < pngFiles.length; batchStart += characterBatchSize()) {
    const batch = pngFiles.slice(batchStart, batchStart + characterBatchSize());
    const prepared = await mapWithConcurrency(
      batch,
      characterReadConcurrency(),
      async (entry): Promise<PreparedCharacter> => {
        const filename = entry.name;
        const stem = fs.basename(filename, ".png");
        const existingId = existingByFilename.get(filename);
        if (existingId) return { kind: "existing", filename, stem, characterId: existingId };

        try {
          const filePath = fs.join(charsDir, filename);
          const [buffer, fileStat] = await Promise.all([
            fs.readFile(filePath),
            fs.stat(filePath).catch(() => null),
          ]);
          const cardInput = await extractCardFromPng(buffer);
          if (cardInput.created_at == null && fileStat) {
            cardInput.created_at = fileStat.createdAt ?? fileStat.modifiedAt;
          }
          cardInput.extensions = {
            ...(cardInput.extensions ?? {}),
            _lumiverse_source_filename: filename,
          };
          return { kind: "ready", filename, stem, bytes: buffer, cardInput };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to import ${filename}: ${message}`);
          return { kind: "failed", filename };
        }
      },
    );

    const created: Array<{
      filename: string;
      bytes: Uint8Array;
      characterId: string;
    }> = [];

    getDb().transaction(() => {
      for (const item of prepared) {
        if (item.kind === "existing") {
          filenameToId.set(item.stem, item.characterId);
          skipped++;
          continue;
        }
        if (item.kind === "failed") {
          failed++;
          continue;
        }
        try {
          const character = createCharacter(userId, item.cardInput, { emitEvent: false });
          filenameToId.set(item.stem, character.id);
          existingByFilename.set(item.filename, character.id);
          created.push({
            filename: item.filename,
            bytes: item.bytes,
            characterId: character.id,
          });
          imported++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to import ${item.filename}: ${message}`);
          failed++;
        }
      }
    })();

    if (created.length > 0) {
      try {
        const avatarResults = await uploadImages(
          userId,
          created.map((item) => ({
            data: item.bytes,
            filename: item.filename,
            mime_type: "image/png",
            owner_character_id: item.characterId,
          })),
          {
            concurrency: characterAvatarWriteConcurrency(),
            deferProcessing: true,
          },
        );

        const attachAvatar = getDb().query(
          `UPDATE characters
           SET image_id = ?, avatar_path = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        );
        const now = Math.floor(Date.now() / 1000);
        getDb().transaction(() => {
          for (let i = 0; i < avatarResults.length; i++) {
            const image = avatarResults[i]?.image;
            if (!image) continue;
            attachAvatar.run(image.id, image.filename, now, created[i].characterId, userId);
          }
        })();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Avatar batch failed; characters were still imported: ${message}`);
      }
    }

    logger.progress("Importing characters", Math.min(batchStart + batch.length, total), total);
    await yieldToEventLoop();
  }

  return { imported, skipped, failed, filenameToId };
}

export async function importWorldBooks(
  userId: string,
  stDataDir: string,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<WorldBookImportResult> {
  const nameToId = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let totalEntries = 0;

  const worldBooks = await readWorldBooksFromDisk(stDataDir, logger, fs);
  const total = worldBooks.length;
  const existingByFilename = listSillyTavernWorldBookSourceFilenameIds(userId);

  try {
    for (let i = 0; i < worldBooks.length; i++) {
      const wb = worldBooks[i];
      logger.progress("Importing world books", i + 1, total);

      const existingId = existingByFilename.get(wb.filename);
      if (existingId) {
        nameToId.set(wb.name, existingId);
        skipped++;
        await yieldToEventLoop();
        continue;
      }

      try {
        const result = await importWorldBookBulk(userId, wb, {
          emitEvent: false,
          metadata: {
            source: "sillytavern_migration",
            _lumiverse_source_filename: wb.filename,
          },
        });
        imported++;
        totalEntries += result.entryCount;
        nameToId.set(wb.name, result.worldBook.id);
        existingByFilename.set(wb.filename, result.worldBook.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to import world book "${wb.name}": ${message}`);
        failed++;
      }

      await yieldToEventLoop();
    }
  } finally {
    if (imported > 0) {
      emitWorldBookLibraryChanged(userId, {
        reason: "sillytavern_migration",
        imported,
      });
    }
  }

  return { imported, skipped, failed, totalEntries, nameToId };
}

export async function importPersonas(
  userId: string,
  stDataDir: string,
  worldBookNameToId: Map<string, string>,
  logger: MigrationLogger,
  fs: FileSystem = defaultFs,
): Promise<PersonaImportResult> {
  const nameToId = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let avatarsUploaded = 0;

  const personaPayloads = await readPersonasFromDisk(stDataDir, fs);
  const total = personaPayloads.length;
  const existingBySource = listPersonaSourceFilenameIds(userId);
  const maybeYield = createCooperativeYielder(yieldEveryPersona);
  const avatarDir = fs.join(stDataDir, "User Avatars");
  const pendingAvatars: Array<{ personaId: string; avatarKey: string; bytes: Uint8Array; mimeType: string }> = [];

  for (let i = 0; i < personaPayloads.length; i++) {
    const p = personaPayloads[i];
    logger.progress("Importing personas", i + 1, total);

    const existing = existingBySource.get(p.avatarKey);
    if (existing) {
      nameToId.set(existing.name, existing.id);
      nameToId.set(p.name, existing.id);
      skipped++;
      await maybeYield();
      continue;
    }

    try {
      const attachedWbId = p.lorebookName ? worldBookNameToId.get(p.lorebookName) : undefined;
      const persona = createPersona(userId, {
        name: p.name,
        description: p.description || undefined,
        title: p.title || undefined,
        attached_world_book_id: attachedWbId,
        metadata: {
          source: "sillytavern_migration",
          _lumiverse_source_filename: p.avatarKey,
        },
      });

      nameToId.set(p.name, persona.id);
      existingBySource.set(p.avatarKey, { id: persona.id, name: p.name });
      imported++;

      const avatarPath = fs.join(avatarDir, p.avatarKey);
      if (await fs.exists(avatarPath)) {
        try {
          const avatarBuffer = await fs.readFile(avatarPath);
          const mimeType = p.avatarKey.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
          pendingAvatars.push({
            personaId: persona.id,
            avatarKey: p.avatarKey,
            bytes: avatarBuffer,
            mimeType,
          });
        } catch {
          // Avatar read failed, not critical
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to import persona "${p.name}": ${message}`);
      failed++;
    }

    await maybeYield();
  }

  if (pendingAvatars.length > 0) {
    try {
      const avatarResults = await uploadImages(
        userId,
        pendingAvatars.map((item) => ({
          data: item.bytes,
          filename: item.avatarKey,
          mime_type: item.mimeType,
        })),
        { concurrency: characterAvatarWriteConcurrency(), deferProcessing: true },
      );
      for (let i = 0; i < avatarResults.length; i++) {
        const image = avatarResults[i]?.image;
        const pending = pendingAvatars[i];
        if (!image || !pending) continue;
        setPersonaImage(userId, pending.personaId, image.id);
        setPersonaAvatar(userId, pending.personaId, image.filename);
        avatarsUploaded++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Persona avatar batch failed; personas were still imported: ${message}`);
    }
  }

  return { imported, skipped, failed, avatarsUploaded, nameToId };
}

type ChatWorkItem =
  | { kind: "char-missing"; charDirName: string; files: string[] }
  | { kind: "chat"; charDirName: string; characterId: string; fileName: string };

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
  let skipped = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedChars = 0;

  if (!(await fs.exists(chatsDir))) {
    return { imported, skipped, failed, totalMessages, skippedChars };
  }

  const entries = await fs.readdir(chatsDir);
  const charDirs = entries.filter((e) => e.isDirectory);
  const existingBySource = listChatSourceFilenameIds(userId);
  const work: ChatWorkItem[] = [];

  for (const dir of charDirs) {
    const chatEntries = await fs.readdir(fs.join(chatsDir, dir.name));
    const jsonlFiles = chatEntries
      .filter((e) => e.isFile && fs.extname(e.name).toLowerCase() === ".jsonl")
      .map((e) => e.name);
    const characterId = filenameToId.get(dir.name);
    if (!characterId) {
      work.push({ kind: "char-missing", charDirName: dir.name, files: jsonlFiles });
      continue;
    }
    for (const fileName of jsonlFiles) {
      work.push({ kind: "chat", charDirName: dir.name, characterId, fileName });
    }
  }

  const totalChats = work.reduce((sum, item) => sum + (item.kind === "chat" ? 1 : item.files.length), 0);
  let processedChats = 0;
  const maybeYield = createCooperativeYielder(yieldEveryChatBatch);

  const chatItems = work.filter((item): item is Extract<ChatWorkItem, { kind: "chat" }> => item.kind === "chat");
  for (const item of work) {
    if (item.kind !== "char-missing") continue;
    skippedChars++;
    processedChats += item.files.length;
    logger.warn(`No character found for "${item.charDirName}", skipping ${item.files.length} chat(s)`);
    logger.progress("Importing chats", processedChats, totalChats);
    await maybeYield();
  }

  for (let batchStart = 0; batchStart < chatItems.length; batchStart += characterBatchSize()) {
    const batch = chatItems.slice(batchStart, batchStart + characterBatchSize());
    const prepared = await mapWithConcurrency(batch, chatReadConcurrency(), async (item) => {
      const sourceKey = characterChatSourceKey(item.charDirName, item.fileName);
      if (existingBySource.has(sourceKey)) {
        return { kind: "skipped" as const, sourceKey };
      }
      try {
        const chatData = await readCharacterChatFile({
          stDataDir,
          charDirName: item.charDirName,
          chatFileName: item.fileName,
          personaNameToId,
          filenameToId,
          fs,
        });
        if (!chatData) {
          return { kind: "unreadable" as const, label: `${item.charDirName}/${item.fileName}` };
        }
        return {
          kind: "ready" as const,
          item,
          sourceKey,
          chatData,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          kind: "failed" as const,
          label: `${item.charDirName}/${item.fileName}`,
          message,
        };
      }
    });

    getDb().transaction(() => {
      for (const preparedItem of prepared) {
        if (preparedItem.kind === "skipped") {
          skipped++;
          continue;
        }
        if (preparedItem.kind === "unreadable") {
          logger.warn(`Could not read ${preparedItem.label}, skipping`);
          continue;
        }
        if (preparedItem.kind === "failed") {
          logger.warn(`Failed to import chat "${preparedItem.label}": ${preparedItem.message}`);
          failed++;
          continue;
        }
        try {
          const chat = createChatRaw(userId, {
            character_id: preparedItem.item.characterId,
            name: preparedItem.chatData.name,
            metadata: {
              ...(preparedItem.chatData.metadata ?? {}),
              source: "sillytavern_migration",
              _lumiverse_source_filename: preparedItem.sourceKey,
            },
            created_at: preparedItem.chatData.created_at,
          });
          const msgCount = bulkInsertMessages(chat.id, preparedItem.chatData.messages, userId);
          existingBySource.set(preparedItem.sourceKey, chat.id);
          imported++;
          totalMessages += msgCount;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to import chat "${preparedItem.item.charDirName}/${preparedItem.item.fileName}": ${message}`);
          failed++;
        }
      }
    })();

    processedChats += batch.length;
    logger.progress("Importing chats", processedChats, totalChats);
    await maybeYield();
  }

  return { imported, skipped, failed, totalMessages, skippedChars };
}

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

  const groupChatFiles = await readGroupChatFileEntries(stDataDir, fs);
  const referencedChatIds = new Set<string>();
  for (const group of groupDefs) {
    for (const chatId of group.chatIds) {
      referencedChatIds.add(
        chatId.toLowerCase().endsWith(".jsonl") ? fs.basename(chatId, ".jsonl") : chatId
      );
    }
  }

  const unreferencedGroupChatFiles = groupChatFiles.filter((entry) => !referencedChatIds.has(entry.id));
  if (unreferencedGroupChatFiles.length > 0) {
    failed += unreferencedGroupChatFiles.length;
    logger.warn(
      `${unreferencedGroupChatFiles.length} group chat file(s) were not listed in any groups/*.json chats array and could not be matched to a group`
    );
  }

  const existingBySource = listChatSourceFilenameIds(userId);
  type GroupChatWork = {
    groupName: string;
    memberCharIds: string[];
    chatId: string;
    createDate?: string;
  };
  const work: GroupChatWork[] = [];
  let skippedProgress = 0;

  for (const group of groupDefs) {
    const memberCharIds: string[] = [];
    for (const memberFile of group.members) {
      const stem = fs.basename(memberFile, ".png");
      const charId = filenameToId.get(stem);
      if (charId) memberCharIds.push(charId);
    }

    if (memberCharIds.length === 0) {
      skipped++;
      skippedProgress += group.chatIds.length;
      logger.warn(`No members found for group "${group.name}", skipping`);
      continue;
    }

    for (const chatId of group.chatIds) {
      work.push({
        groupName: group.name,
        memberCharIds,
        chatId,
        createDate: group.createDate,
      });
    }
  }

  const totalChatsToProcess = work.length + skippedProgress;
  let processedChats = skippedProgress;
  logger.progress("Importing group chats", processedChats, totalChatsToProcess);

  const maybeYield = createCooperativeYielder(yieldEveryChatBatch);
  for (let batchStart = 0; batchStart < work.length; batchStart += characterBatchSize()) {
    const batch = work.slice(batchStart, batchStart + characterBatchSize());
    const prepared = await mapWithConcurrency(batch, groupChatReadConcurrency(), async (item) => {
      const sourceKey = groupChatSourceKey(item.chatId);
      if (existingBySource.has(sourceKey)) {
        return { kind: "skipped" as const, sourceKey };
      }
      const chatData = await readGroupChatFile(stDataDir, item.chatId, personaNameToId, filenameToId, fs);
      if (!chatData) {
        return { kind: "unreadable" as const, label: `${item.groupName}/${item.chatId}` };
      }
      return { kind: "ready" as const, item, sourceKey, chatData };
    });

    getDb().transaction(() => {
      for (const preparedItem of prepared) {
        if (preparedItem.kind === "skipped") {
          skipped++;
          continue;
        }
        if (preparedItem.kind === "unreadable") {
          logger.warn(`Could not read group chat "${preparedItem.label}", skipping`);
          failed++;
          continue;
        }
        try {
          let chatCreatedAt = preparedItem.chatData.createdAt;
          if (!chatCreatedAt && preparedItem.item.createDate) {
            const ts = parseDateString(preparedItem.item.createDate);
            if (ts) chatCreatedAt = ts;
          }
          const chat = createChatRaw(userId, {
            character_id: preparedItem.item.memberCharIds[0],
            name: preparedItem.item.groupName,
            metadata: {
              group: true,
              character_ids: preparedItem.item.memberCharIds,
              source: "sillytavern_migration",
              _lumiverse_source_filename: preparedItem.sourceKey,
            },
            created_at: chatCreatedAt,
          });
          const msgCount = bulkInsertMessages(chat.id, preparedItem.chatData.messages, userId);
          existingBySource.set(preparedItem.sourceKey, chat.id);
          imported++;
          totalMessages += msgCount;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to import group chat "${preparedItem.item.groupName}/${preparedItem.item.chatId}": ${message}`);
          failed++;
        }
      }
    })();

    processedChats += batch.length;
    logger.progress("Importing group chats", processedChats, totalChatsToProcess);
    await maybeYield();
  }

  return { imported, failed, skipped, totalMessages };
}

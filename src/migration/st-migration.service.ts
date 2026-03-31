/**
 * UI-driven SillyTavern migration orchestrator.
 *
 * Wraps st-importer.ts functions with a MigrationLogger that emits WebSocket
 * progress events instead of console output. Prevents concurrent migrations
 * via an in-memory lock.
 */

import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { scanSTData } from "./st-reader";
import type { MigrationLogger } from "./st-reader";
import {
  importCharacters,
  importWorldBooks,
  importPersonas,
  importChats,
  importGroupChats,
} from "./st-importer";
import type { FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MigrationScope {
  characters: boolean;
  worldBooks: boolean;
  personas: boolean;
  chats: boolean;
  groupChats: boolean;
}

export interface MigrationResults {
  characters?: { imported: number; skipped: number; failed: number };
  world_books?: { imported: number; failed: number; total_entries: number };
  personas?: { imported: number; failed: number; avatars_uploaded: number };
  chats?: { imported: number; failed: number; total_messages: number };
  group_chats?: { imported: number; failed: number; skipped: number; total_messages: number };
}

interface MigrationState {
  migrationId: string;
  callerUserId: string;
  targetUserId: string;
  phase: string;
  startedAt: number;
  results: MigrationResults | null;
  error: string | null;
  completed: boolean;
}

// ─── In-memory lock ─────────────────────────────────────────────────────────

const activeMigrations = new Map<string, MigrationState>();
let currentMigrationId: string | null = null;

export function getActiveMigration(): MigrationState | null {
  if (!currentMigrationId) return null;
  return activeMigrations.get(currentMigrationId) ?? null;
}

export function getLastMigration(): MigrationState | null {
  let latest: MigrationState | null = null;
  for (const state of activeMigrations.values()) {
    if (state.completed && (!latest || state.startedAt > latest.startedAt)) {
      latest = state;
    }
  }
  return latest;
}

export function isMigrationRunning(): boolean {
  return currentMigrationId !== null;
}

// ─── Logger factory ─────────────────────────────────────────────────────────

function createWsLogger(migrationId: string, callerUserId: string): MigrationLogger {
  return {
    info(message: string) {
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "info", message }, callerUserId);
    },
    warn(message: string) {
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "warn", message }, callerUserId);
    },
    error(message: string) {
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "error", message }, callerUserId);
    },
    progress(label: string, current: number, total: number) {
      const state = activeMigrations.get(migrationId);
      eventBus.emit(EventType.MIGRATION_PROGRESS, {
        migrationId,
        phase: state?.phase ?? "unknown",
        label,
        current,
        total,
      }, callerUserId);
    },
  };
}

// ─── Default filesystem singleton ──────────────────────────────────────────

const defaultFs = new LocalFileSystem();

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function executeMigration(
  migrationId: string,
  callerUserId: string,
  targetUserId: string,
  dataDir: string,
  scope: MigrationScope,
  fs: FileSystem = defaultFs,
): Promise<void> {
  const startTime = Date.now();

  const state: MigrationState = {
    migrationId,
    callerUserId,
    targetUserId,
    phase: "starting",
    startedAt: startTime,
    results: null,
    error: null,
    completed: false,
  };

  activeMigrations.set(migrationId, state);
  currentMigrationId = migrationId;

  const logger = createWsLogger(migrationId, callerUserId);

  // Helper to emit phase transitions so the frontend always tracks state
  const setPhase = (phase: string) => {
    state.phase = phase;
    eventBus.emit(EventType.MIGRATION_PROGRESS, {
      migrationId,
      phase,
      label: phase,
      current: 0,
      total: 0,
    }, callerUserId);
  };

  try {
    if (!(await fs.exists(dataDir))) {
      throw new Error(`Data directory no longer exists: ${dataDir}`);
    }

    setPhase("scanning");
    logger.info("Scanning SillyTavern data directory...");
    const counts = await scanSTData(dataDir, fs);
    const results: MigrationResults = {};

    // Characters (needed first for filenameToId mapping)
    let filenameToId = new Map<string, string>();
    if (scope.characters && counts.characters > 0) {
      setPhase("characters");
      logger.info(`Importing ${counts.characters} characters...`);
      const charResult = await importCharacters(targetUserId, dataDir, logger, fs);
      filenameToId = charResult.filenameToId;
      results.characters = {
        imported: charResult.imported,
        skipped: charResult.skipped,
        failed: charResult.failed,
      };
      logger.info(`Characters: ${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`);
    }

    // World Books
    let worldBookNameToId = new Map<string, string>();
    if (scope.worldBooks && counts.worldBooks > 0) {
      setPhase("worldBooks");
      logger.info(`Importing ${counts.worldBooks} world books...`);
      const wbResult = await importWorldBooks(targetUserId, dataDir, logger, fs);
      worldBookNameToId = wbResult.nameToId;
      results.world_books = {
        imported: wbResult.imported,
        failed: wbResult.failed,
        total_entries: wbResult.totalEntries,
      };
      logger.info(`World books: ${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`);
    }

    // Personas
    let personaNameToId = new Map<string, string>();
    if (scope.personas && counts.personas > 0) {
      setPhase("personas");
      logger.info(`Importing ${counts.personas} personas...`);
      const pResult = await importPersonas(targetUserId, dataDir, worldBookNameToId, logger, fs);
      personaNameToId = pResult.nameToId;
      results.personas = {
        imported: pResult.imported,
        failed: pResult.failed,
        avatars_uploaded: pResult.avatarsUploaded,
      };
      logger.info(`Personas: ${pResult.imported} imported, ${pResult.failed} failed, ${pResult.avatarsUploaded} avatars`);
    }

    // Chats
    if (scope.chats && counts.totalChatFiles > 0) {
      setPhase("chats");
      logger.info(`Importing chats...`);
      const chatResult = await importChats(targetUserId, dataDir, filenameToId, personaNameToId, logger, fs);
      results.chats = {
        imported: chatResult.imported,
        failed: chatResult.failed,
        total_messages: chatResult.totalMessages,
      };
      logger.info(`Chats: ${chatResult.imported} imported (${chatResult.totalMessages} messages), ${chatResult.failed} failed`);
      if (chatResult.skippedChars > 0) {
        logger.warn(`${chatResult.skippedChars} character(s) not found — their chats were skipped`);
      }
    }

    // Group Chats
    if (scope.groupChats && counts.groupChats > 0) {
      setPhase("groupChats");
      logger.info(`Importing group chats...`);
      const gcResult = await importGroupChats(targetUserId, dataDir, filenameToId, personaNameToId, logger, fs);
      results.group_chats = {
        imported: gcResult.imported,
        failed: gcResult.failed,
        skipped: gcResult.skipped,
        total_messages: gcResult.totalMessages,
      };
      logger.info(`Group chats: ${gcResult.imported} imported (${gcResult.totalMessages} messages), ${gcResult.failed} failed`);
      if (gcResult.skipped > 0) {
        logger.warn(`${gcResult.skipped} group(s) skipped — no members found`);
      }
    }

    const durationMs = Date.now() - startTime;
    state.results = results;
    state.completed = true;
    state.phase = "completed";

    eventBus.emit(EventType.MIGRATION_COMPLETED, {
      migrationId,
      durationMs,
      results,
    }, callerUserId);

    logger.info(`Migration complete in ${(durationMs / 1000).toFixed(1)}s`);
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    state.error = errorMsg;
    state.completed = true;
    state.phase = "failed";

    eventBus.emit(EventType.MIGRATION_FAILED, {
      migrationId,
      error: errorMsg,
    }, callerUserId);

    logger.error(`Migration failed: ${errorMsg}`);
  } finally {
    currentMigrationId = null;
    // Disconnect remote filesystems when migration ends
    if (fs.type !== "local") {
      try { await fs.disconnect(); } catch { /* ignore */ }
    }
  }
}

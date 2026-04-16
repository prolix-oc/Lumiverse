/**
 * Docker SillyTavern migration orchestrator.
 *
 * Called at startup when LUMIVERSE_ST_MIGRATE=true. Reads ST data from a
 * bind-mounted directory (read-only) and imports it into Lumiverse using
 * direct service calls. Migration state is tracked in the settings table
 * to prevent re-runs.
 */

import { existsSync } from "fs";
import { join } from "path";
import { env } from "../env";
import { getFirstUserId } from "../auth/seed";
import { getSetting, putSetting } from "../services/settings.service";
import { scanSTData } from "./st-reader";
import type { MigrationLogger } from "./st-reader";
import {
  importCharacters,
  importWorldBooks,
  importPersonas,
  importChats,
  importGroupChats,
} from "./st-importer";

// ─── Types ──────────────────────────────────────────────────────────────────

interface DockerSTMigrationStatus {
  completed_at: number;
  source_path: string;
  target_user: string;
  migration_target: number;
  results: {
    characters?: { imported: number; skipped: number; failed: number };
    world_books?: { imported: number; failed: number; total_entries: number };
    personas?: { imported: number; failed: number; avatars_uploaded: number };
    chats?: { imported: number; failed: number; total_messages: number };
    group_chats?: { imported: number; failed: number; skipped: number; total_messages: number };
  };
  duration_ms: number;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

const logger: MigrationLogger = {
  info: (msg) => console.log(`[ST Migration] ${msg}`),
  warn: (msg) => console.warn(`[ST Migration] ${msg}`),
  error: (msg) => console.error(`[ST Migration] ${msg}`),
  progress: (label, current, total) => {
    // Log at intervals to avoid flooding Docker logs
    if (
      current === 1 ||
      current === total ||
      current % Math.max(1, Math.floor(total / 10)) === 0
    ) {
      console.log(`[ST Migration] ${label}... (${current}/${total})`);
    }
  },
};

// ─── Target resolution ──────────────────────────────────────────────────────

const TARGET_LABELS: Record<number, string> = {
  1: "Characters only",
  2: "World Books only",
  3: "Personas only",
  4: "Characters + Chat History",
  5: "Everything",
};

function resolveTargetFlags(target: number): {
  doCharacters: boolean;
  doWorldBooks: boolean;
  doPersonas: boolean;
  doChats: boolean;
  doGroupChats: boolean;
} {
  switch (target) {
    case 1: return { doCharacters: true, doWorldBooks: false, doPersonas: false, doChats: false, doGroupChats: false };
    case 2: return { doCharacters: false, doWorldBooks: true, doPersonas: false, doChats: false, doGroupChats: false };
    case 3: return { doCharacters: false, doWorldBooks: false, doPersonas: true, doChats: false, doGroupChats: false };
    case 4: return { doCharacters: true, doWorldBooks: false, doPersonas: false, doChats: true, doGroupChats: true };
    case 5:
    default: return { doCharacters: true, doWorldBooks: true, doPersonas: true, doChats: true, doGroupChats: true };
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function runDockerSTMigration(): Promise<void> {
  const startTime = Date.now();

  try {
    logger.info("Starting SillyTavern migration...");

    // 1. Get the owner user ID
    const userId = getFirstUserId();
    if (!userId) {
      logger.error("No owner user found. Run the setup wizard first.");
      return;
    }

    // 2. Check migration state
    const existingStatus = getSetting(userId, "docker_st_migration_status");
    if (existingStatus && !env.stForceNewMigration) {
      const status = existingStatus.value as DockerSTMigrationStatus;
      const completedDate = new Date(status.completed_at * 1000).toISOString();
      logger.info(`Migration already completed on ${completedDate}. Set LUMIVERSE_FORCE_NEW_MIGRATION=true to re-run.`);
      return;
    }

    // 3. Resolve ST data directory
    const stPath = env.stPath;
    if (!existsSync(stPath)) {
      logger.warn(`SillyTavern path not found: ${stPath}`);
      logger.warn("Make sure you've bind-mounted your ST folder. Skipping migration.");
      return;
    }

    const primaryDataDir = join(stPath, "data", env.stTargetUser);
    const legacyDataDir = join(stPath, "public");

    let effectiveDataDir: string;
    if (existsSync(primaryDataDir)) {
      effectiveDataDir = primaryDataDir;
    } else if (existsSync(join(legacyDataDir, "characters"))) {
      effectiveDataDir = legacyDataDir;
      logger.info("Using legacy directory structure: public/");
    } else {
      logger.warn(`Data directory not found: ${primaryDataDir}`);
      logger.warn(`Expected: {SILLYTAVERN_PATH}/data/{SILLYTAVERN_TARGET_USER}/`);
      return;
    }

    logger.info(`Source: ${effectiveDataDir}`);

    // 4. Scan available data
    const counts = await scanSTData(effectiveDataDir);
    const totalItems = counts.characters + counts.totalChatFiles + counts.groupChatFiles + counts.worldBooks + counts.personas;

    if (totalItems === 0) {
      logger.info("No data found to import. Skipping migration.");
      return;
    }

    const target = env.stMigrationTarget;
    logger.info(`Target: ${TARGET_LABELS[target] || "Everything"} (option ${target})`);
    logger.info(
      `Scan: ${counts.characters} characters, ${counts.totalChatFiles} chats, ` +
      `${counts.groupChatFiles} group chats, ${counts.worldBooks} world books, ${counts.personas} personas`
    );

    // 5. Resolve import flags
    const { doCharacters, doWorldBooks, doPersonas, doChats, doGroupChats } = resolveTargetFlags(target);

    // 6. Execute imports in order
    const results: DockerSTMigrationStatus["results"] = {};

    // Characters (needed first — chat import depends on filenameToId mapping)
    let filenameToId = new Map<string, string>();
    if (doCharacters && counts.characters > 0) {
      const charResult = await importCharacters(userId, effectiveDataDir, logger);
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
    if (doWorldBooks && counts.worldBooks > 0) {
      const wbResult = await importWorldBooks(userId, effectiveDataDir, logger);
      worldBookNameToId = wbResult.nameToId;
      results.world_books = {
        imported: wbResult.imported,
        failed: wbResult.failed,
        total_entries: wbResult.totalEntries,
      };
      logger.info(`World books: ${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`);
    }

    // Personas (needs worldBookNameToId for lorebook attachment)
    let personaNameToId = new Map<string, string>();
    if (doPersonas && counts.personas > 0) {
      const pResult = await importPersonas(userId, effectiveDataDir, worldBookNameToId, logger);
      personaNameToId = pResult.nameToId;
      results.personas = {
        imported: pResult.imported,
        failed: pResult.failed,
        avatars_uploaded: pResult.avatarsUploaded,
      };
      logger.info(`Personas: ${pResult.imported} imported, ${pResult.failed} failed, ${pResult.avatarsUploaded} avatars`);
    }

    // Chats (needs filenameToId + personaNameToId)
    if (doChats && counts.totalChatFiles > 0) {
      const chatResult = await importChats(userId, effectiveDataDir, filenameToId, personaNameToId, logger);
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

    // Group Chats (needs filenameToId + personaNameToId)
    if (doGroupChats && counts.groupChats > 0) {
      const gcResult = await importGroupChats(userId, effectiveDataDir, filenameToId, personaNameToId, logger);
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

    // 7. Record migration state
    const durationMs = Date.now() - startTime;
    const status: DockerSTMigrationStatus = {
      completed_at: Math.floor(Date.now() / 1000),
      source_path: effectiveDataDir,
      target_user: env.stTargetUser,
      migration_target: target,
      results,
      duration_ms: durationMs,
    };

    putSetting(userId, "docker_st_migration_status", status);
    logger.info(`Migration complete in ${(durationMs / 1000).toFixed(1)}s`);
  } catch (err: any) {
    logger.error(`Migration failed: ${err.message || err}`);
    // Never throw — server startup must continue
  }
}

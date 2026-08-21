import type { FileSystem } from "../file-connections/types";
import { listCharacterSourceFilenameIds } from "../services/characters.service";
import { waitForDeferredImageProcessing } from "../services/images.service";
import { listPersonaSourceFilenameIds } from "../services/personas.service";
import { applySharpSettings, getSharpSettingsStatus } from "../services/sharp-settings.service";
import { listSillyTavernWorldBookNameIds } from "../services/world-books.service";
import { currentWorkerBudget } from "../utils/cpu-budget";
import {
  clearStMigrationCheckpoint,
  loadStMigrationCheckpoint,
  markStMigrationPhase,
  saveStMigrationCheckpoint,
  type StMigrationCheckpoint,
  type StMigrationPhase,
} from "./st-checkpoint";
import {
  importCharacters,
  importChats,
  importGroupChats,
  importPersonas,
  importWorldBooks,
} from "./st-importer";
import { importSTConnections } from "./st-connections";
import { scanSTData, type MigrationLogger } from "./st-reader";
import type { MigrationResults, MigrationScope } from "./st-types";
export interface RunStMigrationHooks {
  setPhase?: (phase: string) => void;
}

export interface RunStMigrationOutcome {
  results: MigrationResults;
  importedCharacterCount: number;
  characterImportAttempted: boolean;
}

export async function runStMigrationPipeline(
  migrationId: string,
  targetUserId: string,
  dataDir: string,
  scope: MigrationScope,
  logger: MigrationLogger,
  fs: FileSystem,
  hooks: RunStMigrationHooks = {},
): Promise<RunStMigrationOutcome> {
  const budget = currentWorkerBudget();
  const previousSharp = getSharpSettingsStatus().configuredSettings;
  const configuredSharp = previousSharp.concurrency;
  applySharpSettings({
    ...previousSharp,
    concurrency: configuredSharp == null
      ? budget.sharpConcurrency
      : Math.min(configuredSharp, budget.sharpConcurrency),
  });
  logger.info(
    `Using ${budget.logicalThreads} logical threads (reserve ${budget.reserved}): ${budget.workerConcurrency} import workers, ${budget.sharpConcurrency} Sharp threads, ${budget.deferredImageConcurrency} deferred thumbnails.`,
  );
  try {
    return await runStMigrationPipelineInner(migrationId, targetUserId, dataDir, scope, logger, fs, hooks);
  } finally {
    await waitForDeferredImageProcessing();
    applySharpSettings(previousSharp);
  }
}

async function runStMigrationPipelineInner(
  migrationId: string,
  targetUserId: string,
  dataDir: string,
  scope: MigrationScope,
  logger: MigrationLogger,
  fs: FileSystem,
  hooks: RunStMigrationHooks,
): Promise<RunStMigrationOutcome> {
  const setPhase = hooks.setPhase ?? (() => {});
  let importedCharacterCount = 0;
  let characterImportAttempted = false;

  if (!(await fs.exists(dataDir))) {
    throw new Error(`Data directory no longer exists: ${dataDir}`);
  }

  setPhase("scanning");
  logger.info("Scanning SillyTavern data directory...");
  const counts = await scanSTData(dataDir, fs);
  const existingCheckpoint = loadStMigrationCheckpoint(targetUserId, dataDir, scope);
  let checkpoint: StMigrationCheckpoint = existingCheckpoint ?? {
    version: 1,
    migrationId,
    dataDir,
    scope,
    completedPhases: [],
    results: {},
    updatedAt: Date.now(),
  };
  if (!existingCheckpoint) {
    saveStMigrationCheckpoint(targetUserId, checkpoint);
  } else {
    logger.info("Resuming from a previous incomplete migration checkpoint.");
  }
  const results: MigrationResults = { ...checkpoint.results };
  const phaseDone = (phase: StMigrationPhase) => checkpoint.completedPhases.includes(phase);
  const finishPhase = (phase: StMigrationPhase) => {
    checkpoint = markStMigrationPhase(targetUserId, checkpoint, phase, results);
  };

  if (scope.connections && (counts.connections > 0 || counts.proxies > 0) && !phaseDone("connections")) {
    setPhase("connections");
    logger.info("Importing SillyTavern connections...");
    const connectionResult = await importSTConnections(targetUserId, dataDir, scope, logger, fs);
    results.connections = connectionResult;
    finishPhase("connections");
    logger.info(`Connections: ${connectionResult.imported} imported, ${connectionResult.repaired} repaired, ${connectionResult.skipped} skipped`);
  }

  let filenameToId = new Map<string, string>();
  if (scope.characters && counts.characters > 0) {
    if (phaseDone("characters")) {
      filenameToId = listCharacterSourceFilenameIds(targetUserId);
      const remapped = new Map<string, string>();
      for (const [filename, id] of filenameToId) {
        if (filename.toLowerCase().endsWith(".png")) {
          remapped.set(filename.slice(0, -4), id);
        } else {
          filenameToId.set(filename, id);
        }
      }
      for (const [stem, id] of remapped) filenameToId.set(stem, id);
    } else {
      characterImportAttempted = true;
      setPhase("characters");
      logger.info(`Importing ${counts.characters} characters...`);
      const charResult = await importCharacters(targetUserId, dataDir, logger, fs);
      filenameToId = charResult.filenameToId;
      results.characters = {
        imported: charResult.imported,
        skipped: charResult.skipped,
        failed: charResult.failed,
      };
      importedCharacterCount = charResult.imported;
      finishPhase("characters");
      logger.info(`Characters: ${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`);
    }
  }

  let worldBookNameToId = new Map<string, string>();
  if (scope.worldBooks && counts.worldBooks > 0) {
    if (phaseDone("worldBooks")) {
      worldBookNameToId = listSillyTavernWorldBookNameIds(targetUserId);
    } else {
      setPhase("worldBooks");
      logger.info(`Importing ${counts.worldBooks} world books...`);
      const wbResult = await importWorldBooks(targetUserId, dataDir, logger, fs);
      worldBookNameToId = wbResult.nameToId;
      results.world_books = {
        imported: wbResult.imported,
        skipped: wbResult.skipped,
        failed: wbResult.failed,
        total_entries: wbResult.totalEntries,
      };
      finishPhase("worldBooks");
      logger.info(`World books: ${wbResult.imported} imported, ${wbResult.skipped} skipped (${wbResult.totalEntries} entries), ${wbResult.failed} failed`);
    }
  }

  let personaNameToId = new Map<string, string>();
  if (scope.personas && counts.personas > 0) {
    if (phaseDone("personas")) {
      for (const persona of listPersonaSourceFilenameIds(targetUserId).values()) {
        personaNameToId.set(persona.name, persona.id);
      }
    } else {
      setPhase("personas");
      logger.info(`Importing ${counts.personas} personas...`);
      const pResult = await importPersonas(targetUserId, dataDir, worldBookNameToId, logger, fs);
      personaNameToId = pResult.nameToId;
      results.personas = {
        imported: pResult.imported,
        skipped: pResult.skipped,
        failed: pResult.failed,
        avatars_uploaded: pResult.avatarsUploaded,
      };
      finishPhase("personas");
      logger.info(`Personas: ${pResult.imported} imported, ${pResult.skipped} skipped, ${pResult.failed} failed, ${pResult.avatarsUploaded} avatars`);
    }
  }

  if (scope.chats && counts.totalChatFiles > 0 && !phaseDone("chats")) {
    setPhase("chats");
    logger.info(`Importing chats...`);
    const chatResult = await importChats(targetUserId, dataDir, filenameToId, personaNameToId, logger, fs);
    results.chats = {
      imported: chatResult.imported,
      skipped: chatResult.skipped,
      failed: chatResult.failed,
      total_messages: chatResult.totalMessages,
    };
    finishPhase("chats");
    logger.info(`Chats: ${chatResult.imported} imported (${chatResult.totalMessages} messages), ${chatResult.skipped} skipped, ${chatResult.failed} failed`);
    if (chatResult.skippedChars > 0) {
      logger.warn(`${chatResult.skippedChars} character(s) not found — their chats were skipped`);
    }
  }

  if (scope.groupChats && counts.groupChats > 0 && !phaseDone("groupChats")) {
    setPhase("groupChats");
    logger.info(`Importing group chats...`);
    const gcResult = await importGroupChats(targetUserId, dataDir, filenameToId, personaNameToId, logger, fs);
    results.group_chats = {
      imported: gcResult.imported,
      failed: gcResult.failed,
      skipped: gcResult.skipped,
      total_messages: gcResult.totalMessages,
    };
    finishPhase("groupChats");
    logger.info(`Group chats: ${gcResult.imported} imported (${gcResult.totalMessages} messages), ${gcResult.failed} failed`);
    if (gcResult.skipped > 0) {
      logger.warn(`${gcResult.skipped} group(s) skipped — no members found`);
    }
  }

  clearStMigrationCheckpoint(targetUserId);
  return { results, importedCharacterCount, characterImportAttempted };
}

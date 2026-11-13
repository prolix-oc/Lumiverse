import type { Database } from "bun:sqlite";
import { editConnectionOrganizationWithDb } from './connection-organization-operations';
import { removeGalleryItemWithDb } from './gallery-operations';
import { startCharacterDeletionWithDb, getDeletionOperationWithDb } from "./deletion-operations";
import { updateCharacterRowWithDb, updateCharacterTagsWithDb } from "./character-operations";
import { putSettingsWithDb } from "./settings-operations";
import { mutatePersonaWithDb } from "./persona-operations";
import { mutateGlobalAddonWithDb } from "./global-addon-operations";
import { findReferencedImageIds } from "./image-reference-operations";
import { deleteRegexScriptsWithDb, mutateRegexWithDb } from "./regex-operations";
import { mutatePresetWithDb } from "./preset-operations";
import { mutateChatWithDb, clearRemovedChatAvatarReferencesWithDb } from "./chat-operations";
import {
  collectDatabaseStats, readDatabaseMaintenanceSettings, readDatabaseMaintenanceState,
  readDatabaseTuningSettings, resolveDatabaseTuning, runDatabaseMaintenance,
} from "./maintenance";
import type { DatabaseOperation, SqlStatementOperation } from "./execution-protocol";
import type { ImageReferenceDiagnostics } from "./image-reference-diagnostics";

class DatabaseCompareError extends Error {
  readonly code = "DATABASE_COMPARE_FAILED";
  statementIndex?: number;
}

function executeStatement(db: Database, operation: SqlStatementOperation): unknown {
  const statement = db.prepare(operation.sql);
  try {
    const bindings = operation.bindings ?? [];
    switch (operation.mode ?? "run") {
      case "get": return statement.get(...bindings);
      case "all": return statement.all(...bindings);
      case "run": {
        const result = statement.run(...bindings);
        // Bun's run().changes can include trigger and FK side effects. CAS
        // checks and deletion counts need SQLite's direct statement row count.
        const changesStatement = db.prepare("SELECT changes() AS count");
        let changes: number;
        try { changes = (changesStatement.get() as { count: number }).count; }
        finally { changesStatement.finalize(); }
        if (operation.expectedChanges !== undefined && changes !== operation.expectedChanges) {
          throw new DatabaseCompareError(`Expected ${operation.expectedChanges} changed row(s), received ${changes}`);
        }
        return { ...result, changes };
      }
    }
  } finally {
    statement.finalize();
  }
}

/** Complete operations execute in one isolate and never await inside SQLite. */
export function executeOperation(db: Database, path: string, operation: DatabaseOperation, diagnostics?: ImageReferenceDiagnostics): unknown {
  switch (operation.kind) {
    case 'connection-organization-edit': return editConnectionOrganizationWithDb(db, operation.userId, operation.edits);
    case "gallery-remove": return removeGalleryItemWithDb(db, operation.userId, operation.characterId, operation.itemId);
    case "character-delete-start": return startCharacterDeletionWithDb(db, operation.userId, operation.id, operation.operationId);
    case "deletion-status": return getDeletionOperationWithDb(db, operation.userId, operation.operationId);
    case "regex-mutation": return mutateRegexWithDb(db, operation.mutation);
    case "chat-mutation": return mutateChatWithDb(db, operation.mutation);
    case "chat-clear-avatars": return db.transaction(() => clearRemovedChatAvatarReferencesWithDb(db, operation.userId, operation.ids)).immediate();
    case "preset-mutation": return mutatePresetWithDb(db, operation.mutation);
    case "regex-delete": return deleteRegexScriptsWithDb(db, operation.userId, operation.ids, operation.context);
    case "image-references": return [...findReferencedImageIds(db, operation.userId, new Set(operation.ids), diagnostics)];
    case "global-addon-mutation": return mutateGlobalAddonWithDb(db, operation.mutation);
    case "persona-mutation": return mutatePersonaWithDb(db, operation.mutation);
    case "pagination": return db.transaction(() => {
      const rows = executeStatement(db, { sql: `${operation.dataSql} LIMIT ? OFFSET ?`, bindings: [...operation.bindings, operation.limit + 1, operation.offset], mode: "all" }) as unknown[];
      const hasMore = rows.length > operation.limit;
      if (hasMore) rows.length = operation.limit;
      const total = operation.offset === 0 && !hasMore ? rows.length : (executeStatement(db, { sql: operation.countSql, bindings: operation.bindings, mode: "get" }) as { count: number } | null)?.count ?? 0;
      return { rows, total };
    })();
    case "settings-put": return putSettingsWithDb(db, operation.userId, operation.entries, operation.updatedAt);
    case "transaction":
      return db.transaction(() => operation.statements.map((statement, index) => {
        try { return executeStatement(db, statement); }
        catch (error) {
          if (error instanceof DatabaseCompareError) error.statementIndex = index;
          throw error;
        }
      })).immediate();
    case "read": return executeStatement(db, operation.statement);
    case "character-tags": return updateCharacterTagsWithDb(db, operation.userId, operation.input);
    case "character-update": return updateCharacterRowWithDb(db, operation.userId, operation.id, operation.input, operation);
    case "checkpoint": return executeStatement(db, { sql: "PRAGMA wal_checkpoint(PASSIVE)", mode: "get" });
    case "snapshot": {
      const stats = collectDatabaseStats(db, path);
      return {
        stats,
        configuredSettings: readDatabaseTuningSettings(db, operation.userId),
        maintenanceSettings: readDatabaseMaintenanceSettings(db, operation.userId),
        maintenanceState: readDatabaseMaintenanceState(db, operation.userId),
        effectiveTuning: resolveDatabaseTuning(stats, db, operation.userId),
      };
    }
    case "maintenance": return runDatabaseMaintenance(db, { ...operation.options, dbPath: path });
  }
}

export function isTransactionalOperation(operation: DatabaseOperation): boolean {
  return ["connection-organization-edit", "gallery-remove", "character-delete-start", "deletion-status", "transaction", "pagination", "image-references", "settings-put", "persona-mutation", "global-addon-mutation", "regex-delete", "regex-mutation", "preset-mutation", "chat-mutation", "chat-clear-avatars", "character-tags", "character-update"].includes(operation.kind);
}

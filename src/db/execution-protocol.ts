import type { SQLQueryBindings } from "bun:sqlite";
import type { ImageReferenceDiagnostics } from "./image-reference-diagnostics";
import type {
  AppliedDatabaseTuning, DatabaseMaintenanceResult, DatabaseMaintenanceSettings,
  DatabaseMaintenanceState, DatabaseStats, DatabaseTuningSettings, WalCheckpointMode,
} from "./maintenance";

export interface DatabaseSnapshot {
  stats: DatabaseStats;
  configuredSettings: DatabaseTuningSettings;
  maintenanceSettings: DatabaseMaintenanceSettings;
  maintenanceState: DatabaseMaintenanceState;
  effectiveTuning: AppliedDatabaseTuning;
}

export interface SqlStatementOperation {
  sql: string;
  bindings?: SQLQueryBindings[];
  mode?: "run" | "get" | "all";
  /** A mismatch aborts and rolls back the entire transaction. */
  expectedChanges?: number;
}

export type DatabaseOperation =
  | { kind: 'connection-organization-edit'; userId: string; edits: import('../shared/connection-organization-edits').OrganizationEdit[] }
  | { kind: "gallery-remove"; userId: string; characterId: string; itemId: string }
  | { kind: "character-delete-start"; userId: string; id: string; operationId: string }
  | { kind: "deletion-status"; userId: string; operationId: string }
  | { kind: "regex-mutation"; mutation: import("./regex-operations").RegexMutation }
  | { kind: "chat-mutation"; mutation: import("./chat-operations").ChatMutation }
  | { kind: "chat-clear-avatars"; userId: string; ids: string[] }
  | { kind: "preset-mutation"; mutation: import("./preset-operations").PresetMutation }
  | { kind: "regex-delete"; userId: string; ids: string[]; context?: import("./regex-operations").RegexDeletionContext }
  | { kind: "image-references"; userId: string; ids: string[] }
  | { kind: "global-addon-mutation"; mutation: import("./global-addon-operations").GlobalAddonMutation }
  | { kind: "persona-mutation"; mutation: import("./persona-operations").PersonaMutation }
  | { kind: "pagination"; dataSql: string; countSql: string; bindings: SQLQueryBindings[]; limit: number; offset: number }
  | { kind: "settings-put"; userId: string; entries: Array<{ key: string; json: string }>; updatedAt: number }
  | { kind: "transaction"; statements: SqlStatementOperation[] }
  | { kind: "read"; statement: SqlStatementOperation }
  | { kind: "character-tags"; userId: string; input: { ids: string[]; operation: "add" | "remove" | "replace"; tags: string[] } }
  | { kind: "character-update"; userId: string; id: string; input: import("../types/character").UpdateCharacterInput; preserveUpdatedAt?: boolean }
  | { kind: "checkpoint" }
  | { kind: "snapshot"; userId: string }
  | { kind: "maintenance"; options: {
      userId?: string | null; optimize?: boolean; analyze?: boolean; vacuum?: boolean;
      refreshTuning?: boolean; checkpointMode?: WalCheckpointMode | null;
    } };

export type DatabaseExecutionOutcome = "not-started" | "rolled-back" | "unknown";
export interface DatabaseExecutionFailure {
  message: string;
  name?: string;
  code?: string;
  outcome: DatabaseExecutionOutcome;
  statementIndex?: number;
}
export type DatabaseHostMessage =
  | { type: "execute"; requestId: string; operation: DatabaseOperation }
  | { type: "start-background" }
  | { type: "shutdown" };
export type DatabaseChildMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; result: unknown; durationMs: number; imageReferences?: ImageReferenceDiagnostics }
  | { type: "error"; requestId?: string; error: DatabaseExecutionFailure };

export type MaintenanceResult = DatabaseMaintenanceResult;

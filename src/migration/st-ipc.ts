import type { FileConnectionConfig } from "../file-connections/types";
import type { MigrationResults, MigrationScope } from "./st-types";

export interface StMigrationJob {
  migrationId: string;
  callerUserId: string;
  targetUserId: string;
  dataDir: string;
  scope: MigrationScope;
  connection: FileConnectionConfig;
}

export type HostToStMigration =
  | { type: "start"; job: StMigrationJob }
  | { type: "shutdown" };

export type StMigrationToHost =
  | { type: "ready" }
  | { type: "progress"; phase: string; label: string; current: number; total: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "thumbnailQueue"; processed: number; remaining: number; total: number; active: number; queued: number }
  | {
      type: "done";
      results: MigrationResults;
      importedCharacterCount: number;
      characterImportAttempted: boolean;
      durationMs: number;
    }
  | {
      type: "failed";
      error: string;
      importedCharacterCount: number;
      characterImportAttempted: boolean;
    };

import { deleteSetting, getSetting, putSetting } from "../services/settings.service";
import type { MigrationResults, MigrationScope } from "./st-types";

export const ST_MIGRATION_CHECKPOINT_KEY = "st_migration_checkpoint";

export const ST_MIGRATION_PHASES = [
  "connections",
  "characters",
  "worldBooks",
  "personas",
  "chats",
  "groupChats",
] as const;

export type StMigrationPhase = (typeof ST_MIGRATION_PHASES)[number];

export interface StMigrationCheckpoint {
  version: 1;
  migrationId: string;
  dataDir: string;
  scope: MigrationScope;
  completedPhases: StMigrationPhase[];
  results: MigrationResults;
  updatedAt: number;
}

function sameScope(a: MigrationScope, b: MigrationScope): boolean {
  return (
    !!a.characters === !!b.characters
    && !!a.worldBooks === !!b.worldBooks
    && !!a.personas === !!b.personas
    && !!a.chats === !!b.chats
    && !!a.groupChats === !!b.groupChats
    && !!a.connections === !!b.connections
    && !!a.repairExisting === !!b.repairExisting
    && !!a.dryRun === !!b.dryRun
  );
}

function isPhase(value: unknown): value is StMigrationPhase {
  return typeof value === "string" && (ST_MIGRATION_PHASES as readonly string[]).includes(value);
}

export function parseStMigrationCheckpoint(value: unknown): StMigrationCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (typeof raw.migrationId !== "string" || !raw.migrationId) return null;
  if (typeof raw.dataDir !== "string" || !raw.dataDir) return null;
  if (!raw.scope || typeof raw.scope !== "object" || Array.isArray(raw.scope)) return null;
  if (!Array.isArray(raw.completedPhases)) return null;
  const completedPhases = raw.completedPhases.filter(isPhase);
  return {
    version: 1,
    migrationId: raw.migrationId,
    dataDir: raw.dataDir,
    scope: raw.scope as MigrationScope,
    completedPhases,
    results: raw.results && typeof raw.results === "object" && !Array.isArray(raw.results)
      ? raw.results as MigrationResults
      : {},
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export function loadStMigrationCheckpoint(
  userId: string,
  dataDir: string,
  scope: MigrationScope,
): StMigrationCheckpoint | null {
  const stored = getSetting(userId, ST_MIGRATION_CHECKPOINT_KEY);
  const checkpoint = parseStMigrationCheckpoint(stored?.value);
  if (!checkpoint) return null;
  if (checkpoint.dataDir !== dataDir || !sameScope(checkpoint.scope, scope)) return null;
  return checkpoint;
}

export function saveStMigrationCheckpoint(userId: string, checkpoint: StMigrationCheckpoint): void {
  putSetting(userId, ST_MIGRATION_CHECKPOINT_KEY, {
    ...checkpoint,
    version: 1,
    updatedAt: Date.now(),
  }, { suppressBroadcast: true });
}

export function clearStMigrationCheckpoint(userId: string): void {
  deleteSetting(userId, ST_MIGRATION_CHECKPOINT_KEY);
}

export function markStMigrationPhase(
  userId: string,
  checkpoint: StMigrationCheckpoint,
  phase: StMigrationPhase,
  results: MigrationResults,
): StMigrationCheckpoint {
  const completedPhases = checkpoint.completedPhases.includes(phase)
    ? checkpoint.completedPhases
    : [...checkpoint.completedPhases, phase];
  const next: StMigrationCheckpoint = {
    ...checkpoint,
    completedPhases,
    results: { ...checkpoint.results, ...results },
    updatedAt: Date.now(),
  };
  saveStMigrationCheckpoint(userId, next);
  return next;
}

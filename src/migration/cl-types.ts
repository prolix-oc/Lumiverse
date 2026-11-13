/** Current CharacterLibrary full-bundle format, rather than an ST user backup. */
export interface ClBundleCharacter {
  avatar: string;
  name?: string;
  create_date?: string;
  fav?: boolean;
  chat?: string;
  galleryId?: string;
  chatFiles: string[];
  gallery: { folder: string; files: string[] };
  primaryWorld?: string;
  auxWorlds?: string[];
  worlds?: string[];
}

export interface ClBundleManifest {
  version: 1;
  generator: "SillyTavern-CharacterLibrary";
  exportedAt?: string;
  characters: ClBundleCharacter[];
  worlds: Array<{ name: string; file: string }>;
}

export interface ClMigrationIssue {
  severity: "warning" | "error";
  code: string;
  source: string;
  message: string;
}

export interface ClMigrationPreview {
  jobId: string;
  filename: string;
  archiveSha256: string;
  sourceId: string;
  counts: { characters: number; worlds: number; chats: number; galleryFiles: number };
  issues: ClMigrationIssue[];
}

export type ClMigrationStatus = "ready" | "running" | "completed" | "partial" | "failed" | "interrupted";
export interface ClMigrationItemResult {
  kind: "character" | "avatar" | "world" | "embedded_world" | "asset" | "gallery" | "regex" | "chat" | "favorite";
  source: string;
  status: "imported" | "reused" | "failed" | "preserved";
  destinationId?: string;
  message?: string;
}

export interface ClMigrationReport {
  jobId: string;
  sourceId: string;
  status: ClMigrationStatus;
  items: ClMigrationItemResult[];
  issues: ClMigrationIssue[];
  totals: { imported: number; reused: number; failed: number; preserved: number };
}

export interface ClMigrationJob extends ClMigrationPreview {
  status: ClMigrationStatus;
  progress: { phase: string; current: number; total: number };
  report: ClMigrationReport | null;
}

export interface ClMigrationOptions {
  /** v1 has no regex permission inventory; only explicit opt-in enables its scripts. */
  enableRegex?: boolean;
}

/** Types for the read-only SillyTavern gallery audit. */

import type { GalleryAssetClass, MediaMatchRule, MediaMatchStatus } from "./cl-algorithms";

export interface AuditOptions {
  /** SillyTavern user data dir (contains `characters/` and `user/images/`). */
  stDataDir: string;
  /** Destination directory for the report files. */
  outDir: string;
  /** CL `uniqueGalleryFolders` setting; auto-detected from ST settings.json when omitted. */
  uniqueGalleryFolders?: boolean;
  /** CL `includeLorebook` setting; defaults to false (matches this install). */
  includeLorebook?: boolean;
  /** Scan chat files for external media URLs and `/user/images/` refs. */
  includeChats?: boolean;
  /** Bounded concurrency for card metadata reads. Defaults to worker budget. */
  concurrency?: number;
  /** Reuse a completed stage's rows from `outDir/checkpoint.json` when present. */
  resume?: boolean;
}

export type ResolutionStatus =
  | "resolved_nonempty"
  | "resolved_empty"
  | "legacy_name_only"
  | "gid_suffix_match"
  /** Resolved folder is shared with other characters whose images may live there. */
  | "ambiguous_shared"
  /** Several folders end with this card's gallery_id; none is authoritative. */
  | "ambiguous_gid"
  | "no_folder"
  | "no_name"
  | "unreadable";

/** Internal folder resolution outcome before it is collapsed into a status. */
export type FolderResolutionKind = "resolved" | "legacy_name_only" | "gid_suffix_match" | "ambiguous_gid" | "no_folder" | "no_name";

export interface CardRecord {
  filename: string;
  characterName: string | null;
  galleryId: string | null;
  /** Folder CL would compute (sanitizeFolderName(name)_galleryId). */
  expectedFolder: string;
  /** Folder name as it exists on disk after ST's sanitize-filename pass. */
  expectedFolderOnDisk: string;
  /** Folder the audit actually resolved to, if any. */
  resolvedFolder: string | null;
  /** Folder that was rejected as contested, retained for the report. */
  contestedFolder: string | null;
  /** True when the resolved folder is the legacy plain-name folder. */
  legacy: boolean;
  status: ResolutionStatus;
  /** Populated only when status === "unreadable". */
  error?: string;
  sizeBytes: number;
  /** Embedded external media URLs. */
  embeddedUrls: string[];
  /** Lorebook-sourced URLs, only when includeLorebook is on. */
  lorebookUrls: string[];
  /** How many of this card's URLs resolved to a unique local file. */
  matchedUrls: number;
}

export interface GalleryFileRecord {
  folder: string;
  filename: string;
  extension: string;
  sizeBytes: number;
}

export interface FolderRecord {
  folder: string;
  fileCount: number;
  imageCount: number;
  totalBytes: number;
  extensions: Record<string, number>;
  /** Characters whose folder resolved here (by source PNG filename). */
  characters: string[];
}

export interface UrlMatchRecord {
  characterFile: string;
  characterName: string;
  source: "embedded" | "lorebook" | "chat";
  /** Chat filename when source === "chat". */
  sourceFile?: string;
  url: string;
  derivedName: string;
  candidateFilename: string;
  candidateFolder: string;
  status: MediaMatchStatus;
  rule: MediaMatchRule | "";
  /** Local path key the importer maps to a gallery reference. */
  localPath: string;
  /** Predicted portable reference under the documented import ordering. */
  expectedReference: string;
  assetClass: GalleryAssetClass | "";
}

export interface ChatUrlRecord {
  chatFile: string;
  characterDir: string;
  url: string;
  status: MediaMatchStatus;
  rule: MediaMatchRule | "";
  candidateFolder: string;
  candidateFilename: string;
}

export interface AuditErrorRecord {
  stage: string;
  path: string;
  message: string;
}

export interface AuditSummary {
  stDataDir: string;
  outDir: string;
  generatedAt: string;
  uniqueGalleryFolders: boolean;
  includeLorebook: boolean;
  includeChats: boolean;
  cards: {
    total: number;
    parsed: number;
    unreadable: number;
    withName: number;
    withGalleryId: number;
    duplicateNames: number;
    duplicateGalleryIds: number;
    uniqueGalleryIds: number;
  };
  folders: {
    onDisk: number;
    nonEmpty: number;
    resolvedNonEmpty: number;
    resolvedEmpty: number;
    legacyNameOnly: number;
    gidSuffixMatch: number;
    ambiguousShared: number;
    ambiguousGid: number;
    missing: number;
    noName: number;
    unreadable: number;
    orphanNonEmpty: number;
    orphanFiles: number;
    orphanBytes: number;
    sharedNonEmpty: number;
    sharedCharacters: number;
    totalFiles: number;
    totalImages: number;
    totalBytes: number;
  };
  urls: {
    charactersWithUrls: number;
    instances: number;
    unique: number;
    uniqueMatched: number;
    ambiguous: number;
    missing: number;
    byRule: Record<string, number>;
  };
  assets: {
    total: number;
    byClass: Record<string, number>;
  };
  chats: {
    scanned: number;
    withUrls: number;
    instances: number;
    matched: number;
    missing: number;
  };
  readyCharacters: number;
  errors: number;
  durationMs: number;
  stages: Array<{ name: string; durationMs: number }>;
}

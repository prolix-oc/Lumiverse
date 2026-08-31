import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, basename } from "path";
import {
  MAX_ARTIFACT_BYTES,
  MAX_AUDIO_BYTES,
  MAX_AVATAR_BYTES,
  MAX_DATABANK_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_THEME_ASSET_BYTES,
  MAX_WALLPAPER_VIDEO_BYTES,
  type MediaPolicy,
} from "../../types/media-limits";

/** Bumped whenever the archive ownership/graph contract changes. */
export const ARCHIVE_REGISTRY_VERSION = 5 as const;

export type ArchiveTableKind = "canonical" | "derived" | "operational" | "forbidden";

export type ArchiveOwnerKind = "direct" | "parent" | "predicate" | "none";

export interface ArchiveOwnerDerivationV2 {
  /** How a row is joined to the account being exported or purged. */
  kind: ArchiveOwnerKind;
  /** Column on the row containing the owner or parent key. */
  column?: string;
  /** Parent table used by a parent-derived owner. */
  parentTable?: string;
  /** Parent key column; defaults to id when omitted. */
  parentColumn?: string;
  /** Additional SQL predicate for predicate-owned rows. */
  predicate?: string;
}

export type ArchiveMissingParentPolicy = "reject" | "null_reference";

export interface ArchiveParentEdgeV2 {
  /** First column in a single-column or composite parent edge. */
  column: string;
  parentTable: string;
  /** First parent key column in a single-column or composite edge. */
  parentColumn: string;
  /** Child columns for a composite foreign key. */
  columns?: readonly string[];
  /** Parent key columns for a composite foreign key. */
  parentColumns?: readonly string[];
  /** True when the child may be present without the parent. */
  nullable: boolean;
  /** V1 behavior when a nullable parent row/table is omitted. V2 always rejects. */
  onMissing: ArchiveMissingParentPolicy;
  /** Nullable authority links are checked after the parent-first pass. */
  deferred?: boolean;
}

export type ArchiveMissingFilePolicy =
  | "abort"
  | "null_reference"
  | "skip_dependent_row"
  | "preserve_absent";

export type ArchiveFileBucket =
  | "images"
  | "thumbnails"
  | "avatars"
  | "databank"
  | "theme-assets"
  | "audio"
  | "artifacts";
/** Archive-facing name for the shared closed media validation policy. */
export type ArchiveMediaPolicy = MediaPolicy;

export interface ArchiveFileRefV2 {
  bucket: ArchiveFileBucket;
  /** Closed media policy used for magic/size validation; independent of storage bucket. */
  readonly mediaPolicy: ArchiveMediaPolicy;
  required: boolean;
  onMissing: ArchiveMissingFilePolicy;
  /** Database column that identifies the source path, when one exists. */
  pathColumn?: string;
  /** Database column containing the expected byte count, when one exists. */
  bytesColumn?: string;
  /** Immutable per-reference byte ceiling enforced during export/import. */
  readonly maxBytes: number;
  /** Whether this descriptor applies to a row; absent means always. */
  applies?: (row: Record<string, any>) => boolean;
  resolve: (row: Record<string, any>, dataDir: string) => string[];
  archivePath?: (row: Record<string, any>, absolutePath: string) => string;
}

export interface ArchiveTableSpecV2 {
  table: string;
  kind: ArchiveTableKind;
  owner: ArchiveOwnerDerivationV2;
  primaryKey: readonly string[];
  uniqueKeys: readonly (readonly string[])[];
  parentEdges: readonly ArchiveParentEdgeV2[];
  /** How a validated row merges into an account that already has the key. */
  mergePolicy: "upsert" | "insert_only" | "rebuild" | "discard";
  /** What authority-bearing state does on foreign restore. */
  authorityReset: "preserve" | "disabled" | "review_required" | "rebuild" | "discard" | "never_import";
  fileRefs: readonly ArchiveFileRefV2[];
  /** True only for a lazily created runtime table that may be absent on a healthy fresh install. */
  schemaOptional?: boolean;
  /** Explicit predicate retained for SQL collectors and purge. */
  extraWhere?: string;
  /** Optional LanceDB projection associated with this canonical/derived table. */
  lancedb?: { name: string; idColumn?: string };
}

const parent = (
  column: string,
  parentTable: string,
  nullable: boolean,
  deferred = false,
  parentColumn = "id",
  onMissing: ArchiveMissingParentPolicy = nullable ? "null_reference" : "reject",
): ArchiveParentEdgeV2 => ({
  column,
  parentTable,
  parentColumn,
  nullable,
  onMissing,
  ...(deferred ? { deferred: true } : {}),
});

const file = (
  spec: Omit<ArchiveFileRefV2, "required" | "onMissing"> & {
    required?: boolean;
    onMissing?: ArchiveMissingFilePolicy;
  },
): ArchiveFileRefV2 => Object.freeze({
  required: false,
  onMissing: "preserve_absent",
  ...spec,
});

const compositeParent = (
  columns: readonly string[],
  parentTable: string,
  parentColumns: readonly string[],
  nullable: boolean,
  deferred = false,
  onMissing: ArchiveMissingParentPolicy = nullable ? "null_reference" : "reject",
): ArchiveParentEdgeV2 => {
  if (columns.length === 0 || columns.length !== parentColumns.length) {
    throw new Error(`Archive composite parent edge is malformed for ${parentTable}`);
  }
  return {
    column: columns[0],
    parentTable,
    parentColumn: parentColumns[0],
    columns,
    parentColumns,
    nullable,
    onMissing,
    ...(deferred ? { deferred: true } : {}),
  };
};

const canonical = (
  spec: Omit<ArchiveTableSpecV2, "kind" | "mergePolicy" | "authorityReset" | "fileRefs"> & {
    fileRefs?: readonly ArchiveFileRefV2[];
    mergePolicy?: ArchiveTableSpecV2["mergePolicy"];
    authorityReset?: ArchiveTableSpecV2["authorityReset"];
  },
): ArchiveTableSpecV2 => ({
  kind: "canonical",
  mergePolicy: "upsert",
  authorityReset: "preserve",
  fileRefs: [],
  ...spec,
});

const derived = (
  table: string,
  owner: ArchiveOwnerDerivationV2,
  primaryKey: readonly string[],
  uniqueKeys: readonly (readonly string[])[] = [],
  parentEdges: readonly ArchiveParentEdgeV2[] = [],
  lancedb?: ArchiveTableSpecV2["lancedb"],
): ArchiveTableSpecV2 => ({
  table,
  kind: "derived",
  owner,
  primaryKey,
  uniqueKeys,
  parentEdges,
  mergePolicy: "rebuild",
  authorityReset: "rebuild",
  fileRefs: [],
  ...(lancedb ? { lancedb } : {}),
});

const operational = (
  table: string,
  owner: ArchiveOwnerDerivationV2,
  primaryKey: readonly string[],
  uniqueKeys: readonly (readonly string[])[] = [],
  parentEdges: readonly ArchiveParentEdgeV2[] = [],
  schemaOptional = false,
): ArchiveTableSpecV2 => ({
  table,
  kind: "operational",
  owner,
  primaryKey,
  uniqueKeys,
  parentEdges,
  mergePolicy: "discard",
  authorityReset: "discard",
  fileRefs: [],
  ...(schemaOptional ? { schemaOptional: true } : {}),
});

const forbidden = (
  table: string,
  owner: ArchiveOwnerDerivationV2 = { kind: "none" },
  primaryKey: readonly string[] = [],
  uniqueKeys: readonly (readonly string[])[] = [],
  parentEdges: readonly ArchiveParentEdgeV2[] = [],
): ArchiveTableSpecV2 => ({
  table,
  kind: "forbidden",
  owner,
  primaryKey,
  uniqueKeys,
  parentEdges,
  mergePolicy: "discard",
  authorityReset: "never_import",
  fileRefs: [],
});

const direct = (column: string): ArchiveOwnerDerivationV2 => ({ kind: "direct", column });
const via = (column: string, parentTable: string, parentColumn = "id"): ArchiveOwnerDerivationV2 => ({
  kind: "parent",
  column,
  parentTable,
  parentColumn,
});
const predicateOwner = (column: string, predicate: string): ArchiveOwnerDerivationV2 => ({
  kind: "predicate",
  column,
  predicate,
});

const imageFiles: readonly ArchiveFileRefV2[] = [
  file({
    bucket: "images",
    mediaPolicy: "image",
    maxBytes: MAX_IMAGE_BYTES,
    pathColumn: "filename",
    bytesColumn: "byte_size",
    required: true,
    onMissing: "abort",
    resolve: (row, dataDir) => row.filename ? [join(dataDir, "images", String(row.filename))] : [],
    archivePath: (_row, absolutePath) => basename(absolutePath),
  }),
  file({
    bucket: "images",
    mediaPolicy: "image_or_video",
    maxBytes: MAX_WALLPAPER_VIDEO_BYTES,
    required: false,
    onMissing: "preserve_absent",
    resolve: (row, dataDir) => row.id ? [
      join(dataDir, "images", `${String(row.id)}_h264.mp4`),
      join(dataDir, "images", `${String(row.id)}_hevc.mp4`),
    ] : [],
    archivePath: (_row, absolutePath) => basename(absolutePath),
  }),
  file({
    bucket: "thumbnails",
    mediaPolicy: "image",
    maxBytes: MAX_THUMBNAIL_BYTES,
    required: false,
    onMissing: "preserve_absent",
    resolve: (row, dataDir) => row.id ? [
      join(dataDir, "images", `${String(row.id)}_thumb_sm_v2.webp`),
      join(dataDir, "images", `${String(row.id)}_thumb_lg_v2.webp`),
      join(dataDir, "images", `${String(row.id)}_thumb_sm_v2.avif`),
      join(dataDir, "images", `${String(row.id)}_thumb_lg_v2.avif`),
      join(dataDir, "images", `${String(row.id)}_thumb_sm.webp`),
      join(dataDir, "images", `${String(row.id)}_thumb_lg.webp`),
    ].filter(existsSync) : [],
    archivePath: (_row, absolutePath) => basename(absolutePath),
  }),
];

/**
 * The sole ownership/classification source for every table in the current
 * SQLite schema. The order is readable parent-first, but import order is
 * always computed from parentEdges below rather than relying on array order.
 */
const registry: ArchiveTableSpecV2[] = [
  // Canonical account data -------------------------------------------------
  canonical({ table: "settings", owner: direct("user_id"), primaryKey: ["key", "user_id"], uniqueKeys: [["key", "user_id"]], parentEdges: [parent("user_id", "user", true)] }),
  canonical({ table: "global_addons", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({ table: "mcp_servers", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)], authorityReset: "disabled" }),
  canonical({
    table: "images",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
    // owner_* are nullable links back to rows that themselves may reference
    // images. They are represented for validation but deferred to break the
    // legitimate image/character/chat cycle during parent-first insertion.
    parentEdges: [
      parent("user_id", "user", true),
      parent("owner_character_id", "characters", true, true),
      parent("owner_chat_id", "chats", true, true),
    ],
    fileRefs: imageFiles,
  }),
  canonical({ table: "world_books", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", true)] }),
  canonical({ table: "presets", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", true)] }),
  canonical({ table: "preset_agent_configs", owner: direct("user_id"), primaryKey: ["user_id", "preset_id"], uniqueKeys: [["user_id", "preset_id"]], parentEdges: [parent("user_id", "user", false), compositeParent(["user_id", "preset_id"], "presets", ["user_id", "id"], false)], authorityReset: "review_required" }),
  canonical({ table: "preset_agent_connection_slots", owner: direct("user_id"), primaryKey: ["user_id", "preset_id", "slot_id"], uniqueKeys: [["user_id", "preset_id", "slot_id"]], parentEdges: [compositeParent(["user_id", "preset_id"], "preset_agent_configs", ["user_id", "preset_id"], false)] }),
  canonical({ table: "preset_agent_profiles", owner: direct("user_id"), primaryKey: ["user_id", "preset_id", "profile_id"], uniqueKeys: [["user_id", "preset_id", "profile_id"]], parentEdges: [compositeParent(["user_id", "preset_id"], "preset_agent_configs", ["user_id", "preset_id"], false), compositeParent(["user_id", "preset_id", "slot_id"], "preset_agent_connection_slots", ["user_id", "preset_id", "slot_id"], true)] }),
  canonical({ table: "preset_agent_slot_bindings", owner: direct("user_id"), primaryKey: ["user_id", "preset_id", "slot_id"], uniqueKeys: [["user_id", "preset_id", "slot_id"]], parentEdges: [compositeParent(["user_id", "preset_id", "slot_id"], "preset_agent_connection_slots", ["user_id", "preset_id", "slot_id"], false), compositeParent(["user_id", "connection_id"], "connection_profiles", ["user_id", "id"], true)], authorityReset: "review_required" }),

  canonical({
    table: "characters",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
    parentEdges: [parent("user_id", "user", true), parent("image_id", "images", true)],
    fileRefs: [file({
      bucket: "avatars",
      mediaPolicy: "image",
      maxBytes: MAX_AVATAR_BYTES,
      pathColumn: "avatar_path",
      required: false,
      onMissing: "null_reference",
      resolve: (row, dataDir) => row.avatar_path ? [join(dataDir, "avatars", String(row.avatar_path))] : [],
      archivePath: (_row, absolutePath) => basename(absolutePath),
    })],
  }),
  canonical({
    table: "personas",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
    parentEdges: [parent("user_id", "user", true), parent("image_id", "images", true), parent("attached_world_book_id", "world_books", true)],
    fileRefs: [file({
      bucket: "avatars",
      mediaPolicy: "image",
      maxBytes: MAX_AVATAR_BYTES,
      pathColumn: "avatar_path",
      required: false,
      onMissing: "null_reference",
      resolve: (row, dataDir) => row.avatar_path ? [join(dataDir, "avatars", String(row.avatar_path))] : [],
      archivePath: (_row, absolutePath) => basename(absolutePath),
    })],
  }),
  canonical({
    table: "chats",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
    parentEdges: [parent("user_id", "user", true), parent("character_id", "characters", true)],
  }),
  canonical({ table: "connection_profiles", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", true), parent("preset_id", "presets", true)], authorityReset: "disabled" }),
  canonical({ table: "image_gen_connections", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)], authorityReset: "disabled" }),
  canonical({ table: "tts_connections", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)], authorityReset: "disabled" }),
  canonical({ table: "stt_connections", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)], authorityReset: "disabled" }),
  canonical({ table: "character_gallery", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("image_id", "images", false), parent("character_id", "characters", false), parent("user_id", "user", false)] }),
  canonical({ table: "world_book_entries", owner: via("world_book_id", "world_books"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("world_book_id", "world_books", false)], lancedb: { name: "embeddings_world_books" } }),
  canonical({ table: "packs", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({ table: "loom_items", owner: via("pack_id", "packs"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("pack_id", "packs", false)] }),
  canonical({ table: "loom_tools", owner: via("pack_id", "packs"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("pack_id", "packs", false)] }),
  canonical({ table: "lumia_items", owner: via("pack_id", "packs"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("pack_id", "packs", false)] }),
  canonical({ table: "regex_scripts", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"], ["user_id", "script_id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({
    table: "theme_assets",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"], ["user_id", "bundle_id", "slug"]],
    parentEdges: [parent("user_id", "user", false), parent("image_id", "images", true)],
    fileRefs: [file({
      bucket: "theme-assets",
      mediaPolicy: "theme_asset",
      maxBytes: MAX_THEME_ASSET_BYTES,
      pathColumn: "file_name",
      bytesColumn: "byte_size",
      required: true,
      onMissing: "abort",
      applies: (row) => row.storage_type === "file" && Boolean(row.file_name),
      resolve: (row, dataDir) => row.storage_type === "file" && row.file_name
        ? [join(dataDir, "theme-assets", String(row.user_id), String(row.bundle_id), String(row.file_name))]
        : [],
      archivePath: (row, _absolutePath) => `${String(row.bundle_id)}/${String(row.file_name)}`,
    })],
  }),
  canonical({ table: "databanks", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({
    table: "databank_documents",
    owner: direct("user_id"),
    primaryKey: ["id"],
    uniqueKeys: [["id"]],
    parentEdges: [parent("databank_id", "databanks", false), parent("user_id", "user", false)],
    fileRefs: [file({
      bucket: "databank",
      mediaPolicy: "databank_document",
      maxBytes: MAX_DATABANK_DOCUMENT_BYTES,
      pathColumn: "file_path",
      bytesColumn: "file_size",
      required: true,
      onMissing: "abort",
      resolve: (row, dataDir) => row.file_path ? [join(dataDir, "databank", String(row.user_id), String(row.file_path))] : [],
      archivePath: (row, _absolutePath) => `${String(row.id)}__${String(row.file_path).replace(/[\\/]/g, "_")}`,
    })],
  }),
  derived("databank_chunks", direct("user_id"), ["id"], [["id"]], [parent("databank_id", "databanks", false), parent("document_id", "databank_documents", false), parent("user_id", "user", false)], { name: "embeddings" }),
  canonical({ table: "audio_files", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)], fileRefs: [file({
    bucket: "audio",
    mediaPolicy: "audio",
    maxBytes: MAX_AUDIO_BYTES,
    pathColumn: "filename",
    bytesColumn: "size_bytes",
    required: true,
    onMissing: "abort",
    resolve: (row, dataDir) => row.filename ? [join(dataDir, "audio", String(row.filename))] : [],
    archivePath: (_row, absolutePath) => basename(absolutePath),
  })] }),
  canonical({ table: "cortex_vaults", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("source_chat_id", "chats", true)] }),
  canonical({ table: "cortex_vault_entities", owner: via("vault_id", "cortex_vaults"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("vault_id", "cortex_vaults", false)] }),
  canonical({ table: "cortex_vault_relations", owner: via("vault_id", "cortex_vaults"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("vault_id", "cortex_vaults", false)] }),
  canonical({ table: "cortex_vault_chunks", owner: via("vault_id", "cortex_vaults"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("vault_id", "cortex_vaults", false)] }),
  canonical({ table: "cortex_chat_links", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("chat_id", "chats", false), parent("vault_id", "cortex_vaults", true), parent("target_chat_id", "chats", true)] }),
  canonical({ table: "memory_consolidations", owner: via("chat_id", "chats"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("chat_id", "chats", false)], lancedb: { name: "embeddings" } }),
  canonical({ table: "memory_entities", owner: via("chat_id", "chats"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("chat_id", "chats", false)] }),
  canonical({ table: "memory_relations", owner: via("chat_id", "chats"), primaryKey: ["id"], uniqueKeys: [["id"], ["source_entity_id", "target_entity_id", "relation_type"]], parentEdges: [parent("chat_id", "chats", false), parent("source_entity_id", "memory_entities", false), parent("target_entity_id", "memory_entities", false)] }),
  derived("memory_mentions", via("chat_id", "chats"), ["id"], [["id"], ["entity_id", "chunk_id"]], [parent("chat_id", "chats", false), parent("entity_id", "memory_entities", false), parent("chunk_id", "chat_chunks", false)]),
  canonical({ table: "memory_font_colors", owner: via("chat_id", "chats"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("chat_id", "chats", false), parent("entity_id", "memory_entities", true)] }),
  derived("memory_salience", via("chat_id", "chats"), ["id"], [["id"], ["chunk_id"]], [parent("chat_id", "chats", false), parent("chunk_id", "chat_chunks", false)]),
  canonical({ table: "messages", owner: via("chat_id", "chats"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("chat_id", "chats", false), parent("parent_message_id", "messages", true)] }),
  derived("message_breakdowns", via("chat_id", "chats"), ["message_id"], [["message_id"]], [parent("chat_id", "chats", false), parent("user_id", "user", true)]),
  canonical({ table: "dream_weaver_sessions", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"], ["user_id", "session_number"]], parentEdges: [parent("user_id", "user", false), parent("character_id", "characters", true), parent("connection_id", "connection_profiles", true), parent("persona_id", "personas", true)] }),
  canonical({ table: "dream_weaver_messages", owner: via("session_id", "dream_weaver_sessions"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("session_id", "dream_weaver_sessions", false)], authorityReset: "review_required" }),
  canonical({ table: "dream_weaver_saved_prompts", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({ table: "weaver_sessions", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("character_id", "characters", true), parent("connection_id", "connection_profiles", true), parent("persona_id", "personas", true)] }),
  canonical({ table: "weaver_extraction", owner: direct("user_id"), primaryKey: ["session_id"], uniqueKeys: [["session_id"]], parentEdges: [parent("user_id", "user", false), parent("session_id", "weaver_sessions", false)] }),
  canonical({ table: "weaver_interview_turns", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("session_id", "weaver_sessions", false)], authorityReset: "review_required" }),
  canonical({ table: "weaver_bible", owner: direct("user_id"), primaryKey: ["session_id"], uniqueKeys: [["session_id"]], parentEdges: [parent("user_id", "user", false), parent("session_id", "weaver_sessions", false)] }),
  canonical({ table: "weaver_fields", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("session_id", "weaver_sessions", false)] }),
  canonical({ table: "weaver_people", owner: direct("user_id"), primaryKey: ["id"], uniqueKeys: [["id"]], parentEdges: [parent("user_id", "user", false), parent("session_id", "weaver_sessions", false)] }),
  canonical({ table: "weaver_taste", owner: direct("user_id"), primaryKey: ["user_id"], uniqueKeys: [["user_id"]], parentEdges: [parent("user_id", "user", false)] }),
  canonical({
    table: "extensions",
    owner: predicateOwner("installed_by_user_id", "install_scope = 'user'"),
    primaryKey: ["id"],
    uniqueKeys: [["id"], ["identifier"]],
    parentEdges: [parent("installed_by_user_id", "user", true)],
    authorityReset: "disabled",
    extraWhere: "install_scope = 'user'",
  }),
  canonical({
    table: "agent_published_workspace_artifacts",
    owner: direct("user_id"),
    primaryKey: ["published_artifact_id"],
    uniqueKeys: [["published_artifact_id"], ["user_id", "published_artifact_id"], ["user_id", "chat_id", "message_id", "swipe_id", "blob_digest"]],
    // Publication rows deliberately carry all archive/install metadata. The
    // receipt, staging artifact, and operational blob rows are excluded from
    // archives and therefore cannot be parent edges of this canonical table.
    parentEdges: [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["chat_id", "message_id"], "messages", ["chat_id", "id"], true),
    ],
    fileRefs: [file({
      bucket: "artifacts",
      mediaPolicy: "artifact",
      maxBytes: MAX_ARTIFACT_BYTES,
      pathColumn: "storage_path",
      bytesColumn: "byte_count",
      required: true,
      onMissing: "abort",
      resolve: (row, dataDir) => row.storage_path
        ? [join(dataDir, "agent-artifacts", String(row.user_id), String(row.storage_path))]
        : [],
      archivePath: (row, _absolutePath) => `${String(row.chat_id)}/${String(row.storage_path)}`,
    })],
    authorityReset: "preserve",
  }),

  // Turn/workspace/blob state is operational and is never restored from an
  // account archive. Only the explicit chat-owned publication references above
  // are canonical user data.
  operational(
    "agent_turn_executions",
    direct("user_id"),
    ["id"],
    [["id"], ["user_id", "id"], ["user_id", "chat_id", "generation_id"], ["user_id", "commit_key"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["chat_id", "target_message_id"], "messages", ["chat_id", "id"], true),
    ],
  ),
  operational(
    "agent_turn_workspaces",
    direct("user_id"),
    ["workspace_id"],
    [["workspace_id"], ["user_id", "workspace_id"], ["user_id", "turn_id"], ["user_id", "execution_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "execution_id"], "agent_turn_executions", ["user_id", "id"], false),
    ],
  ),
  operational(
    "agent_workspace_tasks",
    via("workspace_id", "agent_turn_workspaces", "workspace_id"),
    ["task_id"],
    [["task_id"], ["user_id", "task_id"]],
    [
      compositeParent(["user_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
    ],
  ),
  operational(
    "agent_workspace_records",
    via("workspace_id", "agent_turn_workspaces", "workspace_id"),
    ["record_id"],
    [["record_id"], ["user_id", "record_id"], ["workspace_id", "kind", "digest"]],
    [
      compositeParent(["user_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "task_id"], "agent_workspace_tasks", ["user_id", "task_id"], true),
    ],
  ),
  operational(
    "agent_workspace_submissions",
    via("workspace_id", "agent_turn_workspaces", "workspace_id"),
    ["submission_id"],
    [["submission_id"], ["user_id", "submission_id"], ["task_id", "child_frame_id"]],
    [
      compositeParent(["user_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "task_id"], "agent_workspace_tasks", ["user_id", "task_id"], false),
    ],
  ),
  operational(
    "agent_artifact_blobs",
    direct("user_id"),
    ["user_id", "digest"],
    [["user_id", "digest"]],
    [parent("user_id", "user", false)],
  ),
  operational(
    "agent_artifact_blob_journal",
    direct("user_id"),
    ["journal_id"],
    [["journal_id"], ["user_id", "turn_id", "blob_digest"], ["creator_token"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "blob_digest"], "agent_artifact_blobs", ["user_id", "digest"], false),
    ],
  ),
  operational(
    "agent_workspace_artifacts",
    via("workspace_id", "agent_turn_workspaces", "workspace_id"),
    ["artifact_id"],
    [["artifact_id"], ["user_id", "artifact_id"], ["workspace_id", "blob_digest"]],
    [
      compositeParent(["user_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "blob_digest"], "agent_artifact_blobs", ["user_id", "digest"], false),
      compositeParent(["user_id", "source_task_id"], "agent_workspace_tasks", ["user_id", "task_id"], true),
    ],
  ),
  operational(
    "agent_turn_commit_receipts",
    direct("user_id"),
    ["receipt_id"],
    [["receipt_id"], ["turn_id"], ["execution_id"], ["user_id", "commit_key"], ["user_id", "idempotency_key"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "execution_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["chat_id", "message_id"], "messages", ["chat_id", "id"], true),
    ],
  ),

  operational(
    "agent_run_projections",
    direct("user_id"),
    ["user_id", "turn_id"],
    [["user_id", "turn_id"], ["user_id", "chat_id", "turn_id"], ["user_id", "chat_id", "generation_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "turn_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["chat_id", "target_message_id"], "messages", ["chat_id", "id"], true),
    ],
  ),
  operational(
    "agent_chat_event_sequences",
    direct("user_id"),
    ["user_id", "chat_id"],
    [["user_id", "chat_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
    ],
  ),
  operational(
    "agent_chat_events",
    direct("user_id"),
    ["user_id", "chat_id", "sequence"],
    [["user_id", "chat_id", "sequence"], ["user_id", "chat_id", "turn_id", "run_revision"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "turn_id"], "agent_run_projections", ["user_id", "turn_id"], false),
    ],
  ),
  operational(
    "agent_run_resync_snapshots",
    direct("user_id"),
    ["snapshot_id"],
    [["snapshot_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
    ],
  ),
  operational(
    "agent_run_resync_snapshot_members",
    direct("user_id"),
    ["snapshot_id", "ordinal"],
    [["snapshot_id", "ordinal"], ["snapshot_id", "turn_id"]],
    [
      parent("user_id", "user", false),
      parent("snapshot_id", "agent_run_resync_snapshots", false, false, "snapshot_id"),
    ],
  ),
  operational(
    "embedding_cache",
    { kind: "none" },
    ["cache_key"],
    [["cache_key"]],
    [],
    true,
  ),
  // Alpha 1 Persistent Workspace and inspection state is host-owned runtime
  // state. Archive/restore semantics remain deliberately undefined, so these
  // rows are purged with the account but never accepted as archive input.
  operational(
    "persistent_workspaces",
    direct("user_id"),
    ["workspace_id"],
    [["workspace_id"], ["user_id", "workspace_id"], ["user_id", "chat_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], true),
    ],
  ),
  operational(
    "persistent_workspace_turn_sessions",
    direct("user_id"),
    ["turn_session_id"],
    [["turn_session_id"], ["user_id", "turn_id", "attempt_id"], ["workspace_id", "turn_id", "attempt_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
    ],
  ),
  operational(
    "persistent_workspace_tasks",
    direct("user_id"),
    ["task_id"],
    [["task_id"], ["workspace_id", "task_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
      parent("turn_session_id", "persistent_workspace_turn_sessions", true, false, "turn_session_id"),
    ],
  ),
  operational(
    "persistent_workspace_records",
    direct("user_id"),
    ["record_id"],
    [["record_id"], ["workspace_id", "record_id"], ["workspace_id", "kind", "summary"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
      parent("turn_session_id", "persistent_workspace_turn_sessions", true, false, "turn_session_id"),
      parent("task_id", "persistent_workspace_tasks", true, false, "task_id"),
    ],
  ),
  operational(
    "persistent_workspace_submissions",
    direct("user_id"),
    ["submission_id"],
    [["submission_id"], ["workspace_id", "submission_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
      parent("turn_session_id", "persistent_workspace_turn_sessions", true, false, "turn_session_id"),
      parent("task_id", "persistent_workspace_tasks", false, false, "task_id"),
    ],
  ),
  operational(
    "persistent_workspace_artifacts",
    direct("user_id"),
    ["artifact_id"],
    [["artifact_id"], ["workspace_id", "artifact_id"], ["workspace_id", "blob_digest"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
      parent("turn_session_id", "persistent_workspace_turn_sessions", true, false, "turn_session_id"),
    ],
  ),
  operational(
    "persistent_workspace_publications",
    direct("user_id"),
    ["publication_id"],
    [["publication_id"], ["workspace_id", "category", "source_id", "source_revision"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "workspace_id"], "persistent_workspaces", ["user_id", "workspace_id"], false),
    ],
  ),
  operational(
    "agent_run_attempts",
    direct("user_id"),
    ["user_id", "attempt_id"],
    [["user_id", "attempt_id"], ["user_id", "run_id"], ["user_id", "host_correlation_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false),
      compositeParent(["user_id", "previous_attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], true),
      parent("target_message_id", "messages", true),
    ],
  ),
  operational(
    "agent_work_segment_recovery",
    direct("user_id"),
    ["user_id", "execution_id"],
    [["user_id", "execution_id"], ["user_id", "idempotency_key"], ["user_id", "execution_id", "attempt_id", "workspace_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "execution_id"], "agent_turn_executions", ["user_id", "id"], false),
      compositeParent(["user_id", "execution_id", "attempt_id"], "agent_run_attempts", ["user_id", "turn_id", "attempt_id"], false),
      compositeParent(["user_id", "execution_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "execution_id", "workspace_id"], false),
    ],
  ),
  operational(
    "agent_work_segments",
    direct("user_id"),
    ["segment_id"],
    [
      ["segment_id"],
      ["user_id", "execution_id", "segment_id"],
      ["user_id", "execution_id", "segment_id", "attempt_id", "workspace_id"],
      ["user_id", "execution_id", "segment_ordinal"],
      ["user_id", "execution_id", "admission_key"],
    ],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "execution_id", "attempt_id", "workspace_id"], "agent_work_segment_recovery", ["user_id", "execution_id", "attempt_id", "workspace_id"], false),
      compositeParent(["user_id", "execution_id", "attempt_id"], "agent_run_attempts", ["user_id", "turn_id", "attempt_id"], false),
      compositeParent(["user_id", "execution_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "execution_id", "workspace_id"], false),
      compositeParent(
        ["user_id", "execution_id", "source_transition_id"],
        "agent_work_segment_transitions",
        ["user_id", "execution_id", "transition_id"],
        true,
        true,
      ),
    ],
  ),
  operational(
    "agent_work_segment_transitions",
    direct("user_id"),
    ["transition_id"],
    [
      ["transition_id"],
      ["user_id", "execution_id", "transition_id"],
      ["user_id", "execution_id", "source_segment_id"],
      ["user_id", "execution_id", "idempotency_key"],
    ],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "execution_id", "attempt_id", "workspace_id"], "agent_work_segment_recovery", ["user_id", "execution_id", "attempt_id", "workspace_id"], false),
      compositeParent(["user_id", "execution_id", "source_segment_id"], "agent_work_segments", ["user_id", "execution_id", "segment_id"], false),
      compositeParent(["user_id", "execution_id", "attempt_id"], "agent_run_attempts", ["user_id", "turn_id", "attempt_id"], false),
      compositeParent(["user_id", "execution_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "execution_id", "workspace_id"], false),
    ],
  ),
  operational(
    "agent_work_segment_dispatches",
    direct("user_id"),
    ["dispatch_id"],
    [
      ["dispatch_id"],
      ["user_id", "execution_id", "dispatch_id"],
      ["user_id", "execution_id", "segment_id", "dispatch_ordinal"],
      ["user_id", "execution_id", "idempotency_key"],
      ["user_id", "execution_id", "settlement_key"],
    ],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "execution_id", "attempt_id", "workspace_id"], "agent_work_segment_recovery", ["user_id", "execution_id", "attempt_id", "workspace_id"], false),
      compositeParent(["user_id", "execution_id", "segment_id", "attempt_id", "workspace_id"], "agent_work_segments", ["user_id", "execution_id", "segment_id", "attempt_id", "workspace_id"], false),
      compositeParent(["user_id", "execution_id", "attempt_id"], "agent_run_attempts", ["user_id", "turn_id", "attempt_id"], false),
      compositeParent(["user_id", "execution_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "execution_id", "workspace_id"], false),
    ],
  ),
  operational(
    "agent_work_workspace_receipts",
    direct("user_id"),
    ["user_id", "execution_id", "operation_key"],
    [
      ["user_id", "execution_id", "operation_key"],
      ["user_id", "execution_id", "before_workspace_revision"],
      ["user_id", "execution_id", "after_workspace_revision"],
    ],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "execution_id", "workspace_id"], "agent_turn_workspaces", ["user_id", "execution_id", "workspace_id"], false),
      compositeParent(["user_id", "execution_id", "segment_id", "logical_dispatch"], "agent_work_segment_dispatches", ["user_id", "execution_id", "segment_id", "dispatch_ordinal"], false),
    ],
  ),
  operational(
    "agent_run_audit_records",
    direct("user_id"),
    ["record_id"],
    [["record_id"], ["user_id", "attempt_id", "dedupe_key"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_turn_session_entries",
    direct("user_id"),
    ["entry_id"],
    [["entry_id"], ["user_id", "attempt_id", "host_sequence", "entry_kind"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_activity_nodes",
    direct("user_id"),
    ["node_id"],
    [["node_id"], ["user_id", "attempt_id", "node_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_inspection_markers",
    direct("user_id"),
    ["marker_id"],
    [["marker_id"], ["user_id", "attempt_id", "marker_kind", "scope", "host_sequence"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_usage_evidence",
    direct("user_id"),
    ["usage_id"],
    [["usage_id"], ["user_id", "attempt_id", "usage_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_prompt_evidence",
    direct("user_id"),
    ["prompt_id"],
    [["prompt_id"], ["user_id", "attempt_id", "prompt_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_cortex_receipts",
    direct("user_id"),
    ["receipt_id"],
    [["receipt_id"], ["user_id", "attempt_id", "receipt_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_council_receipts",
    direct("user_id"),
    ["receipt_id"],
    [["receipt_id"], ["user_id", "attempt_id", "receipt_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_workspace_associations",
    direct("user_id"),
    ["association_id"],
    [["association_id"], ["user_id", "attempt_id", "association_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_attempts", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_run_source_deletions",
    direct("user_id"),
    ["user_id", "attempt_id"],
    [["user_id", "attempt_id"]],
    [parent("user_id", "user", false)],
  ),
  operational(
    "agent_run_source_deletion_workspace",
    direct("user_id"),
    ["user_id", "attempt_id", "association_id"],
    [["user_id", "attempt_id", "association_id"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "attempt_id"], "agent_run_source_deletions", ["user_id", "attempt_id"], false),
    ],
  ),
  operational(
    "agent_runtime_repair_acknowledgements",
    direct("user_id"),
    ["user_id", "preset_id", "preset_revision", "reason_code"],
    [["user_id", "preset_id", "preset_revision", "reason_code"]],
    [
      parent("user_id", "user", false),
      compositeParent(["user_id", "preset_id"], "presets", ["user_id", "id"], false),
    ],
  ),
  canonical({ table: "chat_agent_mode_overrides", owner: direct("user_id"), primaryKey: ["user_id", "chat_id"], uniqueKeys: [["user_id", "chat_id"]], parentEdges: [parent("user_id", "user", false), compositeParent(["user_id", "chat_id"], "chats", ["user_id", "id"], false)], authorityReset: "review_required" }),

  // Derived stores and projections ----------------------------------------
  operational("agent_activity_runs", direct("user_id"), ["id"], [["user_id", "chat_id", "generation_id"]], [parent("user_id", "user", false), parent("chat_id", "chats", false)]),

  derived("chat_chunks", via("chat_id", "chats"), ["id"], [["id"]], [parent("chat_id", "chats", false)], { name: "embeddings" }),
  derived("chat_memory_cache", direct("user_id"), ["id"], [["id"], ["chat_id", "settings_key"]], [parent("user_id", "user", false), parent("chat_id", "chats", false)]),
  derived("query_vector_cache", via("chat_id", "chats"), ["id"], [["id"], ["chat_id", "query_hash"]], [parent("chat_id", "chats", false)]),
  forbidden("characters_fts"),
  forbidden("characters_fts_config", { kind: "none" }, ["k"], [["k"]]),
  forbidden("characters_fts_data", { kind: "none" }, ["id"]),
  forbidden("characters_fts_docsize", { kind: "none" }, ["id"]),
  forbidden("characters_fts_idx", { kind: "none" }, ["segid", "term"], [["segid", "term"]]),
  forbidden("world_book_entries_fts"),
  forbidden("world_book_entries_fts_config", { kind: "none" }, ["k"], [["k"]]),
  forbidden("world_book_entries_fts_data", { kind: "none" }, ["id"]),
  forbidden("world_book_entries_fts_docsize", { kind: "none" }, ["id"]),
  forbidden("world_book_entries_fts_idx", { kind: "none" }, ["segid", "term"], [["segid", "term"]]),

  // Runtime/session state; never restored from an account archive ----------
  operational("multiplayer_rooms", direct("host_user_id"), ["id"], [["id"], ["chat_id"]], [parent("chat_id", "chats", false), parent("host_user_id", "user", false)]),
  operational("multiplayer_participants", via("room_id", "multiplayer_rooms"), ["id"], [["id"], ["room_id", "identity_kind", "identity_ref"]], [parent("room_id", "multiplayer_rooms", false)]),
  operational("multiplayer_bans", via("room_id", "multiplayer_rooms"), ["id"], [["id"], ["room_id", "identity_kind", "identity_ref"]], [parent("room_id", "multiplayer_rooms", false)]),
  operational(
    "user_data_imports",
    direct("user_id"),
    ["job_id"],
    [["job_id"]],
    [parent("user_id", "user", false)],
  ),
  operational(
    "user_data_import_files",
    via("job_id", "user_data_imports", "job_id"),
    ["id"],
    [["id"], ["job_id", "archive_path"], ["job_id", "install_token"]],
    [parent("job_id", "user_data_imports", false, false, "job_id")],
  ),
  operational(
    "user_data_import_receipts",
    direct("user_id"),
    ["receipt_id"],
    [["receipt_id"], ["job_id"], ["user_id", "idempotency_key"]],
    [
      parent("job_id", "user_data_imports", false, false, "job_id"),
      parent("user_id", "user", false),
    ],
  ),

  // Auth, credentials, grants, import controls, and system-owned tables ----
  forbidden("_migrations", { kind: "none" }, ["id"], [["name"]]),
  forbidden("account", direct("userId"), ["id"], [["id"]], [parent("userId", "user", false, false, "id")]),
  forbidden("extension_grants", via("extension_id", "extensions"), ["id"], [["id"], ["extension_id", "permission"]], [parent("extension_id", "extensions", false)]),
  operational("import_consumed_tickets", direct("user_id"), ["archive_id"], [["archive_id"]], [parent("user_id", "user", true)]),
  forbidden("lumihub_link", direct("user_id"), ["id"], [["id"]], [parent("user_id", "user", true)]),
  forbidden("illarin_instance", direct("user_id"), ["id"], [["id"], ["user_id"]], [parent("user_id", "user", false)]),
  forbidden("illarin_delivery_receipt", direct("user_id"), ["user_id", "delivery_id"], [["user_id", "delivery_id"]], [parent("user_id", "user", false)]),
  forbidden("push_subscriptions", direct("user_id"), ["id"], [["id"], ["user_id", "endpoint"]], [parent("user_id", "user", false)]),
  forbidden("secrets", direct("user_id"), ["key", "user_id"], [["key", "user_id"]], [parent("user_id", "user", true)]),
  forbidden("session", direct("userId"), ["id"], [["id"], ["token"]], [parent("userId", "user", false)]),
  forbidden("sso_providers", { kind: "none" }, ["id"], [["id"], ["slug"]]),
  forbidden("stream_deck_tokens", direct("user_id"), ["id"], [["id"], ["token_hash"]], [parent("user_id", "user", false)]),
  forbidden("tokenizer_configs", { kind: "none" }, ["id"], [["id"]]),
  forbidden("tokenizer_model_patterns", { kind: "none" }, ["id"], [["id"]], [parent("tokenizer_id", "tokenizer_configs", false)]),
  forbidden("user", direct("id"), ["id"], [["id"], ["email"], ["username"]]),
  forbidden("verification", { kind: "none" }, ["id"], [["id"]]),
];

export const ARCHIVE_TABLE_REGISTRY: readonly ArchiveTableSpecV2[] = Object.freeze(registry);
export const ARCHIVE_CANONICAL_TABLES: readonly ArchiveTableSpecV2[] = Object.freeze(
  registry.filter((spec) => spec.kind === "canonical"),
);

const byTable = new Map(registry.map((spec) => [spec.table, spec] as const));

// These tables were removed from the archive contract by AR-008. Existing
// databases may retain their empty/legacy schemas; they are no longer archive
// input and must not prevent the surviving registry from reconciling.
const ARCHIVE_RETIRED_TABLES = new Set([
  "edit_and_send_requests",
  "generation_outbox",
  "image_processing_queue",
]);

export function getArchiveTableSpec(table: string): ArchiveTableSpecV2 | undefined {
  return byTable.get(table);
}

export interface ArchiveOwnerPredicateV2 {
  sql: string;
  params: string[];
}

function quoteArchiveIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe archive SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Build one correlated owner predicate from the registry's recursive graph. */
export function buildArchiveOwnerPredicate(
  spec: ArchiveTableSpecV2,
  userId: string,
  tableAlias: string,
  visiting: Set<string> = new Set(),
): ArchiveOwnerPredicateV2 | null {
  if (visiting.has(spec.table)) {
    throw new Error(`Archive owner cycle at ${spec.table}`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(spec.table);

  switch (spec.owner.kind) {
    case "none":
      return null;
    case "direct": {
      if (!spec.owner.column) throw new Error(`Archive owner column missing for ${spec.table}`);
      const extraWhere = spec.extraWhere ? ` AND (${spec.extraWhere})` : "";
      return {
        sql: `${tableAlias}.${quoteArchiveIdentifier(spec.owner.column)} = ?${extraWhere}`,
        params: [userId],
      };
    }
    case "predicate": {
      if (!spec.owner.column) throw new Error(`Archive owner column missing for ${spec.table}`);
      const predicates = [spec.owner.predicate, spec.extraWhere]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .filter((value, index, values) => values.indexOf(value) === index);
      return {
        sql: `${tableAlias}.${quoteArchiveIdentifier(spec.owner.column)} = ?${predicates.map((value) => ` AND (${value})`).join("")}`,
        params: [userId],
      };
    }
    case "parent": {
      if (!spec.owner.column || !spec.owner.parentTable) {
        throw new Error(`Archive parent owner is incomplete for ${spec.table}`);
      }
      const parentSpec = getArchiveTableSpec(spec.owner.parentTable);
      if (!parentSpec) {
        throw new Error(`Archive owner parent is not registered: ${spec.owner.parentTable}`);
      }
      const parentAlias = quoteArchiveIdentifier(parentSpec.table);
      const parentOwner = buildArchiveOwnerPredicate(parentSpec, userId, parentAlias, nextVisiting);
      if (!parentOwner) return null;
      const extraWhere = spec.extraWhere ? ` AND (${spec.extraWhere})` : "";
      return {
        sql: `EXISTS (SELECT 1 FROM ${quoteArchiveIdentifier(parentSpec.table)} AS ${parentAlias} WHERE ${parentAlias}.${quoteArchiveIdentifier(spec.owner.parentColumn || "id")} = ${tableAlias}.${quoteArchiveIdentifier(spec.owner.column)} AND ${parentOwner.sql})${extraWhere}`,
        params: parentOwner.params,
      };
    }
  }
}
const ARCHIVE_MEDIA_POLICIES: ReadonlySet<ArchiveMediaPolicy> = new Set([
  "image",
  "image_or_video",
  "audio",
  "notification_audio",
  "databank_document",
  "theme_asset",
  "artifact",
]);


function assertRegistryShape(): void {
  const seen = new Set<string>();
  for (const spec of registry) {
    if (seen.has(spec.table)) throw new Error(`Archive registry duplicate table: ${spec.table}`);
    seen.add(spec.table);
    if (!spec.table || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.table)) {
      throw new Error(`Archive registry unsafe table name: ${spec.table}`);
    }
    for (const edge of spec.parentEdges) {
      if (!byTable.has(edge.parentTable)) {
        throw new Error(`Archive registry ${spec.table} references missing parent ${edge.parentTable}`);
      }
      const childColumns = edge.columns ?? [edge.column];
      const parentColumns = edge.parentColumns ?? [edge.parentColumn];
      if (
        childColumns.length !== parentColumns.length
        || childColumns.length === 0
        || childColumns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
        || parentColumns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
        || (edge.onMissing !== "reject" && edge.onMissing !== "null_reference")
        || (edge.onMissing === "null_reference" && !edge.nullable)
      ) {
        throw new Error(`Archive registry malformed parent edge: ${spec.table}.${edge.column} -> ${edge.parentTable}`);
      }
    }
    if (spec.kind === "canonical") {
      if (!spec.owner || spec.primaryKey.length === 0 || !spec.mergePolicy || !spec.authorityReset) {
        throw new Error(`Archive canonical spec is incomplete: ${spec.table}`);
      }
      for (const ref of spec.fileRefs) {
        if (!ARCHIVE_MEDIA_POLICIES.has(ref.mediaPolicy)) {
          throw new Error(`Archive file reference has invalid mediaPolicy: ${spec.table}`);
        }
        if (!Number.isSafeInteger(ref.maxBytes) || ref.maxBytes <= 0) {
          throw new Error(`Archive file reference has invalid maxBytes: ${spec.table}`);
        }
        if (ref.required && ref.onMissing !== "abort") {
          throw new Error(`Required archive file must abort when absent: ${spec.table}`);

        }
        if (!ref.required && ref.onMissing === "abort") {
          throw new Error(`Optional archive file cannot use abort policy: ${spec.table}`);
        }
      }
    }
  }

}

function topologicalOrder(specs: readonly ArchiveTableSpecV2[], canonicalOnly: boolean): string[] {
  const selected = specs.filter((spec) => !canonicalOnly || spec.kind === "canonical");
  const selectedNames = new Set(selected.map((spec) => spec.table));
  const position = new Map(selected.map((spec, index) => [spec.table, index] as const));
  const dependencies = new Map<string, Set<string>>(
    selected.map((spec) => [spec.table, new Set<string>()] as const),
  );
  for (const spec of selected) {
    for (const edge of spec.parentEdges) {
      if (edge.deferred || edge.parentTable === spec.table || !selectedNames.has(edge.parentTable)) continue;
      dependencies.get(spec.table)!.add(edge.parentTable);
    }
  }
  const result: string[] = [];
  const remaining = new Set(selected.map((spec) => spec.table));
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) => [...dependencies.get(table)!].every((parentTable) => !remaining.has(parentTable)))
      .sort((a, b) => position.get(a)! - position.get(b)! || a.localeCompare(b));
    if (ready.length === 0) {
      throw new Error(`Archive registry contains a parent cycle: ${[...remaining].sort().join(", ")}`);
    }
    for (const table of ready) {
      remaining.delete(table);
      result.push(table);
    }
  }
  return result;
}

assertRegistryShape();
const canonicalImportOrder = Object.freeze(topologicalOrder(registry, true));
const archiveDeleteOrder = Object.freeze(topologicalOrder(registry, false).reverse());

export function getCanonicalImportOrder(): readonly string[] {
  return canonicalImportOrder;
}

/** Internal consumers such as purge need children before account parents. */
export function getArchiveDeleteOrder(): readonly string[] {
  return archiveDeleteOrder;
}

/**
 * sqlite_* tables are deliberately ignored here: they are engine internals,
 * never archive input, and are not user data. FTS virtual tables and shadows
 * are explicit forbidden specs above.
 */
export function assertArchiveRegistryCoverage(db: Database): void {
  assertRegistryShape();
  const actual = new Set(
    (db.query("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
  );
  const unclassified = [...actual].filter((name) => (
      !byTable.has(name)
      && !ARCHIVE_RETIRED_TABLES.has(name)
      && !name.startsWith("sqlite_")
    ));
  const absent = registry
    .filter((spec) => !spec.schemaOptional)
    .map((spec) => spec.table)
    .filter((table) => !actual.has(table));
  if (unclassified.length || absent.length) {
    const details = [
      ...(unclassified.length ? [`unclassified=${unclassified.sort().join(",")}`] : []),
      ...(absent.length ? [`missing=${absent.sort().join(",")}`] : []),
    ];
    throw new Error(`Archive registry/schema mismatch: ${details.join("; ")}`);
  }
  for (const spec of registry) {
    if (!actual.has(spec.table)) continue;
    const columns = new Set(
      (db.query(`PRAGMA table_info("${spec.table}")`).all() as { name: string }[]).map((row) => row.name),
    );
    for (const key of spec.primaryKey) {
      if (!columns.has(key)) throw new Error(`Archive registry ${spec.table} primary key column is missing: ${key}`);
    }
    for (const key of spec.uniqueKeys.flat()) {
      if (!columns.has(key)) throw new Error(`Archive registry ${spec.table} unique key column is missing: ${key}`);
    }
    if (spec.owner.kind !== "none" && spec.owner.column && !columns.has(spec.owner.column)) {
      throw new Error(`Archive registry ${spec.table} owner column is missing: ${spec.owner.column}`);
    }
    for (const edge of spec.parentEdges) {
      for (const column of edge.columns ?? [edge.column]) {
        if (!columns.has(column)) throw new Error(`Archive registry ${spec.table} parent column is missing: ${column}`);
      }
      const parentColumns = new Set(
        (db.query(`PRAGMA table_info("${edge.parentTable}")`).all() as { name: string }[]).map((row) => row.name),
      );
      for (const column of edge.parentColumns ?? [edge.parentColumn]) {
        if (!parentColumns.has(column)) {
          throw new Error(`Archive registry ${spec.table} parent key column is missing: ${edge.parentTable}.${column}`);
        }
      }
    }
  }
}

/**
 * Credential-bearing key names. Secrets live in the encrypted `secrets` table,
 * but the `settings` table accepts arbitrary keys, so any row named like a
 * credential is excluded from export and rejected on import. Each entry mirrors
 * a real producer:
 *   connections.service.connectionSecretKey                  connection_<id>_api_key
 *   image-gen-connections.service.imageGenConnectionSecretKey image_gen_connection_<id>_api_key
 *   tts-connections.service.ttsConnectionSecretKey            tts_connection_<id>_api_key
 *   stt-connections.service.sttConnectionSecretKey            stt_connection_<id>_api_key
 *   mcp-servers.service.mcpServerHeadersKey / mcpServerEnvKey mcp_server_<id>_headers | _env
 *   embeddings.service EMBEDDING_SECRET_KEY (+ per-provider)  embedding_api_key[_<provider>]
 *   web-search-settings.service.WEB_SEARCH_API_KEY_SECRET     web_search_api_key
 *   huggingface.service.HF_API_TOKEN_SECRET                   huggingface_api_token
 *   vector-store-config.service                               vector_store_secret_<target>
 *   connections.service.resolvePollinationsAppKey (settings)  pollinations_app_key
 *   dropbox.routes / google-drive.routes OAuth material       dropbox_* | google_drive_*
 */
export const SECRET_SETTING_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^connection_.+_api_key$/,
  /^image_gen_connection_.+_api_key$/,
  /^tts_connection_.+_api_key$/,
  /^stt_connection_.+_api_key$/,
  /^mcp_server_.+_(?:headers|env)$/,
  /^embedding_api_key(?:_.+)?$/,
  /^web_search_(?:exa_|tavily_)?api_key$/,
  /^huggingface_api_token$/,
  /^pollinations_app_key$/,
  /^vector_store_secret_.+$/,
  /^dropbox_(?:app_key|refresh_token|access_token|access_token_expiry)$/,
  /^google_drive_(?:client_id|client_secret|refresh_token|access_token|access_token_expiry)$/,
]);

/**
 * Single classifier for credential-bearing setting keys. Export skips these
 * rows and import rejects them, so both sides must ask the same question.
 */
export function isSecretSettingKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  for (const pattern of SECRET_SETTING_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

const archiveVectorTables = Object.freeze([
  ...new Set(registry.flatMap((spec) => spec.lancedb ? [spec.lancedb.name] : [])),
]);

export function getArchiveVectorTables(): readonly string[] {
  return archiveVectorTables;
}

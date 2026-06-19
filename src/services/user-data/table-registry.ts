// Declarative description of every user-owned table that participates in
// the export / import pipeline. Columns are discovered at runtime via
// PRAGMA table_info(...) so the registry survives schema additions without
// edits — only structural shape (ownership, parent FKs, file refs) lives here.
//
// Order matters for import: parents come before children so foreign-key
// references resolve cleanly under "INSERT OR IGNORE" merge semantics.

export type OwnershipKind =
  | "user"           // row.user_id = importerId
  | "via_chat"       // row.chat_id ∈ user's chats
  | "via_pack"       // row.pack_id ∈ user's packs
  | "via_vault"      // row.vault_id ∈ user's vaults
  | "via_session"    // row.session_id ∈ user's dream_weaver_sessions
  | "via_document"   // row.document_id ∈ user's databank_documents
  | "via_entity"     // row.entity_id ∈ entities of user's chats
  | "via_chunk"      // row.chunk_id ∈ chunks of user's chats
  | "via_installer"; // extensions.installed_by_user_id = userId AND install_scope='user'

export interface FileRefSpec {
  /** Logical bucket inside files/ in the archive. */
  bucket: "images" | "thumbnails" | "avatars" | "databank" | "theme-assets";
  /**
   * Build absolute on-disk paths for a row. The export collector calls this and
   * adds whatever paths exist to the archive. Multiple paths per row are
   * supported (e.g. an image + its two thumbnails).
   */
  resolve: (row: Record<string, any>, dataDir: string) => string[];
  /**
   * Optional: the archive-relative path under files/{bucket}/. If omitted,
   * basename(absolutePath) is used.
   */
  archivePath?: (row: Record<string, any>, absolutePath: string) => string;
}

export interface TableSpec {
  /** SQL table name. */
  table: string;
  /** How a row's ownership is determined. */
  ownership: OwnershipKind;
  /**
   * Optional: extra WHERE predicate appended to the export SELECT.
   * Used by extensions (install_scope filter) and packs (is_custom=1).
   */
  extraWhere?: string;
  /**
   * Optional: columns to NULL out / zero out at export time. Used to scrub
   * `has_api_key`, owner_extension_identifier on orphaned images, etc.
   */
  scrubColumns?: Record<string, any>;
  /**
   * Files associated with each row. The collector calls these and bundles
   * the resulting paths into the archive's files/ tree.
   */
  fileRefs?: FileRefSpec[];
  /**
   * Optional: this table itself participates in LanceDB vector storage
   * (the per-row ID is the LanceDB primary key). Used to filter vector
   * exports to the user's rows.
   */
  lancedb?: {
    /** LanceDB table name (matches lancedb/{name}.ndjson in the archive). */
    name: string;
    /** Column in this table that matches LanceDB row IDs. Defaults to "id". */
    idColumn?: string;
  };
}

// ---------------------------------------------------------------------------
// Topologically ordered list of user-owned tables.
// Parents first; children later. Same order is used for export and import.
// ---------------------------------------------------------------------------

export const TABLE_REGISTRY: readonly TableSpec[] = [
  // 1) Standalone catalogs / settings -----------------------------------
  { table: "settings", ownership: "user" },
  { table: "global_addons", ownership: "user" },
  { table: "mcp_servers", ownership: "user" },

  // 2) Images first — referenced by characters, personas, gallery, themes
  {
    table: "images",
    ownership: "user",
    fileRefs: [
      {
        bucket: "images",
        resolve: (row, dataDir) =>
          row.filename ? [`${dataDir}/images/${row.filename}`] : [],
      },
      {
        bucket: "thumbnails",
        resolve: (row, dataDir) =>
          row.id
            ? [
                `${dataDir}/images/${row.id}_thumb_sm_v2.webp`,
                `${dataDir}/images/${row.id}_thumb_lg_v2.webp`,
              ]
            : [],
      },
    ],
  },

  // 3) Connections — keys are scrubbed; secrets table never exported
  {
    table: "connection_profiles",
    ownership: "user",
    scrubColumns: { has_api_key: 0 },
  },
  {
    table: "image_gen_connections",
    ownership: "user",
    scrubColumns: { has_api_key: 0 },
  },
  {
    table: "tts_connections",
    ownership: "user",
    scrubColumns: { has_api_key: 0 },
  },
  {
    table: "stt_connections",
    ownership: "user",
    scrubColumns: { has_api_key: 0 },
  },

  // 4) Presets reference connection_profiles via metadata only
  { table: "presets", ownership: "user" },

  // 5) Personas reference images, world_books (FK SET NULL)
  {
    table: "personas",
    ownership: "user",
    fileRefs: [
      {
        bucket: "avatars",
        resolve: (row, dataDir) =>
          row.avatar_path ? [`${dataDir}/avatars/${row.avatar_path}`] : [],
      },
    ],
  },

  // 6) Characters reference images
  {
    table: "characters",
    ownership: "user",
    fileRefs: [
      {
        bucket: "avatars",
        resolve: (row, dataDir) =>
          row.avatar_path ? [`${dataDir}/avatars/${row.avatar_path}`] : [],
      },
    ],
  },

  // 7) Character gallery (junction)
  { table: "character_gallery", ownership: "user" },

  // 8) World books and entries
  { table: "world_books", ownership: "user" },
  // entries inherit ownership via world_book_id → world_books.user_id, but
  // because world_book_entries lacks user_id, treat it as via_chat with a
  // manual join in the collector. We model it explicitly below as a
  // join-based child.
  // (handled by `via_world_book` synthetic ownership — added inline)

  // 9) Packs (everything the user owns) and their nested content.
  // Both is_custom=1 (user-authored) and is_custom=0 (downloaded from
  // LumiHub / a registry) belong to the user via packs.user_id, and the
  // loom_items / loom_tools / lumia_items children FK to packs.id — so
  // skipping non-custom packs would orphan all of them and break the
  // Council tab on import.
  { table: "packs", ownership: "user" },
  { table: "loom_items", ownership: "via_pack" },
  { table: "loom_tools", ownership: "via_pack" },
  { table: "lumia_items", ownership: "via_pack" },

  // 10) Regex scripts
  { table: "regex_scripts", ownership: "user" },

  // 11) Theme assets (separate file tree on disk)
  {
    table: "theme_assets",
    ownership: "user",
    fileRefs: [
      {
        bucket: "theme-assets",
        resolve: (row, dataDir) => {
          if (row.storage_type !== "file" || !row.file_name) return [];
          return [
            `${dataDir}/theme-assets/${row.user_id}/${row.bundle_id}/${row.file_name}`,
          ];
        },
        archivePath: (row, _abs) => `${row.bundle_id}/${row.file_name}`,
      },
    ],
  },

  // 12) Databanks → documents → chunks (file copies in databank/{userId}/)
  { table: "databanks", ownership: "user" },
  {
    table: "databank_documents",
    ownership: "user",
    fileRefs: [
      {
        bucket: "databank",
        resolve: (row, dataDir) =>
          row.file_path ? [`${dataDir}/databank/${row.user_id}/${row.file_path}`] : [],
        archivePath: (row, _abs) => `${row.id}__${row.file_path.replace(/[\\/]/g, "_")}`,
      },
    ],
  },
  { table: "databank_chunks", ownership: "user" },

  // 13) Chats and message tree
  { table: "chats", ownership: "user" },
  // messages: ownership inferred via chat_id (no user_id column)
  // We handle messages, chat_chunks, chat_memory_cache below as via_chat.

  // 14) Memory cortex (mostly via_chat, vaults are direct)
  // Order: entities → mentions → relations → consolidations → font_colors → salience
  // Vaults: vaults → vault_entities → vault_relations → vault_chunks → chat_links

  // 15) Dream Weaver — legacy, dormant tables (the feature was replaced by the
  // Weaver). Kept so any existing user's old rows still export and purge cleanly.
  { table: "dream_weaver_sessions", ownership: "user" },
  { table: "dream_weaver_messages", ownership: "via_session" },
  { table: "dream_weaver_saved_prompts", ownership: "user" },

  // 16) Weaver — sessions first, then their children (FK session_id), taste last.
  { table: "weaver_sessions", ownership: "user" },
  { table: "weaver_extraction", ownership: "user" },
  { table: "weaver_interview_turns", ownership: "user" },
  { table: "weaver_bible", ownership: "user" },
  { table: "weaver_fields", ownership: "user" },
  { table: "weaver_taste", ownership: "user" },

  // 17) Extensions (only user-installed)
  {
    table: "extensions",
    ownership: "via_installer",
    extraWhere: "install_scope = 'user'",
  },
] as const;

// ---------------------------------------------------------------------------
// Auxiliary tables that don't fit the simple ownership model and are handled
// explicitly by the export/import services. Listed here for documentation and
// so the import service can validate against them.
// ---------------------------------------------------------------------------

/** Tables exported via a chat-id join. */
export const VIA_CHAT_TABLES = [
  "messages",
  "message_breakdowns",
  "chat_chunks",
  "chat_memory_cache",
  "memory_entities",
  "memory_relations",
  "memory_consolidations",
  "memory_font_colors",
  "memory_salience",
  "memory_mentions", // also references chunk_id
] as const;

/** Tables exported via a world_book_id join. */
export const VIA_WORLD_BOOK_TABLES = ["world_book_entries"] as const;

/** Tables exported via a vault_id join. */
export const VIA_VAULT_TABLES = [
  "cortex_vault_entities",
  "cortex_vault_relations",
  "cortex_vault_chunks",
] as const;

/** Vaults table — owned directly, but children listed above. */
export const VAULT_TABLES = ["cortex_vaults", "cortex_chat_links"] as const;

/**
 * Final import order. Combines the registry, the via_chat tables, the
 * via_world_book tables, and the vault tables. This is the order the
 * import service uses when applying rows.
 *
 * Strict ordering rule: every row's FK targets must already exist when it
 * is inserted. INSERT OR IGNORE handles re-imports gracefully.
 */
export const IMPORT_ORDER: readonly string[] = [
  // Phase 1: settings + standalone catalogs
  "settings",
  "global_addons",
  "mcp_servers",

  // Phase 2: images (referenced by characters/personas/gallery/theme_assets)
  "images",

  // Phase 3: presets (connection_profiles references presets.id, must come first)
  "presets",

  // Phase 4: connections
  "connection_profiles",
  "image_gen_connections",
  "tts_connections",
  "stt_connections",

  // Phase 4: world books (referenced by personas)
  "world_books",
  "world_book_entries",

  // Phase 5: personas + characters + gallery
  "personas",
  "characters",
  "character_gallery",

  // Phase 6: packs + pack content
  "packs",
  "loom_items",
  "loom_tools",
  "lumia_items",

  // Phase 7: regex scripts
  "regex_scripts",

  // Phase 8: theme assets
  "theme_assets",

  // Phase 9: databanks → documents → chunks
  "databanks",
  "databank_documents",
  "databank_chunks",

  // Phase 10: chats and message tree
  "chats",
  "messages",
  "message_breakdowns",
  "chat_chunks",
  "chat_memory_cache",

  // Phase 11: memory cortex
  "memory_entities",
  "memory_mentions",
  "memory_relations",
  "memory_consolidations",
  "memory_font_colors",
  "memory_salience",

  // Phase 12: cortex vaults
  "cortex_vaults",
  "cortex_vault_entities",
  "cortex_vault_relations",
  "cortex_vault_chunks",
  "cortex_chat_links",

  // Phase 13: dream weaver (legacy, dormant)
  "dream_weaver_sessions",
  "dream_weaver_messages",
  "dream_weaver_saved_prompts",

  // Phase 13b: weaver (sessions before their children)
  "weaver_sessions",
  "weaver_extraction",
  "weaver_interview_turns",
  "weaver_bible",
  "weaver_fields",
  "weaver_taste",

  // Phase 14: extensions (user-installed)
  "extensions",
] as const;

/** Tables explicitly EXCLUDED from export/import. */
export const EXCLUDED_TABLES = new Set<string>([
  // Encrypted secrets — never exported, never imported
  "secrets",
  // System auth tables
  "user",
  "account",
  "session",
  "verification",
  // Device-specific
  "push_subscriptions",
  // System / built-in
  "_migrations",
  "tokenizer_configs",
  "tokenizer_model_patterns",
  "lumihub_link",
  "extension_grants",
  // Runtime caches — regenerated on demand
  "query_vector_cache",
  "embedding_cache",
  // FTS shadow tables (auto-maintained by triggers)
  "characters_fts",
  "characters_fts_data",
  "characters_fts_idx",
  "characters_fts_docsize",
  "characters_fts_config",
  "world_book_entries_fts",
  "world_book_entries_fts_data",
  "world_book_entries_fts_idx",
  "world_book_entries_fts_docsize",
  "world_book_entries_fts_config",
]);

/** Settings keys whose secrets must not be confused for data. */
export const SECRET_SETTING_KEY_PATTERNS: readonly RegExp[] = [
  /^connection_.+_api_key$/,
  /^image_gen_connection_.+_api_key$/,
  /^tts_connection_.+_api_key$/,
  /^stt_connection_.+_api_key$/,
  /^embedding_api_key_/,
  /^web_search_api_key$/,
];

/** LanceDB tables that participate in optional vector export. */
export const LANCEDB_TABLES: readonly string[] = [
  "chat_chunks",
  "databank_chunks",
  "world_book_entries",
  "memory_consolidations",
];

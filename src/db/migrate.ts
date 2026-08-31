import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { healCorruptDatabase } from "./maintenance";

/**
 * All migration files that are baked into baseline.sql.
 * The baseline replaces replaying these individually on fresh databases.
 */
const BASELINE_MIGRATIONS: readonly string[] = [
  "001_settings.sql",
  "002_characters.sql",
  "003_chats.sql",
  "004_personas.sql",
  "005_world_books.sql",
  "006_secrets.sql",
  "007_presets.sql",
  "008_connection_profiles.sql",
  "009_preset_prompts.sql",
  "010_persona_world_book.sql",
  "011_images.sql",
  "012_world_book_entry_fields.sql",
  "013_connection_api_keys.sql",
  "014_extensions.sql",
  "015_auth_tables.sql",
  "016_add_user_id.sql",
  "017_packs.sql",
  "018_character_gallery.sql",
  "019_world_book_entry_vectorized.sql",
  "020_extension_ownership.sql",
  "021_performance_indexes.sql",
  "022_tokenizers.sql",
  "023_breakdown_user_scope.sql",
  "024_persona_title_folder.sql",
  "025_chat_chunks.sql",
  "026_query_cache_unique_constraint.sql",
  "027_fix_settings_secrets_pk.sql",
  "028_preset_engine.sql",
  "029_extension_branches.sql",
  "030_swipe_dates.sql",
  "031_regex_scripts.sql",
  "032_character_fts.sql",
  "033_world_book_vector_index_status.sql",
  "034_lumihub_link.sql",
  "035_push_subscriptions.sql",
  "036_regex_script_folder.sql",
  "037_image_gen_connections.sql",
  "038_memory_entities.sql",
  "039_memory_mentions.sql",
  "040_memory_relations.sql",
  "041_memory_salience.sql",
  "042_memory_consolidations.sql",
  "043_chat_chunks_cortex.sql",
  "044_chat_chunks_message_range.sql",
  "045_font_color_map.sql",
  "046_cortex_edge_enhancements.sql",
  "047_cortex_entity_enhancements.sql",
  "048_chat_memory_cache.sql",
  "048_dream_weaver_sessions.sql",
  "049_regex_script_id.sql",
  "050_cortex_vaults.sql",
  "051_tts_connections.sql",
  "052_cortex_perf_indexes.sql",
  "053_mcp_servers.sql",
  "054_normalize_usernames.sql",
  "055_databank.sql",
  "056_global_addons.sql",
  "056_saved_prompts.sql",
  "057_regex_script_pack_id.sql",
  "058_persona_pronouns.sql",
  "059_regex_script_preset_id.sql",
  "060_world_book_entries_fts.sql",
  "061_cortex_vault_chunks.sql",
  "062_fts_trigram_tokenizer.sql",
  "063_lumia_gender_default_any.sql",
  "064_theme_assets.sql",
  "065_regex_script_character_id.sql",
  "066_chat_chunks_cortex_warmup.sql",
  "066_dream_weaver_messages.sql",
  "066_spindle_image_ownership.sql",
  "068_migrate_dream_weaver_from_1_0.sql",
  "069_stt_connections.sql",
  "070_cortex_user_edits.sql",
  "071_import_consumed_tickets.sql",
  "072_world_books_folder.sql",
  "073_cortex_relation_user_edits.sql",
  "074_audio_files.sql",
  "075_persona_is_narrator.sql",
  "076_cortex_salience_peak.sql",
  "077_regex_target_array.sql",
  "078_chats_character_id_nullable.sql",
  "079_weaver_studio_tables.sql",
  "080_weaver_interview_lifecycle.sql",
  "081_weaver_bible_review.sql",
  "082_weaver_dynamic_lane.sql",
  "083_weaver_session_build_type.sql",
  "084_weaver_cast.sql",
  "085_weaver_people_rename.sql",
  "086_weaver_narration_mode.sql",
  "087_weaver_persona_plan.sql",
  "088_lumihub_share_usage_stats.sql",
  "088_multiplayer.sql",
  "089_sso_providers.sql",
  "090_sso_account_indexes.sql",
  "091_images_byte_size.sql",
  "092_characters_deleting_flag.sql",
  "093_preset_cache_revision.sql",
  "094_regex_actions.sql",
  "095_lumihub_link_user_scope.sql",
  "096_character_folders.sql",
  "097_persona_extended_pronouns.sql",
  "098_world_book_entry_exclude_greeting.sql",
  "098_world_book_entry_revision.sql",
  "099_character_library_scope.sql",
  "100_stream_deck_tokens.sql",
  "101_regex_script_extension_ownership.sql",
  "102_character_source_filename_index.sql",
  "102_spindle_provider_scope.sql",
  "103_character_fts_update_columns.sql",
  "103_edit_and_send_outbox.sql",
  "104_world_book_source_filename_index.sql",
  "104_extension_grants_scoped_unique.sql",
  "105_st_migration_source_indexes.sql",
  "106_image_processing_queue.sql",
  "107_world_book_entry_order_index.sql",
  "108_images_skip_thumbnail_processing.sql",
  "109_illarin_instance.sql",
  "110_illarin_delivery_receipts.sql",
  "111_generation_outbox_connection_id.sql",
  "112_weaver_session_taste.sql",
  "113_agent_activity_runs.sql",
  "114_regex_validation.sql",
  "115_user_data_import_integrity.sql",
  "116_agent_config_v2.sql",
  "117_agent_turn_workspace.sql",
  "118_agent_run_projection.sql",
  "119_ticket_consumption_strict.sql",
  "120_agent_run_projection_outbox.sql",
  "121_archive_digest_constraints.sql",
  "122_ticket_consumption_account_delete.sql",
  "123_image_public_provenance.sql",
  "124_user_data_import_projection_pending.sql",
  "125_work_alpha1_workspace.sql",
  "126_work_alpha1_inspection.sql",
  "127_agent_runtime_repair_acknowledgements.sql",
  "128_persistent_workspace_session_revision.sql",
  "129_agent_inspection_source_retention.sql",
  "130_cognition_task_provenance.sql",
  "131_persistent_workspace_session_detach.sql",
  "132_persistent_workspace_chat_detach.sql",
  "133_agent_run_resync_snapshots.sql",
  "134_bounded_resync_and_portable_artifacts.sql",
  "135_agent_work_segments.sql",
];

const BASELINE_SET = new Set(BASELINE_MIGRATIONS);

/** The first migration in the PR #277 schema bundle. */
export const PRE_BUNDLE_MIGRATION_NUMBER = 113;
/** Deterministic, adjacent recovery copy retained across later migration runs. */
export const PRE_BUNDLE_BACKUP_SUFFIX = ".pre-bundle-113.sqlite";

type MigrationProof = {
  hasMigrationsTable: boolean;
  migrationNames: string[];
  schemaVersion: number;
  userVersion: number;
  applicationId: number;
  pageSize: number;
};

function isMemoryDatabase(db: Database): boolean {
  const filename = db.filename.trim().toLowerCase();
  return (
    filename.length === 0
    || filename === ":memory:"
    || filename.startsWith("file::memory:")
    || filename.includes("mode=memory")
  );
}

/**
 * Return the recovery path without exposing it in errors or logs. URI-style
 * database names are intentionally rejected: the application opens its
 * persistent database through a normal data-directory path, and treating an
 * unknown URI as a filesystem path would make the backup guarantee ambiguous.
 */
export function getPreBundleBackupPath(db: Database): string | null {
  if (isMemoryDatabase(db)) return null;
  if (db.filename.trim().toLowerCase().startsWith("file:")) {
    throw new Error("persistent database URI is unsupported for pre-bundle backup");
  }
  return `${db.filename}${PRE_BUNDLE_BACKUP_SUFFIX}`;
}

function migrationNumber(name: string): number | null {
  const match = /^(\d+)_/.exec(name);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

function readPragmaInteger(db: Database, pragma: "schema_version" | "user_version" | "application_id" | "page_size"): number {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null;
  const value = row ? Object.values(row)[0] : null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite PRAGMA ${pragma} did not return a valid integer`);
  }
  return value;
}

function readMigrationProof(db: Database): MigrationProof {
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
    .get();
  const migrationNames = table
    ? (db.query("SELECT name FROM _migrations ORDER BY id ASC").all() as Array<{ name: unknown }>).map((row) => {
        if (typeof row.name !== "string" || row.name.length === 0) {
          throw new Error("SQLite migration metadata contains an invalid name");
        }
        return row.name;
      })
    : [];

  return {
    hasMigrationsTable: !!table,
    migrationNames,
    schemaVersion: readPragmaInteger(db, "schema_version"),
    userVersion: readPragmaInteger(db, "user_version"),
    applicationId: readPragmaInteger(db, "application_id"),
    pageSize: readPragmaInteger(db, "page_size"),
  };
}

function assertIntegrity(db: Database, label: "source" | "backup"): void {
  const rows = db.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  const results = rows.map((row) => String(Object.values(row)[0] ?? ""));
  if (results.length !== 1 || results[0] !== "ok") {
    throw new Error(`SQLite ${label} integrity check failed`);
  }
}

function assertStrictlyPreBundle(proof: MigrationProof, label: "source" | "backup"): void {
  const crossing = proof.migrationNames.find((name) => {
    const number = migrationNumber(name);
    return number !== null && number >= PRE_BUNDLE_MIGRATION_NUMBER;
  });
  if (crossing) {
    throw new Error(`SQLite ${label} has crossed the pre-bundle migration boundary`);
  }
}

function assertMatchingProof(source: MigrationProof, backup: MigrationProof): void {
  if (
    source.hasMigrationsTable !== backup.hasMigrationsTable
    // VACUUM INTO legitimately increments SQLite's schema cookie in the
    // destination, so schemaVersion is validated as part of each proof but
    // is not an identity key between source and backup.
    || source.userVersion !== backup.userVersion
    || source.applicationId !== backup.applicationId
    || source.pageSize !== backup.pageSize
    || source.migrationNames.join("\u0000") !== backup.migrationNames.join("\u0000")
  ) {
    throw new Error("pre-bundle backup does not match the source schema identity");
  }
}

function validateBackup(backupPath: string, sourceProof: MigrationProof): void {
  let backup: Database | null = null;
  try {
    const backupStats = lstatSync(backupPath);
    if (backupStats.isSymbolicLink() || !backupStats.isFile()) {
      throw new Error("pre-bundle backup must be a regular file");
    }
    backup = new Database(backupPath, { readonly: true });
    assertIntegrity(backup, "backup");
    const backupProof = readMigrationProof(backup);
    assertStrictlyPreBundle(backupProof, "backup");
    assertMatchingProof(sourceProof, backupProof);
  } catch (error: unknown) {
    if (readErrorProperty(error, "message") === "pre-bundle backup does not match the source schema identity") {
      throw error;
    }
    // Do not leak the data-directory or backup path through startup errors.
    throw new Error("pre-bundle backup validation failed; startup aborted");
  } finally {
    backup?.close();
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readErrorProperty(error: unknown, property: "code" | "message"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = property === "code"
    ? ("code" in error ? error.code : undefined)
    : ("message" in error ? error.message : undefined);
  return typeof value === "string" ? value : undefined;
}

function syncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error: unknown) {
    // Windows does not expose directory handles that can be fsync'd. The
    // flushed backup file plus atomic no-replace link is its equivalent.
    const code = readErrorProperty(error, "code");
    const unsupportedOnWindows =
      process.platform === "win32"
      && (code === "EPERM" || code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP");
    if (!unsupportedOnWindows) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installBackupNoReplace(tempPath: string, backupPath: string, directory: string): void {
  try {
    // A hard-link install is atomic and cannot replace an existing path.
    // Both paths are adjacent, so this does not cross filesystems.
    linkSync(tempPath, backupPath);
  } catch (error: unknown) {
    if (readErrorProperty(error, "code") !== "EEXIST") throw error;
    unlinkSync(tempPath);
    return;
  }
  unlinkSync(tempPath);
  syncDirectory(directory);
}

function createPreBundleBackup(db: Database, backupPath: string, sourceProof: MigrationProof): void {
  const directory = dirname(backupPath);
  const tempPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // VACUUM INTO uses SQLite's backup machinery and includes committed pages
    // from a WAL without copying the live database/WAL files by hand.
    db.run(`VACUUM INTO ${sqliteStringLiteral(tempPath)}`);
    syncFile(tempPath);

    // Validate before installation, then validate the no-replace destination
    // again below. A partially written or malformed backup is never retained.
    validateBackup(tempPath, sourceProof);
    installBackupNoReplace(tempPath, backupPath, directory);
    validateBackup(backupPath, sourceProof);
  } catch (error: unknown) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original failure; startup remains fail-closed.
    }
    if (readErrorProperty(error, "message") === "pre-bundle backup does not match the source schema identity") {
      throw error;
    }
    throw new Error("pre-bundle SQLite backup failed; startup aborted");
  }
}

function migrationFileAlreadyRecorded(file: string, applied: ReadonlySet<string>, appliedBaseNames: ReadonlySet<string>): boolean {
  return applied.has(file) || appliedBaseNames.has(file.replace(/^\d+_/, ""));
}

/**
 * Ensure a durable recovery point exists before the first PR #277 migration.
 * This runs before _migrations is created or any baseline/migration SQL is
 * executed. In-memory databases intentionally have no recovery file.
 */
export function ensurePreBundleBackup(db: Database, migrationsDir: string): void {
  const backupPath = getPreBundleBackupPath(db);
  if (!backupPath) return;

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const bundleFiles = files.filter((file) => {
    const number = migrationNumber(file);
    return number !== null && number >= PRE_BUNDLE_MIGRATION_NUMBER;
  });
  if (bundleFiles.length === 0) return;

  const migrationTable = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
    .get();
  if (!migrationTable) {
    const existingSchema = db
      .query("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
      .get();
    // A brand-new persistent database has no user schema to protect; its
    // baseline bootstrap creates the post-bundle schema from scratch.
    if (!existingSchema) return;
  }

  const applied = new Set<string>();
  if (migrationTable) {
    for (const row of db.query("SELECT name FROM _migrations ORDER BY id ASC").all() as Array<{ name: unknown }>) {
      if (typeof row.name !== "string" || row.name.length === 0) {
        throw new Error("SQLite migration metadata contains an invalid name");
      }
      applied.add(row.name);
    }
  }
  const appliedBaseNames = new Set([...applied].map((name) => name.replace(/^\d+_/, "")));
  const hasBundleWork = bundleFiles.some((file) => !migrationFileAlreadyRecorded(file, applied, appliedBaseNames));
  if (!hasBundleWork) return;

  if (applied.size === 0) {
    const existingUserSchema = db
      .query("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_migrations' LIMIT 1")
      .get();
    if (!existingUserSchema) return;
  }
  assertIntegrity(db, "source");
  const sourceProof = readMigrationProof(db);
  // The bundle has already been crossed; later migrations do not need another
  // pre-bundle snapshot, and an existing recovery point must remain untouched.
  if (sourceProof.migrationNames.some((name) => {
    const number = migrationNumber(name);
    return number !== null && number >= PRE_BUNDLE_MIGRATION_NUMBER;
  })) return;
  assertStrictlyPreBundle(sourceProof, "source");

  if (existsSync(backupPath)) {
    validateBackup(backupPath, sourceProof);
    return;
  }
  createPreBundleBackup(db, backupPath, sourceProof);
}

function isInsideGitRepo(startPath: string): boolean {
  let current = startPath;
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function shouldAllowCleanup(migrationsDir: string): boolean {
  // Never prune if the app is running from a git checkout — developers
  // need the files, and a dirty worktree is dangerous.
  if (isInsideGitRepo(migrationsDir)) {
    return false;
  }
  // Respect explicit opt-in / opt-out env vars.
  if (process.env.LUMIVERSE_PRUNE_MIGRATIONS === "true") return true;
  if (process.env.LUMIVERSE_PRUNE_MIGRATIONS === "false") return false;
  // Default: allow cleanup when not inside a git repo (release installs).
  return true;
}

function cleanupOldMigrations(migrationsDir: string, db: Database): void {
  if (!shouldAllowCleanup(migrationsDir)) return;

  // Only prune if every baseline migration is recorded in _migrations.
  const applied = new Set(
    db.query("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );
  for (const name of BASELINE_MIGRATIONS) {
    if (!applied.has(name)) return; // Baseline not fully applied — unsafe.
  }

  let removed = 0;
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".sql")) continue;
    if (!BASELINE_SET.has(file)) continue; // Keep post-baseline migrations.
    const path = join(migrationsDir, file);
    try {
      unlinkSync(path);
      removed++;
    } catch {
      // Ignore permission errors silently.
    }
  }

  if (removed > 0) {
    console.log(`[db] Pruned ${removed} squashed migration file(s).`);
  }
}

function repairDreamWeaverBaselineDrift(db: Database): void {
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dream_weaver_sessions'")
    .get();
  if (!table) return;

  const columns = db.query("PRAGMA table_info('dream_weaver_sessions')").all() as Array<{ name: string }>;
  const hasModel = columns.some((column) => column.name === "model");
  if (hasModel) return;

  console.log("[db] Repairing Dream Weaver baseline schema drift: adding missing model column.");
  db.run("ALTER TABLE dream_weaver_sessions ADD COLUMN model TEXT");
}

// The shipped baseline.sql was regenerated from a DB that already had
// migrations 072, 075, and 076 applied, and includes the persistent workspace
// session revision introduced by migration 128. Returns true when the
// migration's effect is already in place and the runner should record it as
// applied without re-running.
function isBaselineDriftAlreadyApplied(db: Database, file: string): boolean {
  if (file === "072_world_books_folder.sql") {
    const columns = db.query("PRAGMA table_info('world_books')").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "folder");
  }
  if (file === "075_persona_is_narrator.sql") {
    const columns = db.query("PRAGMA table_info('personas')").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "is_narrator");
  }
  if (file === "076_cortex_salience_peak.sql") {
    const columns = db.query("PRAGMA table_info('memory_entities')").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "salience_peak");
  }
  if (file === "078_chats_character_id_nullable.sql") {
    const columns = db.query("PRAGMA table_info('chats')").all() as Array<{ name: string; notnull: number }>;
    const characterId = columns.find((column) => column.name === "character_id");
    return !!characterId && characterId.notnull === 0;
  }
  if (file === "128_persistent_workspace_session_revision.sql") {
    const columns = db.query("PRAGMA table_info('persistent_workspace_turn_sessions')").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "revision");
  }
  return false;
}

// Migrations that rebuild a table with child FKs (drop + recreate) must run
// with foreign-key enforcement off: with it on, DROP TABLE performs an
// implicit DELETE that fires ON DELETE CASCADE into every child table.
// PRAGMA foreign_keys is a no-op inside a transaction, so the runner flips
// it around the transaction instead of the .sql file doing it itself.
const FOREIGN_KEYS_OFF_MIGRATIONS = new Set([
  "078_chats_character_id_nullable.sql",
  // Table rebuild (drop + recreate) of extension_grants, which carries a child
  // FK into extensions with ON DELETE CASCADE.
  "104_extension_grants_scoped_unique.sql",
  // Persistent workspace detach rebuilds its session table while retaining
  // the canonical child ownership edges.
  "131_persistent_workspace_session_detach.sql",
]);

function applyMigrationWithForeignKeysOff(db: Database, file: string, sql: string): void {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.run(sql);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      console.warn(
        `[db] WARNING: ${violations.length} foreign key violation(s) present after ${file} ` +
          `(database-wide check; orphaned rows may pre-date this migration). First:`,
        violations[0],
      );
    }
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

export async function runMigrations(db: Database, migrationsDir?: string): Promise<void> {
  const dir = migrationsDir || join(import.meta.dir, "migrations");
  // This must precede _migrations creation and every baseline/migration write.
  ensurePreBundleBackup(db, dir);

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    // Quick sanity check to surface corruption immediately
    db.query("SELECT name FROM _migrations LIMIT 1").all();
  } catch (err: any) {
    if (err?.code && typeof err.code === "string" && err.code.startsWith("SQLITE_CORRUPT")) {
      console.warn(`[db] WARNING: SQLite database disk image is malformed (${err.code}) during migration init. Entering recovery path...`);
      healCorruptDatabase(db);

      // Retry table creation
      db.run(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
    } else {
      throw err;
    }
  }

  // ── Baseline bootstrap for brand-new databases ────────────────────────────
  const migrationCount = db.query("SELECT COUNT(*) as c FROM _migrations").get() as { c: number };
  if (migrationCount.c === 0) {
    const baselinePath = join(import.meta.dir, "baseline.sql");
    if (existsSync(baselinePath) && statSync(baselinePath).isFile()) {
      console.log("[db] Applying baseline schema (fresh database)...");
      const baselineSql = await Bun.file(baselinePath).text();
      db.run(baselineSql);

      // Record every squashed migration so future runners skip them.
      const insert = db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)");
      for (const name of BASELINE_MIGRATIONS) {
        insert.run(name);
      }
      insert.finalize();

      console.log(`[db] Baseline applied (${BASELINE_MIGRATIONS.length} migrations squashed).`);
    }
  }

  const applied = new Set(
    db.query("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Build a set of base names (without numeric prefix) for already-applied migrations
  // so we can detect renumbered files and skip re-execution.
  const appliedBaseNames = new Set(
    [...applied].map((a) => a.replace(/^\d+_/, ""))
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const baseName = file.replace(/^\d+_/, "");
    if (appliedBaseNames.has(baseName)) {
      // Same migration was already applied under a different number — just record it
      console.log(`Skipping renumbered migration: ${file} (already applied)`);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
      continue;
    }

    if (file === "068_migrate_dream_weaver_from_1_0.sql") {
      repairDreamWeaverBaselineDrift(db);
    }

    if (isBaselineDriftAlreadyApplied(db, file)) {
      console.log(`Skipping migration: ${file} (already present from baseline)`);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
      continue;
    }

    const sql = await Bun.file(join(dir, file)).text();
    console.log(`Applying migration: ${file}`);

    if (FOREIGN_KEYS_OFF_MIGRATIONS.has(file)) {
      applyMigrationWithForeignKeysOff(db, file, sql);
      continue;
    }

    db.transaction(() => {
      db.run(sql);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
  }

  // ── Clean up squashed migration files on release installs ─────────────────
  cleanupOldMigrations(dir, db);
}

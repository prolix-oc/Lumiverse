import { Database } from "bun:sqlite";
import { readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
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
];

const BASELINE_SET = new Set(BASELINE_MIGRATIONS);

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

export async function runMigrations(db: Database, migrationsDir?: string): Promise<void> {
  const dir = migrationsDir || join(import.meta.dir, "migrations");

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

    const sql = await Bun.file(join(dir, file)).text();
    console.log(`Applying migration: ${file}`);

    db.transaction(() => {
      db.run(sql);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
  }

  // ── Clean up squashed migration files on release installs ─────────────────
  cleanupOldMigrations(dir, db);
}

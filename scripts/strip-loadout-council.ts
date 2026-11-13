#!/usr/bin/env bun

/**
 * Strip the deprecated `councilSettings` blob out of stored loadout snapshots.
 *
 * Background: Council used to be captured into each loadout's snapshot. It is
 * now owned exclusively by the council-profile system (Character/Chat/Defaults
 * binds), so `LoadoutSnapshot.councilSettings` is deprecated and ignored by the
 * backend (see `src/services/loadouts.service.ts`). Loadouts created before that
 * change still carry an orphaned `councilSettings` object in their snapshot.
 * This script removes those dead blobs so the stored data matches the current
 * shape. It does NOT touch any `councilProfile:*` settings (the live council
 * bindings) — only the vestigial copy embedded in loadout snapshots.
 *
 * Dry-run by default. Pass `--apply` to persist changes.
 *
 * Loadouts live in the `settings` table under the `loadouts` key as a JSON
 * array, one row per user (user_id may be NULL on single-user installs).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "data";
const DB_PATH = join(DATA_DIR, "lumiverse.db");
const APPLY = process.argv.includes("--apply");

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

type SettingsRow = {
  value: string;
  user_id: string | null;
};

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

const rows = db
  .query("SELECT value, user_id FROM settings WHERE key = 'loadouts'")
  .all() as SettingsRow[];

console.log(`${APPLY ? "Applying" : "Dry run:"} loadout councilSettings cleanup`);
console.log(`Database: ${DB_PATH}`);
console.log("");
console.log(`Loadout rows scanned (one per user): ${rows.length}`);

type PendingUpdate = {
  userId: string | null;
  nextValue: string;
  cleanedNames: string[];
};

const updates: PendingUpdate[] = [];
let totalLoadouts = 0;
let totalCleaned = 0;
let parseFailures = 0;

for (const row of rows) {
  let loadouts: any;
  try {
    loadouts = JSON.parse(row.value);
  } catch {
    parseFailures += 1;
    continue;
  }
  if (!Array.isArray(loadouts)) continue;

  const cleanedNames: string[] = [];
  for (const loadout of loadouts) {
    totalLoadouts += 1;
    const snapshot = loadout?.snapshot;
    if (
      snapshot &&
      typeof snapshot === "object" &&
      Object.prototype.hasOwnProperty.call(snapshot, "councilSettings")
    ) {
      delete snapshot.councilSettings;
      cleanedNames.push(typeof loadout?.name === "string" ? loadout.name : loadout?.id ?? "(unnamed)");
    }
  }

  if (cleanedNames.length > 0) {
    totalCleaned += cleanedNames.length;
    updates.push({
      userId: row.user_id,
      nextValue: JSON.stringify(loadouts),
      cleanedNames,
    });
  }
}

console.log(`Total loadouts inspected: ${totalLoadouts}`);
console.log(`Loadouts carrying a dead councilSettings blob: ${totalCleaned}`);
if (parseFailures > 0) {
  console.log(`Rows with unparseable loadout JSON (skipped): ${parseFailures}`);
}

if (updates.length > 0) {
  console.log("\nLoadouts to clean:");
  for (const update of updates) {
    const who = update.userId ?? "(default/no user_id)";
    console.log(`- user ${who}: ${update.cleanedNames.join(", ")}`);
  }
}

if (APPLY && updates.length > 0) {
  // NULL-safe match: `user_id IS ?` handles both real user ids and the
  // single-user NULL row.
  const stmt = db.prepare(
    "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'loadouts' AND user_id IS ?",
  );
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (const update of updates) {
      stmt.run(update.nextValue, now, update.userId);
    }
  });
  tx();
  console.log(`\nUpdated ${updates.length} loadout row(s); cleaned ${totalCleaned} loadout snapshot(s).`);
} else if (APPLY) {
  console.log("\nNo loadout snapshots needed cleaning.");
} else {
  console.log("\nNo changes written. Re-run with --apply to strip the dead councilSettings blobs.");
}

db.close();

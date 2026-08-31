import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const PRE_BUNDLE_MIGRATION_NUMBER = 113;

const preBundleSql = readdirSync(import.meta.dir)
  .filter((file) => {
    const match = /^(\d+)_.*\.sql$/.exec(file);
    return match !== null && Number(match[1]) < PRE_BUNDLE_MIGRATION_NUMBER;
  })
  .sort()
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
  .join("\n");

const featureMigrations = readdirSync(import.meta.dir)
  .map((file) => ({ file, match: /^(\d+)_.*\.sql$/.exec(file) }))
  .filter(({ match }) => match !== null && Number(match[1]) >= PRE_BUNDLE_MIGRATION_NUMBER)
  .sort((left, right) => left.file.localeCompare(right.file))
  .map(({ file, match }) => ({
    file,
    number: Number(match![1]),
    sql: readFileSync(new URL(file, import.meta.url), "utf8"),
  }));

export function applyFeatureMigrationsThrough(db: Database, lastMigrationNumber: number): void {
  for (const migration of featureMigrations) {
    if (migration.number > lastMigrationNumber) break;
    if (migration.number === 128) {
      const hasRevision = (
        db.query("PRAGMA table_info('persistent_workspace_turn_sessions')").all() as Array<{ name: string }>
      ).some((column) => column.name === "revision");
      if (hasRevision) continue;
    }

    const requiresForeignKeysOff = migration.number === 131;
    if (requiresForeignKeysOff) db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run(migration.sql);
    } finally {
      if (requiresForeignKeysOff) db.run("PRAGMA foreign_keys = ON");
    }
  }
}

/** Builds the exact historical schema immediately before the feature bundle. */
export function createPreBundleDatabase(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(preBundleSql);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

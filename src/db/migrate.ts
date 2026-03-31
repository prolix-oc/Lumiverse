import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export async function runMigrations(db: Database, migrationsDir?: string): Promise<void> {
  const dir = migrationsDir || join(import.meta.dir, "migrations");

  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

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

    const sql = await Bun.file(join(dir, file)).text();
    console.log(`Applying migration: ${file}`);

    db.transaction(() => {
      db.run(sql);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
  }
}

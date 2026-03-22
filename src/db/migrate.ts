import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export function runMigrations(db: Database, migrationsDir?: string): void {
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

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(dir, file), "utf-8");
    console.log(`Applying migration: ${file}`);

    db.transaction(() => {
      db.run(sql);
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
  }
}

#!/usr/bin/env bun
/**
 * File-backed SQLite deletion probe. Uses synthetic data in a fresh directory;
 * never opens an existing instance database. Emits JSON lines before and after
 * each measured call so the last "start" identifies a call that never returns.
 *
 * bun run scripts/diagnose-sqlite-deletes.ts
 * bun run scripts/diagnose-sqlite-deletes.ts --dir=C:/path/to/data --keep
 * bun run scripts/diagnose-sqlite-deletes.ts --no-autocheckpoint
 *
 * Options: --dir=PATH, --rows=2000, --iterations=5, --busy-timeout=5000,
 *          --no-autocheckpoint, --keep, --help
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDatabase, initDatabase } from "../src/db/connection";
import { applyBaseDatabasePragmas } from "../src/db/maintenance";
import { bulkUpdateCharacterTags, updateCharacter } from "../src/services/characters.service";

if (process.argv.includes("--help")) {
  console.log((await Bun.file(import.meta.path).text()).split("\n").filter((line) => line.startsWith(" *")).map((line) => line.slice(3)).join("\n"));
  process.exit(0);
}
function argument(name: string, fallback: string): string {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}
function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}
const rows = integer("rows", 2000, 1, 1_000_000);
const iterations = integer("iterations", 5, 1, 1000);
const busyTimeout = integer("busy-timeout", 5000, 0, 60_000);
const baseDirectory = resolve(argument("dir", tmpdir()));
mkdirSync(baseDirectory, { recursive: true });
const directory = mkdtempSync(join(baseDirectory, "lumiverse-sqlite-deletes-"));
const path = join(directory, "probe.db");
const userId = "sqlite-probe-user";
const ids = Array.from({ length: rows }, (_, i) => `character-${i}`);
emit({ phase: "start", label: "open-database", directory });
const db = initDatabase(path);
let blocker: Database | null = null;
let reader: Database | null = null;

function emit(value: unknown): void { console.log(JSON.stringify(value)); }
function measure(label: string, fn: () => unknown): void {
  emit({ phase: "start", label });
  const started = performance.now();
  try {
    const result = fn();
    emit({ phase: "end", label, ms: Number((performance.now() - started).toFixed(2)), result });
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    emit({ phase: "end", label, ms: Number((performance.now() - started).toFixed(2)), error: { code: detail.code, message: detail.message } });
  }
}

try {
  db.exec("PRAGMA mmap_size = 0");
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  if (process.argv.includes("--no-autocheckpoint")) db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec(await Bun.file(join(import.meta.dir, "../src/db/baseline.sql")).text());
  db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(userId, "SQLite probe", "sqlite-probe@example.com");
  const insert = db.prepare("INSERT INTO characters (id, user_id, name, creator, tags) VALUES (?, ?, ?, 'Probe', '[\"keep\",\"drop\"]')");
  try {
    db.transaction(() => {
      for (const id of ids) insert.run(id, userId, `Synthetic ${id}`);
    })();
  } finally {
    insert.finalize();
  }
  emit({
    phase: "environment", platform: process.platform, arch: process.arch, bun: Bun.version,
    sqlite: db.query("SELECT sqlite_version() AS version, sqlite_source_id() AS source").get(),
    directory, rows, iterations,
    pragmas: Object.fromEntries(["mmap_size", "busy_timeout", "journal_mode", "wal_autocheckpoint", "synchronous", "foreign_keys"].map((name) => [name, db.query(`PRAGMA ${name}`).get()])),
    compileOptions: db.query("PRAGMA compile_options").all().filter((row) => /THREADSAFE|MMAP|FTS|WAL|LOCK/.test(JSON.stringify(row))),
  });

  for (let i = 0; i < iterations; i++) {
    measure(`single-tag-remove-${i}`, () => ({ tags: updateCharacter(userId, ids[0], { tags: ["keep"] }, { emitEvent: false })?.tags }));
    measure(`single-tag-restore-${i}`, () => ({ tags: updateCharacter(userId, ids[0], { tags: ["keep", "drop"] }, { emitEvent: false })?.tags }));
    measure(`bulk-tag-remove-${i}`, () => bulkUpdateCharacterTags(userId, { ids, operation: "remove", tags: ["drop"] }));
    measure(`bulk-tag-restore-${i}`, () => bulkUpdateCharacterTags(userId, { ids, operation: "add", tags: ["drop"] }));
    const victim = `delete-${i}`;
    db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, 'Delete probe')").run(victim, userId);
    // Isolates the SQL/FTS/FK work from the character service's file/vector cleanup.
    measure(`character-row-delete-${i}`, () => db.query("DELETE FROM characters WHERE id = ? AND user_id = ?").run(victim, userId));
    measure(`passive-checkpoint-${i}`, () => db.query("PRAGMA wal_checkpoint(PASSIVE)").get());
    measure(`truncate-checkpoint-${i}`, () => db.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
  }

  blocker = new Database(path);
  applyBaseDatabasePragmas(blocker);
  blocker.exec("PRAGMA mmap_size = 0; BEGIN IMMEDIATE");
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 10);
  try {
    measure("tag-remove-with-competing-writer", () => updateCharacter(userId, ids[0], { tags: ["keep"] }, { emitEvent: false }));
    emit({ phase: "event-loop", timerRanDuringNativeCall: timerRan, busyTimeout });
  } finally {
    clearTimeout(timer);
    blocker.exec("ROLLBACK");
  }
  measure("tag-remove-after-writer-release", () => ({ tags: updateCharacter(userId, ids[0], { tags: ["keep"] }, { emitEvent: false })?.tags }));

  reader = new Database(path);
  applyBaseDatabasePragmas(reader);
  reader.exec("PRAGMA mmap_size = 0");
  const cursor = reader.prepare("SELECT id FROM characters");
  try {
    // Models an export aborted before exhausting Statement.iterate().
    for (const row of cursor.iterate()) { break; }
    db.query("UPDATE characters SET updated_at = updated_at + 1 WHERE id = ?").run(ids[0]);
    measure("passive-checkpoint-with-abandoned-cursor", () => db.query("PRAGMA wal_checkpoint(PASSIVE)").get());
    measure("truncate-checkpoint-with-abandoned-cursor", () => db.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
  } finally {
    cursor.finalize();
  }
  measure("truncate-checkpoint-after-cursor-finalize", () => db.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
} finally {
  reader?.close(true);
  blocker?.close(true);
  db.close(true);
  closeDatabase();
  if (!process.argv.includes("--keep")) rmSync(directory, { recursive: true, force: true });
  else emit({ phase: "kept", directory });
}
emit({ phase: "complete" });
// Imported application services own background intervals. All probe resources
// have been closed above; end this standalone diagnostic process explicitly.
process.exit(0);

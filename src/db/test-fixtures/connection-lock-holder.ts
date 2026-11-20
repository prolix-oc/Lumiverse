import { Database } from "bun:sqlite";
import { writeFileSync, unlinkSync } from "node:fs";

// Release the lock in another process: a timer on the test's thread cannot run
// while a synchronous SQLite caller is waiting in its busy handler.
const path = process.argv[2]!;
const signalFile = process.argv[3] || (path + ".locked");
const db = new Database(path);
try {
  db.run("BEGIN IMMEDIATE"); db.run("UPDATE probe SET value = value + 1");
  writeFileSync(signalFile, "locked\n");
  await Bun.sleep(500);
  db.run("COMMIT");
  unlinkSync(signalFile);
} finally {
  db.close(true);
}

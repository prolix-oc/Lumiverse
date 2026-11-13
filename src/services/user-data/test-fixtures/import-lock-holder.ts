import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

// A parent-thread timer cannot release a lock while synchronous SQLite writes
// wait in their busy handler. Keep the competing transaction in its own process.
const db = new Database(process.argv[2]!);
try {
  db.exec("BEGIN IMMEDIATE");
  writeFileSync(process.argv[3]!, "locked\n");
  await Bun.sleep(350);
  db.exec("COMMIT");
} finally {
  db.close(true);
}

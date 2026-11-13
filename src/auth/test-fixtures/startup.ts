import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../../db/connection";
import { executeDatabaseOperation, startDatabaseExecution, stopDatabaseExecution } from "../../db/execution";

const directory = process.argv[2]!;
const db = initDatabase(join(directory, "lumiverse.db"), { busyTimeoutMs: Number(process.argv[3]) });

try {
  // Earlier startup operations may launch the supervised child, but its
  // background work must remain deferred throughout auth initialization.
  await executeDatabaseOperation({ kind: "read", statement: { sql: "SELECT 1", mode: "get" } });
  writeFileSync(join(directory, "ready"), "ready");
  while (!existsSync(join(directory, "start"))) await Bun.sleep(10);

  try {
    await import("../index");
    const resource = db.query('SELECT name, disabled, accessTokenTtl, allowedScopes FROM "oauthResource"').get();
    const pending = db.query("SELECT COUNT(*) AS count FROM image_reference_index_state WHERE completed = 0").get();
    await startDatabaseExecution();
    writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, resource, pending }));
  } catch (error) {
    const failure = error as Error & { code?: string; cause?: { code?: string } };
    writeFileSync(join(directory, "result.json"), JSON.stringify({
      ok: false, message: failure.message, code: failure.code, causeCode: failure.cause?.code,
    }));
  }
} finally {
  await stopDatabaseExecution();
  closeDatabase();
}

// Exercise the same top-level awaits as application startup, outside bun:test.
import { closeDatabase, initDatabase } from "../connection";
import { executeDatabaseOperation, startDatabaseExecution, stopDatabaseExecution } from "../execution";
import { runMigrations } from "../migrate";
import { seedTokenizersAsync } from "../../services/tokenizer-seed";

const db = initDatabase(process.argv[2]!);
try {
  await runMigrations(db);
  await seedTokenizersAsync();
  await startDatabaseExecution();
  const seeded = await executeDatabaseOperation<{ count: number }>({ kind: "read", statement: {
    sql: "SELECT COUNT(*) AS count FROM tokenizer_configs WHERE is_built_in = 1", mode: "get",
  } });
  if (seeded.count < 20) throw new Error("Built-in tokenizers were not seeded");
  console.log("database bootstrap complete");
} finally {
  await stopDatabaseExecution();
  closeDatabase();
}

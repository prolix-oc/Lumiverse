/** Entry point for native LanceDB maintenance kept outside the HTTP server. */
import { closeDatabase, initDatabase } from "../db/connection";
import { getResolvedVectorStoreConfig } from "./vector-store-config.service";

const mode = process.env.LUMIVERSE_LANCEDB_MAINTENANCE_MODE;
let lance: typeof import("./vector-store/providers/lancedb") | undefined;

async function run(): Promise<void> {
  // Startup maintenance can migrate world-book state in SQLite. Open the same
  // database with the regular WAL/pragma setup, but do not run server startup
  // migrations or monitors in this one-shot child.
  initDatabase();
  // A provider switch may have committed after the parent launched this child.
  if (getResolvedVectorStoreConfig().provider !== "lancedb") return;
  lance = await import("./vector-store/providers/lancedb");
  if (mode === "startup") {
    await lance.runStartupVectorMaintenance();
  } else if (mode === "optimize") {
    const tableNames = (process.env.LUMIVERSE_LANCEDB_MAINTENANCE_TABLES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    await lance.optimizeTable(tableNames.length > 0 ? tableNames : undefined);
  } else {
    throw new Error(`Unknown LanceDB maintenance mode: ${mode || "(unset)"}`);
  }
}

try {
  await run();
} catch (err) {
  console.error("[embeddings] LanceDB maintenance child failed:", err);
  process.exitCode = 1;
} finally {
  // runStartupVectorMaintenance installs a health interval for the long-lived
  // server. This one-shot child must clear it so a successful maintenance pass
  // can actually exit and release the serving process gate.
  lance?.stopIndexHealthMonitor();
  closeDatabase();
}

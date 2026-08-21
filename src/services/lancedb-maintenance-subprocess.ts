/** Entry point for native LanceDB maintenance kept outside the HTTP server. */
import { closeDatabase, initDatabase } from "../db/connection";
import { optimizeTable, runStartupVectorMaintenance, stopIndexHealthMonitor } from "./vector-store/providers/lancedb";

const mode = process.env.LUMIVERSE_LANCEDB_MAINTENANCE_MODE;

try {
  // Startup maintenance can migrate world-book state in SQLite. Open the same
  // database with the regular WAL/pragma setup, but do not run server startup
  // migrations or monitors in this one-shot child.
  initDatabase();
  if (mode === "startup") {
    await runStartupVectorMaintenance();
  } else if (mode === "optimize") {
    const tableNames = (process.env.LUMIVERSE_LANCEDB_MAINTENANCE_TABLES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    await optimizeTable(tableNames.length > 0 ? tableNames : undefined);
  } else {
    throw new Error(`Unknown LanceDB maintenance mode: ${mode || "(unset)"}`);
  }
} catch (err) {
  console.error("[embeddings] LanceDB maintenance child failed:", err);
  process.exitCode = 1;
} finally {
  // runStartupVectorMaintenance installs a health interval for the long-lived
  // server. This one-shot child must clear it so a successful maintenance pass
  // can actually exit and release the serving process gate.
  stopIndexHealthMonitor();
  closeDatabase();
}

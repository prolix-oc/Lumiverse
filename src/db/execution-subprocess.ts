import { closeDatabase, initDatabase } from "./connection";
import { executeOperation, isTransactionalOperation } from "./execute-operation";
import { startDatabaseMonitor } from "./maintenance";
import { createDatabaseSubprocessChannel } from "./execution-transport";
import type { DatabaseChildMessage, DatabaseHostMessage } from "./execution-protocol";
import { createImageReferenceDiagnostics } from "./image-reference-diagnostics";
import { startImageReferenceIndexer } from "./image-reference-index";

const path = process.argv[2];
if (!path || path === ":memory:") throw new Error("Database subprocess requires a file-backed database");
function send(message: DatabaseChildMessage): void { channel.send(message); }
let db: ReturnType<typeof initDatabase>;
let stopIndexer: (() => void) | undefined;
function startBackgroundWork(): void {
  if (stopIndexer) return;
  startDatabaseMonitor(() => db, path);
  stopIndexer = startImageReferenceIndexer(db);
}

const channel = createDatabaseSubprocessChannel((message: DatabaseHostMessage) => {
    if (message.type === "shutdown") {
      stopIndexer?.();
      closeDatabase();
      process.exit(0);
    }
    if (message.type === "start-background") {
      startBackgroundWork();
      return;
    }
    if (message.type !== "execute") return;
    const started = performance.now();
    const imageReferences = message.operation.kind === "image-references"
      ? createImageReferenceDiagnostics(new Set(message.operation.ids).size) : undefined;
    let result: unknown;
    try {
      result = executeOperation(db, path, message.operation, imageReferences);
    } catch (err) {
      const error = err as { message?: string; name?: string; code?: string; statementIndex?: number };
      // Only an acknowledged rollback permits the host to retry a write.
      const rolledBack = isTransactionalOperation(message.operation) && !db.inTransaction;
      send({ type: "error", requestId: message.requestId, error: {
        message: error.message ?? String(err), name: error.name, code: error.code,
        outcome: rolledBack ? "rolled-back" : "unknown",
        statementIndex: error.statementIndex,
      } });
      return;
    }
    // Failure to acknowledge a successful COMMIT must not be called a rollback.
    // Let the process exit; the host will report an unknown outcome.
    send({ type: "result", requestId: message.requestId, result, durationMs: performance.now() - started, imageReferences });
  }, () => { stopIndexer?.(); closeDatabase(); process.exit(0); });

// Normal exits finalize handles; a forced kill is handled by the OS.
process.on('exit', () => {
  stopIndexer?.();
  closeDatabase();
});

try {
  db = initDatabase(path, { busyTimeoutMs: 100, automaticCheckpoint: false, allowMmap: false });
  if (!process.argv.includes("--defer-background")) startBackgroundWork();
  send({ type: "ready" });
} catch (err) {
  const error = err as Error;
  send({ type: "error", error: { message: error.message, name: error.name, outcome: "not-started" } });
  process.exit(1);
}

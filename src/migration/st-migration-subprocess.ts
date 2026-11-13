import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
import { withFileSystem } from "../file-connections/factory";
import type { HostToStMigration, StMigrationToHost } from "./st-ipc";
import type { MigrationLogger } from "./st-reader";
import { runStMigrationPipeline } from "./st-runner";

function send(message: StMigrationToHost): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

if (typeof process.send !== "function") {
  throw new Error("SillyTavern migration subprocess requires IPC-enabled process.send()");
}

const initialized = (async () => {
  await initIdentity();
  initDatabase();
})();

process.on("message", (message) => {
  const payload = message as HostToStMigration;
  if (payload.type === "shutdown") {
    process.exit(0);
    return;
  }
  if (payload.type !== "start") return;

  void (async () => {
    const { job } = payload;
    const startTime = Date.now();
    let importedCharacterCount = 0;
    let characterImportAttempted = false;
    const logger: MigrationLogger = {
      info(text) { send({ type: "log", level: "info", message: text }); },
      warn(text) { send({ type: "log", level: "warn", message: text }); },
      error(text) { send({ type: "log", level: "error", message: text }); },
      progress(label, current, total) {
        send({ type: "progress", phase: "running", label, current, total });
      },
    };

    try {
      await initialized;
      const outcome = await withFileSystem(job.connection, (fs) =>
        runStMigrationPipeline(
          job.migrationId,
          job.targetUserId,
          job.dataDir,
          job.scope,
          logger,
          fs,
          {
            setPhase: (phase) => {
              send({ type: "progress", phase, label: phase, current: 0, total: 0 });
            },
          },
        ),
      );
      importedCharacterCount = outcome.importedCharacterCount;
      characterImportAttempted = outcome.characterImportAttempted;
      send({
        type: "done",
        results: outcome.results,
        importedCharacterCount,
        characterImportAttempted,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      send({
        type: "failed",
        error: err instanceof Error ? err.message : String(err),
        importedCharacterCount,
        characterImportAttempted,
      });
    } finally {
      process.exit(0);
    }
  })();
});

void initialized.then(
  () => send({ type: "ready" }),
  (err) => {
    send({
      type: "failed",
      error: err instanceof Error ? err.message : String(err),
      importedCharacterCount: 0,
      characterImportAttempted: false,
    });
    process.exit(1);
  },
);

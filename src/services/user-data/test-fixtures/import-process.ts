import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { initDatabase } from "../../../db/connection";
import { env } from "../../../env";
import { eventBus } from "../../../ws/bus";
import { EventType } from "../../../ws/events";
import { startImport } from "../import.service";

const [directory, userId, jobId] = process.argv.slice(2) as [string, string, string];
env.dataDir = directory;
initDatabase(join(directory, "lumiverse.db"));
const emit = eventBus.emit.bind(eventBus);
eventBus.emit = (type, payload, ...rest) => {
  emit(type, payload, ...rest);
  if (type === EventType.USER_IMPORT_PROGRESS && payload.phase === "table_done" && payload.table === "characters") {
    writeFileSync(join(directory, "committed"), jobId);
    // Parent kills this disposable process after a committed batch. No finally
    // block or graceful-shutdown hook may hide a real process-loss defect.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
};
startImport({ userId, jobId, archivePath: join(directory, "imports", userId, jobId, "archive.lvbak") });

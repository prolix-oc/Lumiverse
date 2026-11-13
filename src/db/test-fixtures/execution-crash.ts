// An actual committed write whose acknowledgment is lost. The host must never
// replay it after observing the process exit.
import { initDatabase } from "../connection";
import { executeOperation } from "../execute-operation";
import { createDatabaseSubprocessChannel } from "../execution-transport";
import type { DatabaseHostMessage } from "../execution-protocol";

const path = process.argv[2]!;
const db = initDatabase(path, { automaticCheckpoint: false, allowMmap: false });
const channel = createDatabaseSubprocessChannel((message: DatabaseHostMessage) => {
  if (message.type !== "execute") return;
  const result = executeOperation(db, path, message.operation);
  if (message.operation.kind === "transaction" && message.operation.statements.some((statement) => statement.sql.includes("lose-ack"))) process.exit(1);
  channel.send({ type: "result", requestId: message.requestId, result, durationMs: 0 });
}, () => process.exit(0));
if (process.argv[3] === "--stdio") console.log("[db] Pipe transport diagnostic output");
channel.send({ type: "ready" });

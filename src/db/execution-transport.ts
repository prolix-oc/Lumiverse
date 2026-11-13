import { encodeSubprocessMessage, readSubprocessMessages } from "../utils/subprocess-messages";
import type { DatabaseChildMessage, DatabaseHostMessage } from "./execution-protocol";
import { createDatabaseSocketClient } from "./execution-socket";

type DatabaseMessage = DatabaseChildMessage | DatabaseHostMessage;

export const encodeDatabaseMessage = (message: DatabaseMessage): Buffer => encodeSubprocessMessage(message);
export const readDatabaseMessages = (stream: ReadableStream<Uint8Array>, receive: (message: DatabaseMessage) => void): Promise<void> =>
  readSubprocessMessages(stream, (message) => receive(message as DatabaseMessage));

export function createDatabaseSubprocessChannel(
  receive: (message: DatabaseHostMessage) => void,
  disconnect: () => void,
): { send: (message: DatabaseChildMessage) => void } {
  if (process.argv[3] === "--socket") {
    return createDatabaseSocketClient({
      receive: (message) => receive(message as DatabaseHostMessage),
      disconnect,
    });
  }
  if (process.argv[3] === "--stdio") {
    // Periodic SQLite diagnostics must not mix text into the binary channel.
    console.log = console.error.bind(console);
    console.info = console.error.bind(console);
    console.debug = console.error.bind(console);
    process.stdout.on("error", disconnect);
    void readDatabaseMessages(Bun.stdin.stream(), (message) => receive(message as DatabaseHostMessage)).then(disconnect, disconnect);
    return { send: (message) => { process.stdout.write(encodeDatabaseMessage(message)); } };
  }
  if (typeof process.send !== "function") throw new Error("Database subprocess requires a transport");
  process.on("message", (message) => receive(message as DatabaseHostMessage));
  process.on("disconnect", disconnect);
  return { send: (message) => { process.send!(message); } };
}

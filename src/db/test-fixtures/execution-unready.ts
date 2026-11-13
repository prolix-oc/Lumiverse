// A live child whose transport connects but never sends ready. No SQL may run.
import { createDatabaseSubprocessChannel } from "../execution-transport";
createDatabaseSubprocessChannel(message => {
  if (message.type === "shutdown") process.exit(0);
}, () => process.exit(0));
setInterval(() => {}, 1000);

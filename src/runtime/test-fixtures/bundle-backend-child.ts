import { onRunnerDisconnect, onRunnerMessage, sendRunnerMessage } from "../../services/runner-channel";

onRunnerMessage((message) => {
  if (message.type === "shutdown") process.exit(0);
});
onRunnerDisconnect(() => process.exit(0));
const ready = { type: "bundle-ready", usesBunIpc: typeof process.send === "function" };
sendRunnerMessage(ready);

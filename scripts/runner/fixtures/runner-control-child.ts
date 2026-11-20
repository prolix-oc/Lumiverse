import {
  createRunnerControlClient,
  type RunnerControlClient,
} from "../../../src/services/runner-control-transport.js";

let control: RunnerControlClient | null = null;

control = createRunnerControlClient({
  onMessage(message) {
    const command = message as { type?: unknown; value?: unknown };
    if (command.type === "ping") {
      control?.send({ type: "pong", value: command.value });
    } else if (command.type === "shutdown") {
      control?.close();
      setTimeout(() => process.exit(0), 25);
    }
  },
  onError(message) {
    console.error(`[runner-control-fixture] ${message}`);
    process.exitCode = 2;
  },
  onDisconnect() {
    process.exit(3);
  },
});

if (!control) {
  console.error("[runner-control-fixture] Missing runner control bootstrap");
  process.exit(2);
}

control.send({ type: "ready", pid: process.pid });

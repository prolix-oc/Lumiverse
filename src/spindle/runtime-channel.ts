import { encodeSubprocessMessage, readSubprocessMessages } from "../utils/subprocess-messages";

/** Shared by backend processes and extension runtimes, including Worker mode. */
export function createRuntimeChannel(receive: (message: unknown) => void): {
  send(message: unknown): void;
  exit(code: number): void;
} {
  // Capture these before an extension's cooperative sandbox replaces process.exit.
  const exit = process.exit.bind(process);
  if (process.argv.includes("--spindle-stdio")) {
    const output = process.stdout;
    // Diagnostic text must never be mixed into the binary message stream.
    console.log = console.error.bind(console);
    console.info = console.error.bind(console);
    console.debug = console.error.bind(console);
    output.on("error", () => exit(1));
    void readSubprocessMessages(Bun.stdin.stream(), receive).then(
      () => exit(0),
      (error) => { console.error("[Spindle] Transport failed:", error); exit(1); },
    );
    return {
      send(message) { output.write(encodeSubprocessMessage(message)); },
      // Completion and shutdown acknowledgements must reach the host before exit.
      exit(code) { output.end(() => exit(code)); },
    };
  }
  if (typeof process.send === "function") {
    process.on("message", receive);
    process.on("disconnect", () => exit(0));
    return { send(message) { process.send!(message); }, exit };
  }
  self.onmessage = (event: MessageEvent) => receive(event.data);
  return { send(message) { self.postMessage(message); }, exit };
}

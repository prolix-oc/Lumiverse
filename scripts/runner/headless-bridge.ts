/**
 * Headless bridge — stdio control channel for the desktop tray app.
 *
 * When the runner starts with --headless, a desktop supervisor (see
 * desktop/) owns the runner as a child process and drives it over stdio
 * instead of a terminal:
 *
 *   stdin  — one JSON command per line, the same message shapes the
 *            Operator panel sends over child IPC ({type, id, payload}).
 *   stdout — protocol frames: 0x1E (record separator) + JSON + "\n".
 *            Server log output is carried inside {type:"log"} frames
 *            (JSON-escaped), never written raw — so a server log line
 *            can't spoof a frame by starting with 0x1E. Unframed lines
 *            can only originate from the runner's own code.
 *
 * Commands are routed into the existing handleIPCMessage() dispatcher;
 * responses and progress events for stdin-originated requests come back
 * through this bridge rather than being relayed to the server child.
 * No sockets or listeners are opened — the channel only exists between
 * this process and its parent.
 */

import { handleIPCMessage } from "./ipc-handler.js";
import { setOutputSink, type ServerState } from "./server-manager.js";

export const FRAME_PREFIX = "\x1e";

/** Encode a protocol message as a stdout frame. */
export function encodeFrame(message: unknown): string {
  return `${FRAME_PREFIX}${JSON.stringify(message)}\n`;
}

/**
 * Consume complete newline-terminated lines from an input buffer.
 * Returns parsed JSON commands and the unconsumed remainder. Blank and
 * malformed lines are dropped — a supervisor bug should not wedge the
 * runner.
 */
export function drainCommandBuffer(buffer: string): { commands: unknown[]; rest: string } {
  const commands: unknown[] = [];
  let rest = buffer;
  let newlineIndex: number;
  while ((newlineIndex = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, newlineIndex).trim();
    rest = rest.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      commands.push(JSON.parse(line));
    } catch {
      // Malformed line — skip
    }
  }
  return { commands, rest };
}

export interface HeadlessBridge {
  /** Push a server state change to the supervisor. */
  notifyState(state: ServerState): void;
}

export interface HeadlessBridgeOptions {
  /**
   * Called when stdin closes — the supervisor died or detached. The
   * runner should shut down gracefully rather than run orphaned.
   */
  onDisconnect: () => void;
}

export function attachHeadlessBridge(options: HeadlessBridgeOptions): HeadlessBridge {
  const writeFrame = (message: unknown): void => {
    process.stdout.write(encodeFrame(message));
  };

  // Wrap server output in frames instead of passing raw bytes through.
  // Streaming decoders keep multi-byte UTF-8 intact across chunk splits.
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  setOutputSink((chunk, stream) => {
    const data = decoders[stream].decode(chunk, { stream: true });
    if (data) writeFrame({ type: "log", id: "log", payload: { stream, data } });
  });

  let inputBuffer = "";
  let disconnected = false;

  const disconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    options.onDisconnect();
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inputBuffer += chunk;
    const { commands, rest } = drainCommandBuffer(inputBuffer);
    inputBuffer = rest;
    for (const command of commands) {
      handleIPCMessage(command, writeFrame).catch((err) => {
        console.error("[runner] Headless command failed:", err);
      });
    }
  });
  process.stdin.on("end", disconnect);
  process.stdin.on("close", disconnect);
  process.stdin.resume();

  return {
    notifyState(state: ServerState): void {
      writeFrame({ type: "state", id: "state", payload: { state } });
    },
  };
}

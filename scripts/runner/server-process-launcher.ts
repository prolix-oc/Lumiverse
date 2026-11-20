import type { RunnerControlHost } from "../../src/services/runner-control-transport.js";
import {
  forwardServerOutput,
  type ServerProcessOutput,
  type ServerOutputWriter,
} from "./server-process-output.js";
import { spawnSocketControlledProcess } from "./socket-controlled-process.js";

export type ServerLaunchTransport = "socket" | "ipc";
export type ServerControl = Pick<RunnerControlHost, "close" | "send">;
export type ManagedServerProcess = Pick<Bun.Subprocess, "exited" | "kill" | "pid">;

export interface ServerProcessLaunch {
  proc: ManagedServerProcess;
  control: ServerControl;
  /** Resolves once owned output pipes close; inherited output resolves immediately. */
  outputDone: Promise<void>;
  /** Stop owned pipe readers so orphaned descendants cannot hold a restart open. */
  closeOutput(): void;
}

/**
 * Launch the backend and bind each transport to its matching output strategy.
 * Keeping these decisions atomic prevents inherited OS descriptors from being
 * mistaken for Web ReadableStreams by downstream lifecycle code.
 */
export function launchServerProcess(options: {
  transport: ServerLaunchTransport;
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onMessage(message: unknown): void;
  onControlError(message: string): void;
  onControlDisconnect(): void;
  writeOutput: ServerOutputWriter;
}): ServerProcessLaunch {
  let proc: ManagedServerProcess;
  let control: ServerControl;
  let output: ServerProcessOutput;

  if (options.transport === "socket") {
    const launched = spawnSocketControlledProcess({
      cmd: options.cmd,
      cwd: options.cwd,
      env: options.env,
      onMessage: options.onMessage,
      onError: options.onControlError,
      onDisconnect: options.onControlDisconnect,
    });
    proc = launched.proc;
    control = launched.control;
    output = launched.output;
  } else {
    const launched = Bun.spawn({
      cmd: options.cmd,
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: options.env,
      ipc: options.onMessage,
    });
    proc = launched;
    output = {
      kind: "piped",
      stdout: launched.stdout,
      stderr: launched.stderr,
    };
    control = {
      send(message: unknown): boolean {
        try {
          launched.send(message);
          return true;
        } catch {
          return false;
        }
      },
      close() {},
    };
  }

  const outputAbort = new AbortController();
  return {
    proc,
    control,
    outputDone: forwardServerOutput(output, options.writeOutput, outputAbort.signal),
    closeOutput(): void {
      outputAbort.abort();
    },
  };
}

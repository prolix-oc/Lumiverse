import { createRunnerControlHost } from "../../src/services/runner-control-transport.js";
import type { ServerProcessOutput } from "./server-process-output.js";

/**
 * Launch a backend without asking Bun to manage child IPC or output pipes.
 *
 * The tray runner reserves stdout for its native framing protocol, so the
 * backend inherits the runner's stderr for both output streams. The native
 * host already captures that stream for the launcher log.
 */
export function spawnSocketControlledProcess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  onMessage(message: unknown): void;
  onError(message: string): void;
  onDisconnect(): void;
}) {
  const control = createRunnerControlHost({
    onMessage: options.onMessage,
    onError: options.onError,
    onDisconnect: options.onDisconnect,
  });

  try {
    const proc = Bun.spawn({
      cmd: options.cmd,
      cwd: options.cwd,
      env: { ...options.env, ...control.bootstrapEnv },
      stdin: "ignore",
      stdout: 2,
      stderr: 2,
      windowsHide: true,
    });
    // stdout/stderr are already owned and drained by the runner's fd 2. Keep
    // that fact beside the process instead of asking downstream code to infer
    // it from Bun's numeric proc.stdout/proc.stderr values.
    const output = { kind: "inherited" } as const satisfies ServerProcessOutput;
    return { proc, control, output };
  } catch (error) {
    control.close();
    throw error;
  }
}

export type SocketControlledProcess = ReturnType<typeof spawnSocketControlledProcess>;

import { createRunnerControlHost, type RunnerControlHost } from "../services/runner-control-transport";

/** Windows must use the same control transport as the checkout runner. */
export function spawnBundleBackend(options: {
  cmd: string[];
  env: Record<string, string | undefined>;
  desktop: boolean;
  serve: boolean;
  onMessage(message: unknown): void;
  onError(message: string): void;
  onDisconnect(): void;
  platform?: string;
}) {
  const windows = (options.platform || process.platform) === "win32";
  let control: RunnerControlHost | undefined;
  if (windows && options.serve) control = createRunnerControlHost({
    onMessage: options.onMessage, onError: options.onError, onDisconnect: options.onDisconnect,
  });
  try {
    const proc = Bun.spawn({
      cmd: options.cmd,
      env: { ...options.env, ...control?.bootstrapEnv },
      stdin: options.desktop ? "ignore" : "inherit", stdout: "inherit", stderr: "inherit",
      detached: !options.desktop && !windows,
      windowsHide: options.desktop,
      // Bun IPC has Windows-specific exit/disconnect gaps. The packaged
      // launcher needs the socket workaround just as the checkout does.
      ...(windows ? {} : { ipc: options.onMessage }),
    });
    return {
      pid: proc.pid,
      exited: proc.exited,
      kill: (signal: NodeJS.Signals) => proc.kill(signal),
      send(message: unknown): boolean {
        if (control) return control.send(message);
        try { proc.send(message); return true; } catch { return false; }
      },
      close() { control?.close(); },
    };
  } catch (error) {
    control?.close();
    throw error;
  }
}

export type BundleBackend = ReturnType<typeof spawnBundleBackend>;

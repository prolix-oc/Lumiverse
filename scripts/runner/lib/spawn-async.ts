/**
 * Async Bun.spawn wrapper used by the runner for git / bun / build commands.
 *
 * Adds:
 *   - Mandatory timeout support — subprocess is aborted on timeout instead of
 *     blocking the runner forever. `git pull`, `bun install`, and `bun run
 *     build` have no native way to self-cancel on a hung network or stuck
 *     build pipeline; without a timeout, a single bad subprocess freezes the
 *     branch-switch / update flow indefinitely.
 *   - Concurrent stream draining — pipe buffers don't fill during verbose
 *     output, so the child never deadlocks waiting for a reader.
 *   - Clean stdin — children inherit no tty, so any prompt fails fast
 *     instead of hanging.
 */
export interface SpawnAsyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnAsyncOptions {
  cwd?: string;
  /** Kill the subprocess after this many ms. Returns timedOut: true. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Discard stdout instead of capturing. */
  ignoreStdout?: boolean;
}

export async function spawnAsync(
  cmd: string[],
  opts: SpawnAsyncOptions = {}
): Promise<SpawnAsyncResult> {
  const hasTimeout = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0;
  const controller = hasTimeout ? new AbortController() : undefined;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.timeoutMs)
    : undefined;

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: opts.ignoreStdout ? "ignore" : "pipe",
    stderr: "pipe",
    ...(controller ? { signal: controller.signal } : {}),
  });

  try {
    const stdoutPromise = opts.ignoreStdout || !proc.stdout
      ? Promise.resolve("")
      : Bun.readableStreamToText(proc.stdout as ReadableStream);
    const stderrPromise = proc.stderr
      ? Bun.readableStreamToText(proc.stderr as ReadableStream)
      : Promise.resolve("");

    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      proc.exited,
    ]);

    return { exitCode: exitCode ?? -1, stdout, stderr, timedOut };
  } catch (err: any) {
    const stderr =
      err?.name === "AbortError"
        ? `Command ${timedOut ? `timed out after ${opts.timeoutMs}ms` : "aborted"}`
        : err?.message || String(err);
    return { exitCode: -1, stdout: "", stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

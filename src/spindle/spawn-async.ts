/**
 * Async wrapper around Bun.spawn() that mirrors the Bun.spawnSync result
 * shape ({ exitCode, stdout, stderr }) but does NOT block the event loop
 * while the subprocess runs.
 *
 * Bun.spawnSync holds the JS event loop for the entire subprocess duration —
 * fine for short-lived commands, but for `git pull`, `bun install`, and
 * `bun build` it blocks the HTTP server from accepting requests. Use this
 * helper on any spawn that shells out to a network- or disk-heavy binary.
 *
 * Stability notes (Bun 1.3.x):
 *   - We use `Bun.readableStreamToText` (the documented, direct Bun API)
 *     instead of `new Response(stream).text()`; the latter has shown races
 *     with Bun's internal stream cleanup under load.
 *   - `stdin: "ignore"` prevents the child from inheriting our stdin; some
 *     build tools probe stdin and that probe has been implicated in
 *     subprocess-cleanup segfaults.
 *   - We only attach an AbortController when `timeoutMs` is actually set;
 *     attaching an unused signal has been linked to cleanup races.
 */

export interface SpawnAsyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnAsyncOptions {
  cwd?: string;
  /** Abort the subprocess after this many ms. Returns exitCode !== 0. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /**
   * Discard stdout instead of capturing. Use for commands where we only
   * care about the exit code (e.g. `git checkout .`, `git clean -fd`).
   * Reduces pipe setup + buffering overhead.
   */
  ignoreStdout?: boolean;
}

export async function spawnAsync(
  cmd: string[],
  opts: SpawnAsyncOptions = {}
): Promise<SpawnAsyncResult> {
  const hasTimeout = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0;
  const controller = hasTimeout ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined;

  // Only attach signal when a timeout actually exists — passing an unused
  // signal has shown cleanup-path instability in Bun 1.3.x.
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
    // Start draining streams immediately so the child's pipe buffers don't
    // fill and cause a write-side deadlock for verbose commands like
    // `bun install`. Race them against proc.exited so we always return
    // once the child is gone.
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

    return { exitCode: exitCode ?? -1, stdout, stderr };
  } catch (err: any) {
    const stderr =
      err?.name === "AbortError"
        ? `Command timed out after ${opts.timeoutMs}ms`
        : err?.message || String(err);
    return { exitCode: -1, stdout: "", stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

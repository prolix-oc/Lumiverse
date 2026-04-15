/**
 * Async wrapper around Bun.spawn() that mirrors the Bun.spawnSync result
 * shape ({ exitCode, stdout, stderr }) but does NOT block the event loop
 * while the subprocess runs.
 *
 * Bun.spawnSync holds the JS event loop for the entire subprocess duration —
 * fine for short-lived commands, but for `git pull`, `bun install`, and
 * `bun build` it blocks the HTTP server from accepting requests. Use this
 * helper on any spawn that shells out to a network- or disk-heavy binary.
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
}

export async function spawnAsync(
  cmd: string[],
  opts: SpawnAsyncOptions = {}
): Promise<SpawnAsyncResult> {
  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined;

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: controller?.signal,
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode: exitCode ?? -1, stdout, stderr };
  } catch (err: any) {
    // AbortError from timeout — surface as a non-zero exit with stderr
    const stderr =
      err?.name === "AbortError"
        ? `Command timed out after ${opts.timeoutMs}ms`
        : err?.message || String(err);
    return { exitCode: -1, stdout: "", stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

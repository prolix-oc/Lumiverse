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
 *   - We drain streams through their readers so a timed-out command can
 *     cancel those reads. A child process such as Git's HTTP transport can
 *     outlive its parent while retaining stdout/stderr, and waiting for an
 *     inherited pipe to close would otherwise defeat the timeout.
 *   - `stdin: "ignore"` prevents the child from inheriting our stdin; some
 *     build tools probe stdin and that probe has been implicated in
 *     subprocess-cleanup segfaults.
 *   - Use Bun's native `timeout` support instead of driving cancellation
 *     through an AbortController. Bun owns the subprocess lifecycle, so its
 *     timeout reliably kills a child that is stalled on network I/O.
 */

export interface SpawnAsyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the process was aborted due to timeoutMs. */
  timedOut: boolean;
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

interface StreamDrain {
  text: Promise<string>;
  cancel(): Promise<void>;
}

function startStreamDrain(
  stream: ReadableStream<Uint8Array> | null | undefined
): StreamDrain {
  if (!stream) {
    return {
      text: Promise.resolve(""),
      cancel: async () => {},
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let output = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) output += decoder.decode(value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    text,
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // The read may have completed and released its lock before timeout.
      }
    },
  };
}

export async function spawnAsync(
  cmd: string[],
  opts: SpawnAsyncOptions = {}
): Promise<SpawnAsyncResult> {
  const hasTimeout = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0;

  // Bun enforces this deadline in its subprocess implementation. This is
  // important for network commands such as `git pull`: a JS-side abort can
  // leave a stalled child alive on older Bun releases.
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: opts.ignoreStdout ? "ignore" : "pipe",
    stderr: "pipe",
    ...(hasTimeout ? { timeout: opts.timeoutMs } : {}),
  });

  try {
    // Start draining streams immediately so the child's pipe buffers don't
    // fill and cause a write-side deadlock for verbose commands like
    // `bun install`.
    const stdout = opts.ignoreStdout
      ? startStreamDrain(undefined)
      : startStreamDrain(proc.stdout as ReadableStream<Uint8Array> | null);
    const stderr = startStreamDrain(
      proc.stderr as ReadableStream<Uint8Array> | null
    );
    const exitCode = await proc.exited;

    if (hasTimeout && proc.killed) {
      // Killing the direct child does not guarantee that its descendants have
      // released inherited output pipes. Close our read ends and return now,
      // so a dead or private remote cannot stall the next bulk update.
      await Promise.all([stdout.cancel(), stderr.cancel()]);
      void Promise.allSettled([stdout.text, stderr.text]);
      return {
        exitCode: exitCode ?? -1,
        stdout: "",
        stderr: `Command timed out after ${opts.timeoutMs}ms`,
        timedOut: true,
      };
    }

    const [stdoutText, stderrText] = await Promise.all([stdout.text, stderr.text]);

    return {
      exitCode: exitCode ?? -1,
      stdout: stdoutText,
      stderr: stderrText,
      timedOut: false,
    };
  } catch (err: any) {
    const stderr =
      hasTimeout && proc.killed
        ? `Command timed out after ${opts.timeoutMs}ms`
        : err?.message || String(err);
    return {
      exitCode: -1,
      stdout: "",
      stderr,
      timedOut: hasTimeout && proc.killed,
    };
  }
}

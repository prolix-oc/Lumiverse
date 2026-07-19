/**
 * Async Bun.spawn wrapper used by the runner for git / bun / build commands.
 *
 * Adds:
 *   - Mandatory timeout support — Bun owns the timeout and terminates the
 *     subprocess instead of leaving a JS AbortController to race its cleanup.
 *     `git pull`, `bun install`, and `bun run build` have no native way to
 *     self-cancel on a hung network or stuck build pipeline; without a
 *     timeout, a single bad subprocess freezes the branch-switch / update
 *     flow indefinitely.
 *   - Concurrent, cancellable stream draining — pipe buffers don't fill
 *     during verbose output, and an inherited pipe held by a descendant can't
 *     keep a timed-out command from returning.
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

const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;

interface StreamDrain {
  text: Promise<string>;
  snapshot(): string;
  cancel(): Promise<void>;
}

function appendOutput(output: string, chunk: string): string {
  const combined = output + chunk;
  return combined.length > MAX_CAPTURED_OUTPUT_CHARS
    ? combined.slice(-MAX_CAPTURED_OUTPUT_CHARS)
    : combined;
}

function startStreamDrain(
  stream: ReadableStream<Uint8Array> | null | undefined,
): StreamDrain {
  if (!stream) {
    return {
      text: Promise.resolve(""),
      snapshot: () => "",
      cancel: async () => {},
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const text = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) output = appendOutput(output, decoder.decode(value, { stream: true }));
      }
      output = appendOutput(output, decoder.decode());
      return output;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    text,
    snapshot: () => output,
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

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: opts.ignoreStdout ? "ignore" : "pipe",
    stderr: "pipe",
    ...(hasTimeout ? { timeout: opts.timeoutMs } : {}),
  });

  let stdout: StreamDrain | undefined;
  let stderr: StreamDrain | undefined;

  try {
    // Start draining immediately. A verbose installer must never block on a
    // full pipe, and readers can be cancelled if a descendant holds one open
    // after Bun has killed the direct child at its timeout.
    stdout = opts.ignoreStdout
      ? startStreamDrain(undefined)
      : startStreamDrain(proc.stdout as ReadableStream<Uint8Array> | null);
    stderr = startStreamDrain(proc.stderr as ReadableStream<Uint8Array> | null);
    const exitCode = await proc.exited;

    if (hasTimeout && proc.killed) {
      await Promise.all([stdout.cancel(), stderr.cancel()]);
      void Promise.allSettled([stdout.text, stderr.text]);
      return {
        exitCode: exitCode ?? -1,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        timedOut: true,
      };
    }

    const [stdoutText, stderrText] = await Promise.all([stdout.text, stderr.text]);
    return { exitCode: exitCode ?? -1, stdout: stdoutText, stderr: stderrText, timedOut: false };
  } catch (err: any) {
    const timedOut = hasTimeout && proc.killed;
    const stderrMessage =
      timedOut
        ? stderr?.snapshot() ?? ""
        : err?.message || String(err);
    return {
      exitCode: -1,
      stdout: stdout?.snapshot() ?? "",
      stderr: stderrMessage,
      timedOut,
    };
  }
}

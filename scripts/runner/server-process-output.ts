export type ServerOutputStream = "stdout" | "stderr";

/**
 * Output ownership is part of the process-launch contract.
 *
 * A piped launch gives the runner Web ReadableStreams that it must drain.
 * An inherited launch has already connected the child to an OS descriptor;
 * Bun may expose that descriptor as a number, not as a readable stream.
 */
export type ServerProcessOutput =
  | {
      kind: "piped";
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
    }
  | { kind: "inherited" };

export type ServerOutputWriter = (chunk: Uint8Array, stream: ServerOutputStream) => void;

async function drainStream(
  stream: ReadableStream<Uint8Array>,
  name: ServerOutputStream,
  write: ServerOutputWriter,
  signal?: AbortSignal,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writerAvailable = true;
  const cancelReader = (): void => {
    void reader?.cancel().catch(() => {});
  };
  try {
    reader = stream.getReader();
    signal?.addEventListener("abort", cancelReader, { once: true });
    if (signal?.aborted) {
      await reader.cancel();
      return;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      if (writerAvailable) {
        try {
          write(value, name);
        } catch {
          // A supervisor may close its log destination before the child exits.
          // Keep draining and discard later chunks so the child cannot block on
          // a full pipe while shutdown is in progress.
          writerAvailable = false;
        }
      }
    }
  } catch {
    // The process or its supervisor closed the stream.
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader?.releaseLock();
    } catch {
      // The stream may have invalidated its reader while closing.
    }
  }
}

/**
 * Drain output only when the launcher explicitly transferred pipe ownership.
 * Returning a promise makes this boundary directly testable; callers that own
 * the process lifecycle may intentionally run it in the background.
 */
export async function forwardServerOutput(
  output: ServerProcessOutput,
  write: ServerOutputWriter,
  signal?: AbortSignal,
): Promise<void> {
  if (output.kind === "inherited") return;
  await Promise.all([
    drainStream(output.stdout, "stdout", write, signal),
    drainStream(output.stderr, "stderr", write, signal),
  ]);
}

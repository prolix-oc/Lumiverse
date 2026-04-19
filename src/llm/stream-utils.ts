// Workaround for Bun v1.3.x on Windows: passing an AbortSignal to fetch()
// and letting Bun cancel the resulting ReadableStream mid-read triggers an
// internal assertion failure on the main thread, crashing the process. Instead
// of wiring the signal through fetch(), streaming providers omit the signal
// from the fetch call and poll for abort via this helper. Teardown stays in
// user-space through an explicit reader.cancel() in the caller's finally.
export async function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted) return { done: true, value: undefined };
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
        } else {
          reject(err);
        }
      }
    );
  });
}

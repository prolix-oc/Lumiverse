/**
 * Windows can briefly deny a directory rename while Explorer, a virus scanner,
 * or an indexed file handle is releasing it. Retry only those known transient
 * failures, and only on Windows, so POSIX error handling stays unchanged.
 */
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export const WINDOWS_RENAME_RETRY_ATTEMPTS = 8;
const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 1_000;

type RetryOptions = {
  platform?: NodeJS.Platform;
  sleep?: (milliseconds: number) => Promise<void>;
};

function isTransientWindowsRenameError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && TRANSIENT_WINDOWS_RENAME_CODES.has(error.code);
}

function retryDelayMs(attempt: number): number {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/** Run a filesystem rename operation, retrying transient Windows lock errors. */
export async function retryWindowsRename<T>(
  operation: () => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  if ((options.platform ?? process.platform) !== "win32") return operation();

  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsRenameError(error) || attempt >= WINDOWS_RENAME_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
}

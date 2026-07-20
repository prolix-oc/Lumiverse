import { mkdirSync, statSync, type Stats } from "node:fs";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function inspectDirectory(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[startup] Cannot inspect DATA_DIR "${path}": ${detail}`, { cause: error });
  }
}

function assertDirectory(path: string, stats: Stats): void {
  if (stats.isDirectory()) return;

  throw new Error(
    `[startup] DATA_DIR "${path}" already exists but is not a directory. `
      + "Move or rename that file, or set DATA_DIR to a different folder.",
  );
}

/**
 * Ensures a data directory exists without attempting to recreate one that is
 * already present. A final inspection also makes a concurrent create safe.
 */
export function ensureDataDirectory(path: string): void {
  const existing = inspectDirectory(path);
  if (existing) {
    assertDirectory(path, existing);
    return;
  }

  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    // Another process may have created the entry after the inspection above.
    // Verify its type below instead of reporting a misleading EEXIST error.
    if (errorCode(error) !== "EEXIST") {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[startup] Cannot create DATA_DIR "${path}": ${detail}`, { cause: error });
    }
  }

  const created = inspectDirectory(path);
  if (!created) {
    throw new Error(`[startup] DATA_DIR "${path}" disappeared while it was being created.`);
  }
  assertDirectory(path, created);
}

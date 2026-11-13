/**
 * Optional byte-range capability for FileSystem providers.
 *
 * The ST gallery audit reads only PNG header/chunk bytes instead of whole
 * files, so it needs positioned reads that do not materialize the full file.
 * Providers that cannot seek (or callers that do not have a FileSystem at all)
 * fall back to readFile + slice via `readFileRange`.
 */

import type { FileSystem } from "./types";

export interface RangeCapableFileSystem extends FileSystem {
  /** Read `length` bytes at absolute `offset`. Returns a short buffer at EOF. */
  readRange(path: string, offset: number, length: number): Promise<Buffer>;
}

export function supportsRange(fs: FileSystem): fs is RangeCapableFileSystem {
  return typeof (fs as Partial<RangeCapableFileSystem>).readRange === "function";
}

/**
 * Read a byte range from any FileSystem. Uses the provider's positioned read
 * when available, otherwise reads the whole file and slices (correct, but the
 * caller pays full-file cost).
 */
export async function readFileRange(
  fs: FileSystem,
  path: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (supportsRange(fs)) {
    return fs.readRange(path, offset, length);
  }
  const whole = await fs.readFile(path);
  return whole.subarray(offset, offset + length);
}

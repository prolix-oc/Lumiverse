/**
 * Local filesystem provider — wraps Node/Bun fs APIs behind the FileSystem
 * interface. This is the default provider and the backwards-compatible path
 * for all existing migration code.
 */

import { access, readdir, stat } from "fs/promises";
import { join, dirname, basename, extname } from "path";
import type { FileSystem, FileEntry, FileStat } from "../types";

export class LocalFileSystem implements FileSystem {
  readonly type = "local" as const;

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const s = await stat(path);
    const birthSec = s.birthtimeMs > 0 ? Math.floor(s.birthtimeMs / 1000) : undefined;
    return {
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.size,
      modifiedAt: Math.floor(s.mtimeMs / 1000),
      createdAt: birthSec,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    // Dirent metadata is enough for every migration directory scan. Avoiding a
    // synchronous stat for every child keeps directories with 30K+ cards from
    // blocking the HTTP/WebSocket event loop for seconds at a time.
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      // Directory enumeration does not expose size. Call stat() only in flows
      // that actually need it instead of penalizing every scan.
      size: 0,
    }));
  }

  async readFile(path: string): Promise<Buffer> {
    return Buffer.from(await Bun.file(path).arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return await Bun.file(path).text();
  }

  join(...parts: string[]): string {
    return join(...parts);
  }

  dirname(path: string): string {
    return dirname(path);
  }

  basename(path: string, ext?: string): string {
    return ext ? basename(path, ext) : basename(path);
  }

  extname(path: string): string {
    return extname(path);
  }
}

/**
 * Local filesystem provider — wraps Node/Bun fs APIs behind the FileSystem
 * interface. This is the default provider and the backwards-compatible path
 * for all existing migration code.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
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
    return existsSync(path);
  }

  async stat(path: string): Promise<FileStat> {
    const s = statSync(path);
    return {
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.size,
      modifiedAt: Math.floor(s.mtimeMs / 1000),
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const names = readdirSync(path);
    const entries: FileEntry[] = [];

    for (const name of names) {
      try {
        const full = join(path, name);
        const s = statSync(full);
        entries.push({
          name,
          isDirectory: s.isDirectory(),
          isFile: s.isFile(),
          size: s.size,
        });
      } catch {
        // skip inaccessible entries
      }
    }

    return entries;
  }

  async readFile(path: string): Promise<Buffer> {
    return readFileSync(path);
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

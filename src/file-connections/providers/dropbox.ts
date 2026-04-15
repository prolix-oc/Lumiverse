/**
 * Dropbox filesystem provider — uses the Dropbox API v2 via raw fetch.
 *
 * Dropbox uses real paths (e.g. "/SillyTavern/data/default-user") so
 * there's no ID resolution needed — paths map directly to our FileSystem
 * interface.
 */

import { posix } from "path";
import type { FileSystem, FileEntry, FileStat, DropboxConnectionConfig } from "../types";
import { readResponseBuffer, MAX_REMOTE_FILE_BYTES } from "../remote-fetch-cap";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

export class DropboxFileSystem implements FileSystem {
  readonly type = "dropbox" as const;
  private accessToken: string;

  constructor(config: DropboxConnectionConfig) {
    this.accessToken = config.accessToken;
  }

  async connect(): Promise<void> {
    // Verify token works
    const res = await this.apiPost("/users/get_current_account", null);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Dropbox auth failed: ${body}`);
    }
  }

  async disconnect(): Promise<void> {
    // no-op — stateless
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.getMetadata(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const meta = await this.getMetadata(path);
    const isDir = meta[".tag"] === "folder";
    return {
      isDirectory: isDir,
      isFile: !isDir,
      size: meta.size ?? 0,
      modifiedAt: meta.server_modified
        ? Math.floor(new Date(meta.server_modified).getTime() / 1000)
        : undefined,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const dbxPath = this.toDbxPath(path);
    const entries: FileEntry[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    // Initial request
    const firstRes = await this.apiPost("/files/list_folder", {
      path: dbxPath,
      limit: 2000,
    });
    if (!firstRes.ok) throw new Error(`Failed to list: ${path}`);
    let data = await firstRes.json();

    for (const entry of data.entries) {
      entries.push(this.toFileEntry(entry));
    }
    hasMore = data.has_more;
    cursor = data.cursor;

    // Paginate
    while (hasMore && cursor) {
      const contRes = await this.apiPost("/files/list_folder/continue", { cursor });
      if (!contRes.ok) break;
      data = await contRes.json();
      for (const entry of data.entries) {
        entries.push(this.toFileEntry(entry));
      }
      hasMore = data.has_more;
      cursor = data.cursor;
    }

    return entries;
  }

  async readFile(path: string): Promise<Buffer> {
    const dbxPath = this.toDbxPath(path);
    const res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: dbxPath }),
      },
    });
    if (!res.ok) throw new Error(`Failed to download: ${path}`);
    return readResponseBuffer(res, MAX_REMOTE_FILE_BYTES, path);
  }

  async readText(path: string): Promise<string> {
    const buf = await this.readFile(path);
    return buf.toString("utf-8");
  }

  // ─── Path operations ──────────────────────────────────────────────────

  join(...parts: string[]): string {
    return posix.join(...parts);
  }

  dirname(path: string): string {
    return posix.dirname(path);
  }

  basename(path: string, ext?: string): string {
    return ext ? posix.basename(path, ext) : posix.basename(path);
  }

  extname(path: string): string {
    return posix.extname(path);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /** Dropbox paths must start with / or be empty string for root */
  private toDbxPath(path: string): string {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    return normalized ? `/${normalized}` : "";
  }

  private async getMetadata(path: string): Promise<any> {
    const dbxPath = this.toDbxPath(path);
    const res = await this.apiPost("/files/get_metadata", {
      path: dbxPath || "/",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Metadata failed for ${path}: ${body}`);
    }
    return res.json();
  }

  private toFileEntry(entry: any): FileEntry {
    const isDir = entry[".tag"] === "folder";
    return {
      name: entry.name,
      isDirectory: isDir,
      isFile: !isDir,
      size: entry.size ?? 0,
    };
  }

  private apiPost(endpoint: string, body: any): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    // Only set Content-Type and body when there's actual data to send.
    // Dropbox rejects the JSON content-type header on endpoints that
    // don't accept a body (e.g. users/get_current_account).
    if (body !== null) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  }
}

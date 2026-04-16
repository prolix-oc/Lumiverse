/**
 * Google Drive filesystem provider — uses the Drive API v3 via raw fetch.
 *
 * Paths are virtual: "My Drive/SillyTavern/data/default-user". Each path
 * segment is resolved to a Drive file ID by walking the tree. The root
 * "My Drive" maps to the special ID "root".
 *
 * No SDK dependency — just fetch + Bearer token.
 */

import { posix } from "path";
import type { FileSystem, FileEntry, FileStat, GoogleDriveConnectionConfig } from "../types";
import { readResponseBuffer, MAX_REMOTE_FILE_BYTES } from "../remote-fetch-cap";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

export class GoogleDriveFileSystem implements FileSystem {
  readonly type = "google-drive" as const;
  private accessToken: string;

  /** Cache of resolved path → file ID to avoid redundant API calls */
  private idCache = new Map<string, string>();

  constructor(config: GoogleDriveConnectionConfig) {
    this.accessToken = config.accessToken;
    this.idCache.set("", "root");
    this.idCache.set("/", "root");
  }

  async connect(): Promise<void> {
    // Verify token works by listing root
    const res = await this.driveGet("/files", {
      q: "'root' in parents",
      pageSize: "1",
      fields: "files(id)",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Drive auth failed: ${body}`);
    }
  }

  async disconnect(): Promise<void> {
    // no-op — token-based, stateless
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveId(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const id = await this.resolveId(path);
    const res = await this.driveGet(`/files/${id}`, {
      fields: "id,name,mimeType,size,modifiedTime",
    });
    if (!res.ok) throw new Error(`Failed to stat: ${path}`);
    const file: DriveFile = await res.json();

    const isDir = file.mimeType === FOLDER_MIME;
    return {
      isDirectory: isDir,
      isFile: !isDir,
      size: file.size ? parseInt(file.size, 10) : 0,
      modifiedAt: file.modifiedTime
        ? Math.floor(new Date(file.modifiedTime).getTime() / 1000)
        : undefined,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const folderId = await this.resolveId(path);
    const entries: FileEntry[] = [];
    let pageToken: string | undefined;

    do {
      const params: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size)",
        pageSize: "1000",
        orderBy: "folder,name",
      };
      if (pageToken) params.pageToken = pageToken;

      const res = await this.driveGet("/files", params);
      if (!res.ok) throw new Error(`Failed to list: ${path}`);

      const data = await res.json();
      for (const file of data.files as DriveFile[]) {
        const isDir = file.mimeType === FOLDER_MIME;
        entries.push({
          name: file.name,
          isDirectory: isDir,
          isFile: !isDir,
          size: file.size ? parseInt(file.size, 10) : 0,
        });
        // Cache child IDs for future resolution
        const childPath = path ? `${this.normalizePath(path)}/${file.name}` : file.name;
        this.idCache.set(childPath, file.id);
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return entries;
  }

  async readFile(path: string): Promise<Buffer> {
    const id = await this.resolveId(path);
    const res = await this.driveGet(`/files/${id}`, { alt: "media" });
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

  private normalizePath(path: string): string {
    return path.replace(/^\/+|\/+$/g, "");
  }

  /**
   * Resolve a virtual path like "SillyTavern/data/default-user" to a
   * Google Drive file ID by walking each segment.
   */
  private async resolveId(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    if (!normalized || normalized === "/") return "root";

    // Check cache
    const cached = this.idCache.get(normalized);
    if (cached) return cached;

    // Walk path segments
    const segments = normalized.split("/");
    let parentId = "root";
    let resolvedSoFar = "";

    for (const segment of segments) {
      resolvedSoFar = resolvedSoFar ? `${resolvedSoFar}/${segment}` : segment;

      const cachedSegment = this.idCache.get(resolvedSoFar);
      if (cachedSegment) {
        parentId = cachedSegment;
        continue;
      }

      // Query Drive for this child in the parent
      const escapedName = segment.replace(/'/g, "\\'");
      const res = await this.driveGet("/files", {
        q: `'${parentId}' in parents and name = '${escapedName}' and trashed = false`,
        fields: "files(id,name,mimeType)",
        pageSize: "1",
      });

      if (!res.ok) throw new Error(`Failed to resolve path: ${resolvedSoFar}`);
      const data = await res.json();

      if (!data.files || data.files.length === 0) {
        throw new Error(`Not found: ${resolvedSoFar}`);
      }

      parentId = data.files[0].id;
      this.idCache.set(resolvedSoFar, parentId);
    }

    return parentId;
  }

  private driveGet(endpoint: string, params: Record<string, string>): Promise<Response> {
    const url = new URL(`${DRIVE_API}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    return fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
  }
}

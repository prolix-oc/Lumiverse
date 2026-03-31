/**
 * SFTP filesystem provider — uses ssh2-sftp-client for SSH file transfer.
 * Supports password and private-key authentication.
 */

import SFTPClient from "ssh2-sftp-client";
import { posix } from "path";
import type { FileSystem, FileEntry, FileStat, SFTPConnectionConfig } from "../types";

export class SFTPFileSystem implements FileSystem {
  readonly type = "sftp" as const;
  private client: SFTPClient;
  private config: SFTPConnectionConfig;

  constructor(config: SFTPConnectionConfig) {
    this.config = config;
    this.client = new SFTPClient();
  }

  async connect(): Promise<void> {
    const connectConfig: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port ?? 22,
      username: this.config.username,
    };

    if (this.config.privateKey) {
      connectConfig.privateKey = this.config.privateKey;
      if (this.config.passphrase) {
        connectConfig.passphrase = this.config.passphrase;
      }
    } else if (this.config.password) {
      connectConfig.password = this.config.password;
    }

    await this.client.connect(connectConfig);
  }

  async disconnect(): Promise<void> {
    await this.client.end();
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.client.exists(path);
    return result !== false;
  }

  async stat(path: string): Promise<FileStat> {
    const s = await this.client.stat(path);
    return {
      isDirectory: s.isDirectory,
      isFile: !s.isDirectory,
      size: s.size,
      modifiedAt: s.modifyTime ? Math.floor(s.modifyTime / 1000) : undefined,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const listing = await this.client.list(path);
    return listing.map((item) => ({
      name: item.name,
      isDirectory: item.type === "d",
      isFile: item.type === "-",
      size: item.size,
    }));
  }

  async readFile(path: string): Promise<Buffer> {
    // ssh2-sftp-client.get() returns Buffer when no destination is given
    const data = await this.client.get(path) as unknown;
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === "string") return Buffer.from(data);
    // Shouldn't reach here without a dst argument, but handle gracefully
    return Buffer.from(data as ArrayBuffer);
  }

  async readText(path: string): Promise<string> {
    const buf = await this.readFile(path);
    return buf.toString("utf-8");
  }

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
}

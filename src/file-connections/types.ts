/**
 * FileSystem abstraction for remote and local file access.
 *
 * Provides a unified interface used by the migration pipeline (and future
 * features like backups) so callers don't care whether the source is a local
 * directory, an SFTP server, or an SMB share.
 */

// ─── FileSystem interface ──────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modifiedAt?: number; // unix epoch seconds
}

export interface FileSystem {
  /** Human-readable provider name (e.g. "local", "sftp", "smb") */
  readonly type: string;

  /** Open the connection (no-op for local) */
  connect(): Promise<void>;

  /** Close the connection (no-op for local) */
  disconnect(): Promise<void>;

  /** Check whether a path exists */
  exists(path: string): Promise<boolean>;

  /** Get file/directory metadata */
  stat(path: string): Promise<FileStat>;

  /** List entries in a directory */
  readdir(path: string): Promise<FileEntry[]>;

  /** Read a file into a Buffer */
  readFile(path: string): Promise<Buffer>;

  /** Read a file as UTF-8 text (convenience) */
  readText(path: string): Promise<string>;

  /** Join path segments using the provider's separator */
  join(...parts: string[]): string;

  /** Get the directory portion of a path */
  dirname(path: string): string;

  /** Get the filename portion of a path */
  basename(path: string, ext?: string): string;

  /** Get the file extension */
  extname(path: string): string;
}

// ─── Connection configs ────────────────────────────────────────────────────

export interface LocalConnectionConfig {
  type: "local";
}

export interface SFTPConnectionConfig {
  type: "sftp";
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** PEM-encoded private key string */
  privateKey?: string;
  /** Passphrase for encrypted private keys */
  passphrase?: string;
}

export interface SMBConnectionConfig {
  type: "smb";
  host: string;
  /** Share name (e.g. "shared", "backups") */
  share: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
}

export type FileConnectionConfig =
  | LocalConnectionConfig
  | SFTPConnectionConfig
  | SMBConnectionConfig;

export type FileConnectionType = FileConnectionConfig["type"];

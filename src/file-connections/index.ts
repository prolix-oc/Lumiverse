export type {
  FileSystem,
  FileEntry,
  FileStat,
  FileConnectionConfig,
  FileConnectionType,
  LocalConnectionConfig,
  SFTPConnectionConfig,
  SMBConnectionConfig,
  GoogleDriveConnectionConfig,
  DropboxConnectionConfig,
} from "./types";

export { LocalFileSystem } from "./providers/local";
export {
  createFileSystem,
  openFileSystem,
  withFileSystem,
  getAvailableConnectionTypes,
} from "./factory";

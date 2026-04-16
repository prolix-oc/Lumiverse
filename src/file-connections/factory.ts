/**
 * Factory for creating FileSystem instances from connection configs.
 *
 * Provider availability is probed at runtime:
 *   - SFTP: checks that ssh2-sftp-client can be imported
 *   - SMB: checks that the `smbclient` binary exists on PATH
 */

import type { FileConnectionConfig, FileConnectionType, FileSystem } from "./types";
import { LocalFileSystem } from "./providers/local";

// ─── Provider availability probing ─────────────────────────────────────────

/** Cache: undefined = not probed, true/false = result */
const availabilityCache = new Map<string, boolean>();

async function probeSftp(): Promise<boolean> {
  try {
    await import("./providers/sftp");
    return true;
  } catch {
    return false;
  }
}

async function probeSmb(): Promise<boolean> {
  try {
    const { isSmbClientAvailable } = await import("./providers/smb");
    return isSmbClientAvailable();
  } catch {
    return false;
  }
}

async function probeGoogleDrive(): Promise<boolean> {
  return true; // pure fetch, always available
}

async function probeDropbox(): Promise<boolean> {
  return true; // pure fetch, always available
}

const probes: Record<string, () => Promise<boolean>> = {
  sftp: probeSftp,
  smb: probeSmb,
  "google-drive": probeGoogleDrive,
  dropbox: probeDropbox,
};

async function isProviderAvailable(type: string): Promise<boolean> {
  if (type === "local") return true;

  const cached = availabilityCache.get(type);
  if (cached !== undefined) return cached;

  const probe = probes[type];
  if (!probe) return false;

  const available = await probe();
  availabilityCache.set(type, available);
  return available;
}

/**
 * Return the list of connection types that are actually usable on this
 * system. Called by the route layer so the frontend can hide unavailable
 * options.
 */
export async function getAvailableConnectionTypes(): Promise<FileConnectionType[]> {
  const types: FileConnectionType[] = ["local"];

  const checks = Object.keys(probes).map(async (type) => {
    if (await isProviderAvailable(type)) {
      types.push(type as FileConnectionType);
    }
  });

  await Promise.all(checks);
  return types;
}

// ─── Factory functions ─────────────────────────────────────────────────────

/**
 * Create a FileSystem from a connection config.
 * Does NOT call connect() — caller is responsible for lifecycle.
 */
export async function createFileSystem(
  config: FileConnectionConfig,
): Promise<FileSystem> {
  switch (config.type) {
    case "local":
      return new LocalFileSystem();

    case "sftp": {
      if (!(await isProviderAvailable("sftp"))) {
        throw new Error("SFTP provider is not available — ssh2-sftp-client could not be loaded.");
      }
      const { SFTPFileSystem } = await import("./providers/sftp");
      return new SFTPFileSystem(config);
    }

    case "smb": {
      if (!(await isProviderAvailable("smb"))) {
        throw new Error(
          "SMB provider is not available — smbclient is not installed. " +
          "Install the samba-client package for your OS.",
        );
      }
      const { SMBFileSystem } = await import("./providers/smb");
      return new SMBFileSystem(config);
    }

    case "google-drive": {
      const { GoogleDriveFileSystem } = await import("./providers/google-drive");
      return new GoogleDriveFileSystem(config);
    }

    case "dropbox": {
      const { DropboxFileSystem } = await import("./providers/dropbox");
      return new DropboxFileSystem(config);
    }

    default:
      throw new Error(`Unknown file connection type: ${(config as any).type}`);
  }
}

/**
 * Create, connect, and return a FileSystem ready for use.
 * Caller MUST call disconnect() when done.
 */
export async function openFileSystem(
  config: FileConnectionConfig,
): Promise<FileSystem> {
  const fs = await createFileSystem(config);
  await fs.connect();
  return fs;
}

/**
 * Run a callback with a connected FileSystem, ensuring disconnect on
 * completion or error.
 */
export async function withFileSystem<T>(
  config: FileConnectionConfig,
  fn: (fs: FileSystem) => Promise<T>,
): Promise<T> {
  const fs = await openFileSystem(config);
  try {
    return await fn(fs);
  } finally {
    await fs.disconnect();
  }
}

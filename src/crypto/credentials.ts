/**
 * Owner Credentials File
 *
 * Stores the owner's username and password hash in `data/owner.credentials`
 * so that plaintext passwords never need to appear in .env or on disk.
 *
 * The password hash is scrypt-based (salt:key hex format, see crypto/password.ts)
 * and is the same format stored in the `account` table — meaning the reset
 * script and seed logic can write directly to both locations.
 *
 * File layout: JSON
 *   { username, passwordHash, createdAt, updatedAt }
 *
 * All file I/O uses Bun-native APIs (Bun.file / Bun.write) for reliable
 * cross-platform behavior, including Termux/Android where Node's fs module
 * with explicit mode flags can fail on non-POSIX filesystems.
 */

import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface OwnerCredentials {
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Check whether the credentials file exists.
 */
export async function ownerCredentialsExist(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

/**
 * Read and parse the owner credentials file.
 * Throws on missing file or malformed JSON.
 */
export async function readOwnerCredentials(filePath: string): Promise<OwnerCredentials> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Owner credentials file not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    throw new Error(`Owner credentials file could not be read: ${err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Owner credentials file is corrupted (invalid JSON)");
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.username !== "string" ||
    typeof obj.passwordHash !== "string" ||
    typeof obj.createdAt !== "number" ||
    typeof obj.updatedAt !== "number"
  ) {
    throw new Error("Owner credentials file is malformed (missing required fields)");
  }

  return obj as unknown as OwnerCredentials;
}

/**
 * Write (create or overwrite) the owner credentials file.
 * Attempts to set file permissions to 0o600 (owner-only read/write) but
 * does not fail if the filesystem doesn't support Unix permissions.
 */
export async function writeOwnerCredentials(
  filePath: string,
  username: string,
  passwordHash: string
): Promise<OwnerCredentials> {
  const now = Math.floor(Date.now() / 1000);

  let createdAt = now;
  // Preserve original createdAt if updating an existing file
  if (await Bun.file(filePath).exists()) {
    try {
      const existing = await readOwnerCredentials(filePath);
      createdAt = existing.createdAt;
    } catch {
      // File exists but is corrupted — treat as new
    }
  }

  const credentials: OwnerCredentials = {
    username,
    passwordHash,
    createdAt,
    updatedAt: now,
  };

  mkdirSync(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(credentials, null, 2) + "\n");

  // Set restrictive permissions where the filesystem supports it.
  // Android/Termux storage and other non-POSIX filesystems may not honor chmod.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal: filesystem doesn't support Unix permissions
  }

  // Verify the write actually persisted (catches silent write failures)
  const written = Bun.file(filePath);
  if (!(await written.exists()) || written.size === 0) {
    throw new Error(
      `Failed to write credentials file — file is empty or missing after write: ${filePath}`
    );
  }

  return credentials;
}

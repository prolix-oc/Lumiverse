import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { env } from "../env";

// BetterAuth IDs are UUIDs; rejecting anything else means a future custom
// auth backend or corrupt DB row can never produce an ID that resolves
// outside the per-user data dir via path.join (which doesn't strip "..").
const USER_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Extension identifiers are validated separately at install time
// (lumiverse-spindle-types.validateIdentifier), but defend the path call
// anyway so a bug elsewhere can't leak into a traversal.
const EXTENSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

function assertUserId(userId: string): void {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error("Invalid user id");
  }
}

function assertExtensionIdentifier(identifier: string): void {
  if (!EXTENSION_ID_PATTERN.test(identifier)) {
    throw new Error("Invalid extension identifier");
  }
}

export function provisionUserDirectories(userId: string): void {
  assertUserId(userId);
  const userDir = getUserBaseDir(userId);
  const storagePath = join(userDir, "storage");
  const extensionsPath = join(userDir, "extensions");

  if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
  if (!existsSync(extensionsPath)) mkdirSync(extensionsPath, { recursive: true });
}

export function getUserBaseDir(userId: string): string {
  assertUserId(userId);
  return join(env.dataDir, "users", userId);
}

export function getUserStoragePath(userId: string): string {
  return join(getUserBaseDir(userId), "storage");
}

export function getUserExtensionPath(userId: string, identifier: string): string {
  assertExtensionIdentifier(identifier);
  return join(getUserBaseDir(userId), "extensions", identifier);
}

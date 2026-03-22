import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { env } from "../env";

export function provisionUserDirectories(userId: string): void {
  const userDir = getUserBaseDir(userId);
  const storagePath = join(userDir, "storage");
  const extensionsPath = join(userDir, "extensions");

  if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
  if (!existsSync(extensionsPath)) mkdirSync(extensionsPath, { recursive: true });
}

export function getUserBaseDir(userId: string): string {
  return join(env.dataDir, "users", userId);
}

export function getUserStoragePath(userId: string): string {
  return join(getUserBaseDir(userId), "storage");
}

export function getUserExtensionPath(userId: string, identifier: string): string {
  return join(getUserBaseDir(userId), "extensions", identifier);
}

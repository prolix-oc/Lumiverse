import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "../../env";
import { getUserBaseDir } from "../../auth/provision";
import { safeJoin, sanitizeEntry } from "./sanitize";

function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Check each account-directory component without following symbolic links. */
function accountExtensionRoot(userId: string, create: boolean): string | null {
  const root = resolve(getUserBaseDir(userId), "extensions");
  let current = resolve(env.dataDir);
  for (const part of ["users", userId, "extensions"]) {
    current = join(current, part);
    const stat = statIfPresent(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Extension storage path is not a regular directory: ${current}`);
    }
    if (!stat) {
      if (!create) return null;
      mkdirSync(current);
    }
  }
  return root;
}

/** User storage also holds regular storage for user-installed extensions. */
export async function* extensionStorageFiles(
  userId: string,
  onSkipped: (path: string) => void,
  signal?: AbortSignal,
): AsyncGenerator<{ absolutePath: string; archivePath: string }> {
  const root = accountExtensionRoot(userId, false);
  if (!root) return;
  let visited = 0;
  async function* walk(directory: string, prefix: string): AsyncGenerator<{ absolutePath: string; archivePath: string }> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.name.toLowerCase() === ".ephemeral" || /^\.lv-restore-.+\.tmp$/i.test(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const inner = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        onSkipped(absolutePath);
        continue;
      }
      if (stat.isDirectory()) yield* walk(absolutePath, inner);
      else if (stat.isFile()) {
        const archivePath = `files/extension-storage/${inner}`;
        sanitizeEntry(archivePath);
        yield { absolutePath, archivePath };
      }
      if (++visited % 256 === 0) await new Promise<void>(r => setTimeout(r, 0));
    }
  }
  yield* walk(root, "");
}

/** Restore into the target account, including extensions not yet reinstalled. */
export function extensionStorageDestination(userId: string, inner: string): string {
  sanitizeEntry(`files/extension-storage/${inner}`);
  const root = accountExtensionRoot(userId, true)!;
  const destination = safeJoin(root, inner);
  const parts = inner.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = statIfPresent(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Extension restore path is not a regular directory: ${current}`);
    }
    if (!stat) mkdirSync(current);
  }
  if (statIfPresent(destination)?.isSymbolicLink()) {
    throw new Error(`Extension restore destination is a symbolic link: ${destination}`);
  }
  return destination;
}

export function assertExtensionRestoreTemporaryFile(path: string): void {
  const stat = statIfPresent(path);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Extension restore temporary path is not a regular file: ${path}`);
  }
}

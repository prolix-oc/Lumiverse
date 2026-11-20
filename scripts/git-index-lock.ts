/** Guarded recovery for Git's temporary index.lock file. */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type GitIndexLockStatus =
  | "no-repository"
  | "absent"
  | "active"
  | "recent"
  | "changed"
  | "recovered";

export interface GitIndexLockResult {
  status: GitIndexLockStatus;
  lockPath: string | null;
}

export interface GitIndexLockRecoveryOptions {
  /** A recent lock may belong to a Git process that is just starting. */
  minimumAgeMs?: number;
  now?: number;
  hasRunningGitProcess?: () => Promise<boolean>;
}

/** Resolve both ordinary .git directories and worktree-style .git files. */
export function resolveGitIndexLock(projectRoot: string): string | null {
  const dotGit = join(projectRoot, ".git");
  if (!existsSync(dotGit)) return null;

  const dotGitStat = statSync(dotGit);
  if (dotGitStat.isDirectory()) return join(dotGit, "index.lock");
  if (!dotGitStat.isFile()) return null;

  const pointer = readFileSync(dotGit, "utf8").trim();
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  if (!match?.[1]) return null;
  const gitDir = match[1];
  return join(isAbsolute(gitDir) ? gitDir : resolve(dirname(dotGit), gitDir), "index.lock");
}

async function commandOutput(command: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const child = Bun.spawn({ cmd: command, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return { ok: exitCode === 0, output };
  } catch {
    return { ok: false, output: "" };
  }
}

/**
 * Conservatively check for any Git process on the machine. We deliberately do
 * not try to infer its working directory: process command lines often contain
 * only `git reset`/`git pull`, so a global false positive is safer than
 * deleting a live repository lock.
 */
export async function hasRunningGitProcess(targetPlatform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (targetPlatform === "win32") {
    const result = await commandOutput([
      "tasklist.exe",
      "/FI",
      "IMAGENAME eq git.exe",
      "/NH",
      "/FO",
      "CSV",
    ]);
    // Failure to inspect processes is treated as active so recovery stays safe.
    return !result.ok || /"git\.exe"/i.test(result.output);
  }

  const result = await commandOutput(["ps", "-axo", "comm="]);
  if (!result.ok) return true;
  return result.output
    .split(/\r?\n/)
    .map((entry) => basename(entry.trim()))
    .some((name) => name === "git" || name.startsWith("git-"));
}

/**
 * Remove index.lock only when it is old enough, no Git process is running,
 * and the file has not changed while those checks were taking place.
 */
export async function recoverStaleGitIndexLock(
  projectRoot: string,
  options: GitIndexLockRecoveryOptions = {},
): Promise<GitIndexLockResult> {
  const lockPath = resolveGitIndexLock(projectRoot);
  if (!lockPath) return { status: "no-repository", lockPath: null };
  if (!existsSync(lockPath)) return { status: "absent", lockPath };

  const before = statSync(lockPath);
  const minimumAgeMs = options.minimumAgeMs ?? 30_000;
  const now = options.now ?? Date.now();
  if (now - before.mtimeMs < minimumAgeMs) return { status: "recent", lockPath };

  const processCheck = options.hasRunningGitProcess ?? hasRunningGitProcess;
  if (await processCheck()) return { status: "active", lockPath };
  if (!existsSync(lockPath)) return { status: "absent", lockPath };

  const after = statSync(lockPath);
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.ino !== before.ino) {
    return { status: "changed", lockPath };
  }

  rmSync(lockPath);
  return { status: "recovered", lockPath };
}


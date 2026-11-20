import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnAsync } from "./spawn-async";

const LOCAL_GIT_INSPECTION_TIMEOUT_MS = 5_000;
const LOCAL_GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_FETCH_TIMEOUT_MS = 30_000;

function canonicalPath(path: string): string {
  const canonical = resolve(realpathSync(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function hasOwnGitMetadata(repo: string): boolean {
  return existsSync(repo) && existsSync(join(repo, ".git"));
}

function topLevelMatchesRepository(repo: string, topLevel: string): boolean {
  if (!topLevel) return false;
  try {
    return canonicalPath(topLevel) === canonicalPath(repo);
  } catch {
    return false;
  }
}

/**
 * Return true when `repo` owns the Git metadata used by commands run inside it.
 */
export function isOwnGitRepositoryPath(repo: string): boolean {
  if (!hasOwnGitMetadata(repo)) return false;

  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--show-toplevel"],
      cwd: repo,
      timeout: LOCAL_GIT_INSPECTION_TIMEOUT_MS,
      stdin: "ignore",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return false;

    const topLevel = proc.stdout.toString().trim();
    return topLevelMatchesRepository(repo, topLevel);
  } catch {
    return false;
  }
}

/**
 * Async ownership check for background work. Unlike the synchronous assertion
 * used by explicit management actions, this cannot block the Bun event loop.
 */
export async function isOwnGitRepositoryPathAsync(
  repo: string
): Promise<boolean> {
  if (!hasOwnGitMetadata(repo)) return false;

  const proc = await spawnAsync(
    ["git", "rev-parse", "--show-toplevel"],
    {
      cwd: repo,
      timeoutMs: LOCAL_GIT_INSPECTION_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    }
  );
  if (proc.exitCode !== 0) return false;
  return topLevelMatchesRepository(repo, proc.stdout.trim());
}

export function assertOwnGitRepositoryPath(repo: string, label: string): void {
  if (!isOwnGitRepositoryPath(repo)) {
    throw new Error(
      `${label} is not backed by its own Git repository; local extensions can be rebuilt in dev mode but cannot be pulled`,
    );
  }
}

async function runGitStep(
  repo: string,
  args: string[],
  label: string,
  timeoutMs: number,
  ignoreStdout = false
): Promise<string> {
  const proc = await spawnAsync(["git", ...args], {
    cwd: repo,
    timeoutMs,
    ignoreStdout,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (proc.exitCode !== 0) {
    const reason = proc.timedOut
      ? `timed out after ${timeoutMs / 1000}s`
      : proc.stderr.trim() || proc.stdout.trim() || `exit code ${proc.exitCode}`;
    throw new Error(`${label} failed: ${reason}`);
  }
  return proc.stdout.trim();
}

/**
 * Replace the checked-out branch with the newest head advertised by origin.
 * The fetch completes before any destructive command runs.
 */
export async function resetGitRepositoryToRemoteHead(
  repo: string,
  label: string
): Promise<void> {
  assertOwnGitRepositoryPath(repo, label);

  const branch = await runGitStep(
    repo,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "git symbolic-ref HEAD",
    LOCAL_GIT_COMMAND_TIMEOUT_MS
  );
  if (!branch) {
    throw new Error(`${label} has a detached HEAD`);
  }

  await runGitStep(
    repo,
    ["fetch", "--quiet", "origin", `refs/heads/${branch}`],
    `git fetch origin ${branch}`,
    GIT_FETCH_TIMEOUT_MS,
    true
  );
  await runGitStep(
    repo,
    ["reset", "--hard", "FETCH_HEAD"],
    "git reset --hard FETCH_HEAD",
    LOCAL_GIT_COMMAND_TIMEOUT_MS,
    true
  );
  await runGitStep(
    repo,
    ["clean", "-fd"],
    "git clean -fd",
    LOCAL_GIT_COMMAND_TIMEOUT_MS,
    true
  );
}

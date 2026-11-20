import { PROJECT_ROOT } from "./constants.js";

export interface GitResult {
  ok: boolean;
  out: string;
}

const GIT_WORKTREE_CACHE_MS = 60_000;

type CachedGitWorkTree = {
  value: boolean;
  expiresAt: number;
};

let cachedGitWorkTree: CachedGitWorkTree | null = null;

/**
 * Run a synchronous git command and return the result.
 * Uses Bun.spawnSync for simplicity in git operations.
 */
function runGitRaw(...args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
  };
}

export function isGitWorkTree(forceRefresh = false): boolean {
  const now = Date.now();
  if (!forceRefresh && cachedGitWorkTree && cachedGitWorkTree.expiresAt > now) {
    return cachedGitWorkTree.value;
  }

  const probe = runGitRaw("rev-parse", "--is-inside-work-tree");
  const value = probe.ok && probe.out === "true";

  cachedGitWorkTree = {
    value,
    expiresAt: now + GIT_WORKTREE_CACHE_MS,
  };

  return value;
}

export function runGit(...args: string[]): GitResult {
  if (!isGitWorkTree()) {
    return { ok: false, out: "" };
  }
  return runGitRaw(...args);
}

/**
 * Get the upstream tracking ref for the current branch.
 * Avoids `@{u}` shorthand which breaks on Windows (curly braces
 * are mangled during command-line construction on win32).
 */
export function getUpstreamRef(branchName: string): string | null {
  const upstream = runGit(
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branchName}`
  );
  if (!upstream.ok || !upstream.out) return null;
  return upstream.out;
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(): string {
  const result = runGit("rev-parse", "--abbrev-ref", "HEAD");
  return result.ok ? result.out : "";
}

import { join } from "path";
import { existsSync, rmSync } from "fs";
import { runGit, getUpstreamRef, getCurrentBranch } from "./lib/git.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_GIT_FETCH_MS,
  TIMEOUT_GIT_PULL_MS,
  TIMEOUT_GIT_CHECKOUT_MS,
  TIMEOUT_BUN_INSTALL_MS,
  TIMEOUT_BUN_BUILD_MS,
} from "./lib/constants.js";
import { spawnAsync } from "./lib/spawn-async.js";

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}

type ProgressReporter = (message: string) => void;

const FRONTEND_BUILD_IGNORED_PATHS = [
  "frontend/dist/",
];

const FRONTEND_BUILD_IGNORED_FILES = new Set([
  "frontend/tsconfig.tsbuildinfo",
]);

function log(text: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] [runner] ${text}`);
}

function getHeadRef(): string {
  const head = runGit("rev-parse", "HEAD");
  if (!head.ok || !head.out) {
    throw new Error("Unable to resolve current git HEAD");
  }
  return head.out;
}

function getChangedFilesBetween(fromRef: string, toRef: string): string[] {
  if (fromRef === toRef) return [];
  const diff = runGit("diff", "--name-only", `${fromRef}..${toRef}`);
  if (!diff.ok || !diff.out) return [];
  return diff.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isFrontendBuildInput(filePath: string): boolean {
  if (!filePath.startsWith("frontend/")) return false;
  if (FRONTEND_BUILD_IGNORED_FILES.has(filePath)) return false;
  return !FRONTEND_BUILD_IGNORED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

function shouldRebuildFrontend(changedFiles: string[]): boolean {
  return changedFiles.some(isFrontendBuildInput);
}

// Termux/proot detection. start.sh exports LUMIVERSE_IS_TERMUX /
// LUMIVERSE_IS_PROOT before launching the runner so we can mirror its
// install-time workarounds (copyfile backend, pre-install cache flush) on
// the operator-panel-driven update + branch-switch + rebuild paths.
function isTermuxRuntime(): boolean {
  return process.env.LUMIVERSE_IS_TERMUX === "true";
}

function isProotRuntime(): boolean {
  return process.env.LUMIVERSE_IS_PROOT === "true";
}

function bunInstallCmd(): string[] {
  if (isTermuxRuntime() || isProotRuntime()) {
    // Android filesystem emulation can't hardlink — copyfile is the only
    // backend that reliably installs without "Cannot find package" corruption.
    return ["bun", "install", "--backend=copyfile"];
  }
  return ["bun", "install"];
}

function clearBunInstallCacheIfTermux(): void {
  if (!isTermuxRuntime() && !isProotRuntime()) return;
  const cacheDir = join(process.env.HOME ?? "", ".bun/install/cache");
  if (cacheDir && existsSync(cacheDir)) {
    try { rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  }
}

function summarizeFrontendChanges(changedFiles: string[]): string {
  const relevant = changedFiles.filter(isFrontendBuildInput);
  if (relevant.length === 0) return "";
  const preview = relevant.slice(0, 5).join(", ");
  return relevant.length > 5 ? `${preview}, ...` : preview;
}

async function runCommandOrThrow(
  cmd: string[],
  opts: { cwd: string; timeoutMs: number; label: string }
): Promise<void> {
  const result = await spawnAsync(cmd, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });

  if (result.exitCode === 0) return;

  const reason = result.timedOut
    ? `${opts.label} timed out after ${opts.timeoutMs / 1000}s`
    : result.stderr.trim() || result.stdout.trim() || `${opts.label} failed`;
  throw new Error(reason);
}

/**
 * Run git fetch and check how many commits we're behind upstream.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const remote = runGit("remote");
  if (!remote.ok || !remote.out) {
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  // Bounded fetch — a dead remote must not stall the periodic update check.
  const fetch = await spawnAsync(["git", "fetch", "--quiet"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_FETCH_MS,
    ignoreStdout: true,
  });
  if (fetch.exitCode !== 0) {
    if (fetch.timedOut) log("Update check: git fetch timed out.");
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  const branch = getCurrentBranch();
  if (!branch) return { available: false, commitsBehind: 0, latestMessage: "" };

  const upstream = getUpstreamRef(branch);
  if (!upstream) return { available: false, commitsBehind: 0, latestMessage: "" };

  const revList = runGit("rev-list", "--count", `HEAD..${upstream}`);
  if (!revList.ok) return { available: false, commitsBehind: 0, latestMessage: "" };

  const behind = parseInt(revList.out, 10);
  if (behind > 0) {
    const logMsg = runGit("log", "--format=%s", "-1", upstream);
    const latestMessage = logMsg.ok ? logMsg.out : "";
    log(`Update available: ${behind} commit${behind > 1 ? "s" : ""} behind`);
    return { available: true, commitsBehind: behind, latestMessage };
  }

  return { available: false, commitsBehind: 0, latestMessage: "" };
}

/**
 * Apply update: stash → clear cache → delete dist → pull → install deps →
 * conditional frontend build → restart
 */
export async function applyUpdate(
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>,
  reportProgress?: ProgressReporter,
): Promise<void> {
  log("Preparing update...");
  const previousHead = getHeadRef();

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", "lumiverse-runner-auto-stash");
  }

  // Stop server before destructive operations
  await stopServer();

  // Clear Bun transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist to prevent git conflicts
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendDistDir = join(frontendDir, "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Pull latest
  log("Pulling latest changes...");
  const pull = await spawnAsync(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_PULL_MS,
  });

  if (pull.exitCode !== 0) {
    const reason = pull.timedOut
      ? `git pull timed out after ${TIMEOUT_GIT_PULL_MS / 1000}s`
      : pull.stderr.trim() || pull.stdout.trim();
    log(`Update failed: ${reason}`);
    await recoverFrontendAndStart(frontendDir, startServer);
    throw new Error(`git pull failed: ${reason}`);
  }

  for (const line of pull.stdout.trim().split("\n")) {
    if (line.trim()) log(`  ${line.trim()}`);
  }

  const currentHead = getHeadRef();
  const changedFiles = getChangedFilesBetween(previousHead, currentHead);

  // Install dependencies and rebuild only if pulled files touched frontend inputs.
  reportProgress?.("Installing backend and frontend dependencies...");
  await ensureDependencies(frontendDir);
  if (shouldRebuildFrontend(changedFiles)) {
    const summary = summarizeFrontendChanges(changedFiles);
    reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
    log(`Frontend changes detected in update; waiting for Vite build (${summary}).`);
    await rebuildFrontend(frontendDir);
  } else {
    reportProgress?.("No frontend changes detected; restarting server...");
    log("No frontend source/config changes detected in pulled files; skipping local Vite rebuild.");
  }

  log("Update complete. Restarting server...");
  reportProgress?.("Starting server...");
  await startServer();
}

/**
 * Switch branch: stash → stop → clear cache → delete dist → checkout → pull
 * → install deps → conditional frontend build → restart
 */
export async function switchBranch(
  target: string,
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>,
  reportProgress?: ProgressReporter,
): Promise<void> {
  if (!AVAILABLE_BRANCHES.includes(target as any)) {
    throw new Error(`Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
  }

  const currentBranch = getCurrentBranch();
  log(`Switching from '${currentBranch}' to '${target}'...`);
  const previousHead = getHeadRef();

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", `lumiverse-branch-switch-${currentBranch}`);
  }

  // Stop server
  await stopServer();

  // Clear transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendDistDir = join(frontendDir, "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Checkout (bounded — a dirty working tree shouldn't have survived the
  // stash above, but a stuck index lock or slow disk could still hang).
  const checkout = await spawnAsync(["git", "checkout", target], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_CHECKOUT_MS,
  });
  if (checkout.exitCode !== 0) {
    const reason = checkout.timedOut
      ? `git checkout timed out after ${TIMEOUT_GIT_CHECKOUT_MS / 1000}s`
      : checkout.stderr.trim() || checkout.stdout.trim();
    log(`Failed to checkout '${target}': ${reason}`);
    await recoverFrontendAndStart(frontendDir, startServer);
    throw new Error(`git checkout failed: ${reason}`);
  }

  log(`Checked out '${target}'.`);

  // Pull latest (non-fatal — checkout already succeeded)
  log("Pulling latest changes...");
  const pull = await spawnAsync(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_PULL_MS,
  });

  if (pull.exitCode !== 0) {
    const reason = pull.timedOut
      ? `git pull timed out after ${TIMEOUT_GIT_PULL_MS / 1000}s`
      : pull.stderr.trim() || pull.stdout.trim();
    log(`Pull failed (non-fatal): ${reason}`);
  } else {
    for (const line of pull.stdout.trim().split("\n").filter((l: string) => l.trim())) {
      log(`  ${line.trim()}`);
    }
  }

  const currentHead = getHeadRef();
  const changedFiles = getChangedFilesBetween(previousHead, currentHead);

  reportProgress?.("Installing backend and frontend dependencies...");
  await ensureDependencies(frontendDir);
  if (shouldRebuildFrontend(changedFiles)) {
    const summary = summarizeFrontendChanges(changedFiles);
    reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
    log(`Frontend changes detected after branch switch; waiting for Vite build (${summary}).`);
    await rebuildFrontend(frontendDir);
  } else {
    reportProgress?.("No frontend changes detected; restarting server...");
    log("No frontend source/config changes detected after branch switch; skipping local Vite rebuild.");
  }

  log(`Branch switch complete. Now on '${target}'. Restarting server...`);
  reportProgress?.("Starting server...");
  await startServer();
}

export async function ensureDependencies(frontendDir: string): Promise<void> {
  const installCmd = bunInstallCmd();
  clearBunInstallCacheIfTermux();

  log("Installing backend dependencies...");
  await runCommandOrThrow(installCmd, {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_BUN_INSTALL_MS,
    label: "backend install",
  });
  log("Backend dependencies updated.");

  log("Installing frontend dependencies...");
  await runCommandOrThrow(installCmd, {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_INSTALL_MS,
    label: "frontend install",
  });
  log("Frontend dependencies updated.");
}

export async function rebuildFrontend(frontendDir: string): Promise<void> {
  log("Rebuilding frontend...");
  await runCommandOrThrow(["bun", "run", "build"], {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_BUILD_MS,
    label: "frontend build",
  });
  log("Frontend rebuilt successfully.");
}

/** Rebuild frontend (best-effort) and restart the server after a git failure. */
async function recoverFrontendAndStart(
  frontendDir: string,
  startServer: () => Promise<void>
): Promise<void> {
  log("Rebuilding frontend to restore dist...");
  await spawnAsync(["bun", "run", "build"], {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_BUILD_MS,
    ignoreStdout: true,
  });
  await startServer();
}

import { join } from "path";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
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
import { npmCmd } from "./lib/termux-cli.js";

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

function getChangedFilesBetween(fromRef: string, toRef: string): string[] | null {
  if (fromRef === toRef) return [];
  const diff = runGit("diff", "--name-only", `${fromRef}..${toRef}`);
  if (!diff.ok) return null;
  if (!diff.out) return [];
  return diff.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getCommitsAhead(branchRef: string, upstreamRef: string): number {
  const revList = runGit("rev-list", "--count", `${upstreamRef}..${branchRef}`);
  if (!revList.ok || !revList.out) return 0;
  const ahead = parseInt(revList.out, 10);
  return Number.isFinite(ahead) ? ahead : 0;
}

function isFrontendBuildInput(filePath: string): boolean {
  if (!filePath.startsWith("frontend/")) return false;
  if (FRONTEND_BUILD_IGNORED_FILES.has(filePath)) return false;
  return !FRONTEND_BUILD_IGNORED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

function shouldRebuildFrontend(changedFiles: string[] | null): boolean {
  return changedFiles === null || changedFiles.some(isFrontendBuildInput);
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
    // --ignore-scripts: proot's path translation makes getcwd() fail when bun
    // forks lifecycle scripts (ssh2, cpu-features), producing spurious
    // CouldntReadCurrentDirectory errors. Both packages fall back to pure-JS.
    return ["bun", "install", "--backend=copyfile", "--ignore-scripts"];
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

function backendDependenciesChanged(changedFiles: string[] | null): boolean {
  return changedFiles === null || changedFiles.some((file) => file === "package.json" || file === "bun.lock");
}

function frontendDependenciesChanged(changedFiles: string[] | null): boolean {
  return changedFiles === null || changedFiles.some(
    (file) => file === "frontend/package.json" || file === "frontend/bun.lock",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stop the backend for an operation and guarantee a best-effort restart on
 * every exit path. startServer is intentionally idempotent, so retrying it
 * after a partial start failure is safe.
 */
export async function runWithServerStopped(
  label: string,
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>,
  operation: () => Promise<void>,
): Promise<void> {
  let restartRequired = false;
  try {
    restartRequired = true;
    await stopServer();
    await operation();
    await startServer();
    restartRequired = false;
  } catch (operationError) {
    if (restartRequired) {
      log(`${label} failed; restarting the server with the last validated frontend bundle...`);
      try {
        await startServer();
        restartRequired = false;
      } catch (restartError) {
        throw new Error(
          `${errorMessage(operationError)}; automatic server recovery also failed: ${errorMessage(restartError)}`,
          { cause: operationError },
        );
      }
    }
    throw operationError;
  }
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

function getUpstreamRefForSync(branchName: string): string {
  return getUpstreamRef(branchName) || `origin/${branchName}`;
}

function assertNoLocalCommitsBeforeHardSync(branchRef: string, branchName: string, upstreamRef: string): void {
  const ahead = getCommitsAhead(branchRef, upstreamRef);
  if (ahead > 0) {
    throw new Error(
      `Refusing to hard-sync '${branchName}': it is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${upstreamRef}`
    );
  }
}

async function stashLocalChanges(label: string): Promise<void> {
  const status = runGit("status", "--porcelain", "--untracked-files=all");
  if (!status.ok || !status.out) return;

  log("Stashing local changes and untracked files...");
  await runCommandOrThrow(["git", "stash", "push", "-u", "-m", label], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_CHECKOUT_MS,
    label: "git stash push",
  });
}

async function resetTrackedFiles(ref: string): Promise<void> {
  log(`Resetting tracked files to '${ref}'...`);
  await runCommandOrThrow(["git", "reset", "--hard", ref], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_PULL_MS,
    label: `git reset --hard ${ref}`,
  });
}

async function checkoutBranch(target: string): Promise<void> {
  log(`Checking out '${target}'...`);
  await runCommandOrThrow(["git", "checkout", target], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_CHECKOUT_MS,
    label: `git checkout ${target}`,
  });
}

async function syncBranchToUpstream(branchName: string, upstreamRef: string): Promise<void> {
  log(`Fetching latest changes for '${branchName}'...`);
  await runCommandOrThrow(["git", "fetch", "--quiet"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_FETCH_MS,
    label: "git fetch",
  });
  log(`Resetting '${branchName}' to '${upstreamRef}'...`);
  await resetTrackedFiles(upstreamRef);
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
 * Apply update: stash → hard reset tracked files → fetch → hard reset to
 * upstream head → install deps → conditional frontend build → restart
 */
export async function applyUpdate(
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>,
  reportProgress?: ProgressReporter,
): Promise<void> {
  log("Preparing update...");
  const frontendDir = join(PROJECT_ROOT, "frontend");

  await runWithServerStopped("Update", stopServer, startServer, async () => {
    const previousHead = getHeadRef();
    const currentBranch = getCurrentBranch();
    if (!currentBranch || currentBranch === "HEAD") {
      throw new Error("Unable to resolve current git branch");
    }
    const currentUpstream = getUpstreamRefForSync(currentBranch);
    assertNoLocalCommitsBeforeHardSync("HEAD", currentBranch, currentUpstream);

    reportProgress?.("Syncing repository to upstream branch head...");
    await stashLocalChanges("lumiverse-runner-auto-stash");
    await resetTrackedFiles("HEAD");
    await syncBranchToUpstream(currentBranch, currentUpstream);

    const currentHead = getHeadRef();
    const changedFiles = getChangedFilesBetween(previousHead, currentHead);
    if (changedFiles === null) {
      log("Could not inspect changed files; conservatively installing dependencies and rebuilding the frontend.");
    }

    await ensureChangedDependencies(frontendDir, changedFiles, reportProgress);
    if (shouldRebuildFrontend(changedFiles)) {
      const summary = changedFiles ? summarizeFrontendChanges(changedFiles) : "change list unavailable";
      reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
      log(`Frontend changes detected in update; waiting for Vite build (${summary}).`);
      await rebuildFrontend(frontendDir);
    } else {
      reportProgress?.("No frontend changes detected; restarting server...");
      log("No frontend source/config changes detected in pulled files; skipping local Vite rebuild.");
    }

    log("Update complete. Restarting server...");
    reportProgress?.("Starting server...");
  });
}

/**
 * Switch branch: stash → hard reset tracked files → checkout → fetch →
 * hard reset target branch to upstream head → install deps → conditional
 * frontend build → restart
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

  const frontendDir = join(PROJECT_ROOT, "frontend");

  await runWithServerStopped("Branch switch", stopServer, startServer, async () => {
    const currentBranch = getCurrentBranch();
    log(`Switching from '${currentBranch}' to '${target}'...`);
    const previousHead = getHeadRef();
    const targetUpstream = getUpstreamRefForSync(target);

    reportProgress?.(`Syncing '${target}' to upstream branch head...`);
    await stashLocalChanges(`lumiverse-branch-switch-${currentBranch || "detached-head"}`);
    await resetTrackedFiles("HEAD");
    await checkoutBranch(target);
    assertNoLocalCommitsBeforeHardSync("HEAD", target, targetUpstream);
    await syncBranchToUpstream(target, targetUpstream);

    const currentHead = getHeadRef();
    const changedFiles = getChangedFilesBetween(previousHead, currentHead);
    if (changedFiles === null) {
      log("Could not inspect changed files; conservatively installing dependencies and rebuilding the frontend.");
    }

    await ensureChangedDependencies(frontendDir, changedFiles, reportProgress);
    if (shouldRebuildFrontend(changedFiles)) {
      const summary = changedFiles ? summarizeFrontendChanges(changedFiles) : "change list unavailable";
      reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
      log(`Frontend changes detected after branch switch; waiting for Vite build (${summary}).`);
      await rebuildFrontend(frontendDir);
    } else {
      reportProgress?.("No frontend changes detected; restarting server...");
      log("No frontend source/config changes detected after branch switch; skipping local Vite rebuild.");
    }

    log(`Branch switch complete. Now on '${target}'. Restarting server...`);
    reportProgress?.("Starting server...");
  });
}

// Written into node_modules only after `bun install` exits 0. Its absence
// alongside an existing node_modules used to be treated as a broken half-
// install. That was too aggressive: manual `bun install` never writes the
// runner stamp, so a healthy tree could be deleted on the next update. We now
// validate the tree against direct package deps first and only move it aside
// when it is actually incomplete.
const INSTALL_STAMP = "node_modules/.lumiverse-install-complete";
const INSTALL_BACKUP_PREFIX = "node_modules.lumiverse-backup-";
const MAX_MISSING_DEP_PREVIEW = 5;

interface DependencyTreeState {
  hasNodeModules: boolean;
  hasStamp: boolean;
  missingPackages: string[];
}

interface PreparedDependencyInstall {
  backupDir: string | null;
}

function listDeclaredInstallPackages(dir: string): string[] {
  const manifestPath = join(dir, "package.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  return Array.from(new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])).sort();
}

function packageInstallPath(nodeModulesDir: string, packageName: string): string {
  return join(nodeModulesDir, ...packageName.split("/"));
}

export function inspectDependencyTree(dir: string): DependencyTreeState {
  const nodeModules = join(dir, "node_modules");
  const hasNodeModules = existsSync(nodeModules);
  const declaredPackages = listDeclaredInstallPackages(dir);
  const missingPackages = declaredPackages.filter((packageName) => !existsSync(packageInstallPath(nodeModules, packageName)));

  return {
    hasNodeModules,
    hasStamp: existsSync(join(dir, INSTALL_STAMP)),
    missingPackages,
  };
}

export function summarizeMissingDependencyPackages(missingPackages: string[]): string {
  if (missingPackages.length === 0) return "no missing packages";
  const preview = missingPackages.slice(0, MAX_MISSING_DEP_PREVIEW).join(", ");
  return missingPackages.length > MAX_MISSING_DEP_PREVIEW
    ? `${preview}, ...`
    : preview;
}

function writeInstallStamp(dir: string): void {
  try { writeFileSync(join(dir, INSTALL_STAMP), `${Date.now()}\n`); } catch {}
}

export function prepareDependencyInstall(dir: string, label: string): PreparedDependencyInstall {
  const nodeModules = join(dir, "node_modules");
  const state = inspectDependencyTree(dir);
  if (!state.hasNodeModules) return { backupDir: null };

  if (state.missingPackages.length === 0) {
    if (!state.hasStamp) {
      log(`Detected ${label} dependencies installed without runner stamp; keeping current tree and marking it complete.`);
      writeInstallStamp(dir);
    }
    return { backupDir: null };
  }

  const backupDir = join(dir, `${INSTALL_BACKUP_PREFIX}${Date.now()}-${process.pid}`);
  log(
    `Detected incomplete ${label} dependency tree (${summarizeMissingDependencyPackages(state.missingPackages)} missing); ` +
    "moving node_modules aside before reinstall..."
  );
  try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
  renameSync(nodeModules, backupDir);
  return { backupDir };
}

export function finalizeDependencyInstall(dir: string, prepared: PreparedDependencyInstall): void {
  writeInstallStamp(dir);
  if (!prepared.backupDir || !existsSync(prepared.backupDir)) return;
  try { rmSync(prepared.backupDir, { recursive: true, force: true }); } catch {}
}

export function restoreDependencyInstall(
  dir: string,
  label: string,
  prepared: PreparedDependencyInstall,
): void {
  if (!prepared.backupDir || !existsSync(prepared.backupDir)) return;

  const nodeModules = join(dir, "node_modules");
  try {
    rmSync(nodeModules, { recursive: true, force: true });
    renameSync(prepared.backupDir, nodeModules);

    if (inspectDependencyTree(dir).missingPackages.length === 0) {
      writeInstallStamp(dir);
    }

    log(`Restored previous ${label} dependencies after failed reinstall.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to restore previous ${label} dependencies: ${message}`);
  }
}

const TERMUX_FRONTEND_NATIVE_DEPS = [
  "@rolldown/binding-android-arm64@1.0.2",
  "lightningcss-android-arm64@1.32.0",
];

async function repairTermuxFrontendNativeDeps(frontendDir: string): Promise<void> {
  if (!isTermuxRuntime() && !isProotRuntime()) return;

  log("Repairing Termux frontend native bindings with npm...");
  await runCommandOrThrow(npmCmd(["cache", "clean", "--force"]), {
    cwd: frontendDir,
    timeoutMs: 60_000,
    label: "npm cache clean",
  });
  await runCommandOrThrow(npmCmd([
    "install",
    "--force",
    "--no-save",
    "--no-package-lock",
    "--include=optional",
    "--no-audit",
    "--no-fund",
    ...TERMUX_FRONTEND_NATIVE_DEPS,
  ]), {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_INSTALL_MS,
    label: "Termux frontend native binding install",
  });
  log("Termux frontend native bindings repaired.");
}

async function installDependenciesForDir(
  dir: string,
  label: string,
  installCmd: string[],
  postInstall?: () => Promise<void>,
): Promise<void> {
  const prepared = prepareDependencyInstall(dir, label);
  log(`Installing ${label} dependencies...`);

  try {
    await runCommandOrThrow(installCmd, {
      cwd: dir,
      timeoutMs: TIMEOUT_BUN_INSTALL_MS,
      label: `${label} install`,
    });
    if (postInstall) await postInstall();
    finalizeDependencyInstall(dir, prepared);
    log(`${label[0]?.toUpperCase() ?? ""}${label.slice(1)} dependencies updated.`);
  } catch (error) {
    restoreDependencyInstall(dir, label, prepared);
    throw error;
  }
}

export async function ensureDependencies(frontendDir: string): Promise<void> {
  await ensureBackendDependencies();
  await ensureFrontendDependencies(frontendDir);
}

export async function ensureBackendDependencies(): Promise<void> {
  clearBunInstallCacheIfTermux();
  await installDependenciesForDir(PROJECT_ROOT, "backend", bunInstallCmd());
}

export async function ensureFrontendDependencies(frontendDir: string): Promise<void> {
  clearBunInstallCacheIfTermux();
  await installDependenciesForDir(frontendDir, "frontend", bunInstallCmd(), async () => {
    await repairTermuxFrontendNativeDeps(frontendDir);
  });
}

async function ensureChangedDependencies(
  frontendDir: string,
  changedFiles: string[] | null,
  reportProgress?: ProgressReporter,
): Promise<void> {
  const installBackend = backendDependenciesChanged(changedFiles);
  const installFrontend = frontendDependenciesChanged(changedFiles);

  if (installBackend) {
    reportProgress?.("Installing backend dependencies...");
    await ensureBackendDependencies();
  }
  if (installFrontend) {
    reportProgress?.("Installing frontend dependencies...");
    await ensureFrontendDependencies(frontendDir);
  }
  if (!installBackend && !installFrontend) {
    log("Dependency manifests are unchanged; skipping package installation.");
  }
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

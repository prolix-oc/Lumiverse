import { delimiter, dirname, join, win32 } from "path";
import { homedir, platform } from "os";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { runGit, getUpstreamRef, getCurrentBranch } from "./lib/git.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_GIT_FETCH_MS,
  TIMEOUT_GIT_PULL_MS,
  TIMEOUT_GIT_CHECKOUT_MS,
  TIMEOUT_BUN_INSTALL_MS,
  TIMEOUT_BUN_INSTALL_TERMUX_MS,
  TIMEOUT_BUN_BUILD_MS,
  TIMEOUT_DESKTOP_BUILD_MS,
} from "./lib/constants.js";
import { spawnAsync } from "./lib/spawn-async.js";
import { npmCmd } from "./lib/termux-cli.js";
import { resolveWindowsMsvc, windowsMsvcCommand } from "../windows-msvc.js";
import { configuredBunExecutable, ensureBunRuntime } from "../../src/runtime/bun-runtime.js";

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}

export interface DesktopShellState {
  /** The checkout contains desktop changes the running binary predates. */
  stale: boolean;
  /** Commit the running desktop shell was compiled from, if it reported one. */
  builtSha: string | null;
  /** Newest commit touching `desktop/` in the checkout. */
  requiredSha: string | null;
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

/** Newest commit that touched the desktop shell's sources. */
function getLastDesktopShellCommit(): string | null {
  const log = runGit("log", "-1", "--format=%H", "--", "desktop");
  if (!log.ok || !log.out) return null;
  return log.out;
}

function commitExists(sha: string): boolean {
  return runGit("cat-file", "-e", `${sha}^{commit}`).ok;
}

/**
 * Decide whether the running desktop shell predates the checkout's desktop
 * sources.
 *
 * The shell is a compiled binary that `applyUpdate` cannot replace, so a pull
 * carrying `desktop/` changes leaves the user running code the checkout has
 * already moved past — with no symptom other than the old behaviour
 * persisting. Equality is the wrong test: the stamped revision is whatever
 * HEAD was at build time, which normally sits *ahead* of the last commit that
 * touched `desktop/`. What matters is whether that commit is already reachable
 * from the build.
 *
 * Every branch that cannot answer confidently reports "not stale". A shell
 * built from an archive, or from a history this checkout does not share, is
 * unknowable rather than out of date, and a false warning telling someone to
 * rebuild a current binary is worse than staying quiet.
 */
export function evaluateDesktopShell(builtSha: string | null): DesktopShellState {
  const requiredSha = getLastDesktopShellCommit();
  if (!builtSha || !requiredSha) return { stale: false, builtSha, requiredSha };
  if (!commitExists(builtSha)) return { stale: false, builtSha, requiredSha };

  const containsDesktopSources = runGit("merge-base", "--is-ancestor", requiredSha, builtSha).ok;
  return { stale: !containsDesktopSources, builtSha, requiredSha };
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

export function bunInstallCmd(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const installArgs = ["install", "--backend=copyfile", "--ignore-scripts"];

  if (env.LUMIVERSE_IS_TERMUX === "true") {
    // Native Termux needs syscall interception for bun install even when the
    // bun-termux wrapper or grun can execute ordinary Bun commands. Mirror
    // start.sh's _proot_bun path rather than spawning bare Bun from the runner.
    const bunPath = env.LUMIVERSE_BUN_PATH || "bun";
    const method = env.LUMIVERSE_BUN_METHOD;
    if (method === "direct") {
      return ["proot", "--link2symlink", "-0", bunPath, ...installArgs];
    }
    if (method === "grun") {
      return ["proot", "--link2symlink", "-0", "grun", bunPath, ...installArgs];
    }

    const prefix = env.PREFIX || "/data/data/com.termux/files/usr";
    return [
      "proot", "--link2symlink", "-0",
      `${prefix}/glibc/lib/ld-linux-aarch64.so.1`,
      "--library-path", `${prefix}/glibc/lib`,
      bunPath, ...installArgs,
    ];
  }
  if (env.LUMIVERSE_IS_PROOT === "true") {
    // A proot-distro shell already provides syscall interception.
    return ["bun", ...installArgs];
  }
  const bunExecutable = env.LUMIVERSE_BUN_EXECUTABLE || "bun";
  if (platform === "win32") {
    // Windows normally hardlinks packages from Bun's cache. Filesystem filters
    // can leave those package directories empty even though install exits 0.
    return [bunExecutable, "install", "--backend=copyfile"];
  }
  return [bunExecutable, "install"];
}

export function bunRuntimeCmd(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.LUMIVERSE_IS_TERMUX === "true") {
    const bunPath = env.LUMIVERSE_BUN_PATH || "bun";
    const method = env.LUMIVERSE_BUN_METHOD;
    if (method === "direct") return [bunPath, ...args];
    if (method === "grun") return ["grun", bunPath, ...args];

    const prefix = env.PREFIX || "/data/data/com.termux/files/usr";
    return [
      "proot", "--link2symlink", "-0",
      `${prefix}/glibc/lib/ld-linux-aarch64.so.1`,
      "--library-path", `${prefix}/glibc/lib`,
      bunPath, ...args,
    ];
  }
  return [env.LUMIVERSE_BUN_EXECUTABLE || "bun", ...args];
}

// glibc-runner/grun currently word-splits argv containing spaces on Termux.
// Keep eval probes whitespace-free so fallback runtimes receive one intact -e arg.
const BACKEND_DEPENDENCY_PROBE =
  "await(import('./src/sharp-preflight.ts')).then(m=>m.configureSharpNativeOverride());await(import('sharp')).then(m=>m.default({create:{width:1,height:1,channels:4,background:'#000000'}}).png().toBuffer());await(import('better-auth'));await(import('@better-auth/oauth-provider'))";

export function backendDependencyProbeCmd(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return bunRuntimeCmd(["-e", BACKEND_DEPENDENCY_PROBE], env);
}

const FRONTEND_DEPENDENCY_PROBE = "await(import('@better-auth/oauth-provider/client'))";

export function frontendDependencyProbeCmd(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return bunRuntimeCmd(["-e", FRONTEND_DEPENDENCY_PROBE], env);
}

export function bunInstallTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return env.LUMIVERSE_IS_TERMUX === "true" || env.LUMIVERSE_IS_PROOT === "true"
    ? TIMEOUT_BUN_INSTALL_TERMUX_MS
    : TIMEOUT_BUN_INSTALL_MS;
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

interface DependencyManifestRefs {
  fromRef: string;
  toRef: string;
}

type PackageManifest = Record<string, unknown>;

const PACKAGE_INSTALL_INPUT_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "overrides",
  "resolutions",
  "trustedDependencies",
  "patchedDependencies",
  "workspaces",
  "catalog",
  "catalogs",
  "packageManager",
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A package.json can change its scripts, description, or version without
 * changing anything Bun must resolve or install. Keep those updates from
 * triggering a costly node_modules operation, while treating an unreadable
 * manifest conservatively as changed.
 */
export function packageInstallInputsChanged(previous: string, current: string): boolean {
  try {
    const previousManifest = JSON.parse(previous) as PackageManifest;
    const currentManifest = JSON.parse(current) as PackageManifest;
    const installInputs = (manifest: PackageManifest) => Object.fromEntries(
      PACKAGE_INSTALL_INPUT_FIELDS.map((field) => [field, manifest[field] ?? null]),
    );
    return stableJson(installInputs(previousManifest)) !== stableJson(installInputs(currentManifest));
  } catch {
    return true;
  }
}

function packageInstallInputsChangedBetween(
  fromRef: string,
  toRef: string,
  packagePath: string,
): boolean {
  const previous = runGit("show", `${fromRef}:${packagePath}`);
  const current = runGit("show", `${toRef}:${packagePath}`);
  if (!previous.ok || !current.ok) return true;
  return packageInstallInputsChanged(previous.out, current.out);
}

function packageDependenciesChanged(
  changedFiles: string[] | null,
  packagePath: string,
  lockfilePath: string,
  installConfigPaths: string[],
  manifestRefs?: DependencyManifestRefs,
): boolean {
  if (changedFiles === null) return true;
  if (changedFiles.some((file) => file === lockfilePath || installConfigPaths.includes(file))) return true;
  if (!changedFiles.includes(packagePath)) return false;
  if (!manifestRefs) return true;
  return packageInstallInputsChangedBetween(manifestRefs.fromRef, manifestRefs.toRef, packagePath);
}

function backendDependenciesChanged(
  changedFiles: string[] | null,
  manifestRefs?: DependencyManifestRefs,
): boolean {
  return packageDependenciesChanged(
    changedFiles,
    "package.json",
    "bun.lock",
    ["bunfig.toml", ".npmrc"],
    manifestRefs,
  );
}

function frontendDependenciesChanged(
  changedFiles: string[] | null,
  manifestRefs?: DependencyManifestRefs,
): boolean {
  return packageDependenciesChanged(
    changedFiles,
    "frontend/package.json",
    "frontend/bun.lock",
    ["frontend/bunfig.toml", "frontend/.npmrc"],
    manifestRefs,
  );
}

export interface ChangedDependencyPlan {
  installBackend: boolean;
  installFrontend: boolean;
  repairTermuxFrontendNativeDeps: boolean;
}

/**
 * Keep source-only Termux rebuilds on the same native-binding repair path that
 * the pre-optimization update flow got from reinstalling frontend dependencies
 * on every update. A frontend install already performs this repair itself.
 */
export function planChangedDependencies(
  changedFiles: string[] | null,
  termuxLike: boolean,
  manifestRefs?: DependencyManifestRefs,
): ChangedDependencyPlan {
  const installBackend = backendDependenciesChanged(changedFiles, manifestRefs);
  const installFrontend = frontendDependenciesChanged(changedFiles, manifestRefs);

  return {
    installBackend,
    installFrontend,
    repairTermuxFrontendNativeDeps:
      termuxLike && shouldRebuildFrontend(changedFiles) && !installFrontend,
  };
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
  opts: {
    cwd: string;
    timeoutMs: number;
    label: string;
    env?: Record<string, string | undefined>;
    windowsVerbatimArguments?: boolean;
    onOutput?: (source: "stdout" | "stderr", text: string) => void;
  }
): Promise<void> {
  const result = await spawnAsync(cmd, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    windowsVerbatimArguments: opts.windowsVerbatimArguments,
    onOutput: opts.onOutput,
  });

  if (result.exitCode === 0) return;

  const output = result.stderr.trim() || result.stdout.trim();
  const reason = result.timedOut
    ? `${opts.label} timed out after ${opts.timeoutMs / 1000}s${output ? `\nLast output:\n${output}` : ""}`
    : output || `${opts.label} failed`;
  throw new Error(reason);
}

function getUpstreamRefForSync(branchName: string): string {
  return getUpstreamRef(branchName) || `origin/${branchName}`;
}

export function hardSyncRefusalMessage(branchName: string, upstreamRef: string, ahead: number): string {
  return `Cannot update '${branchName}' because it has ${ahead} local commit${ahead === 1 ? "" : "s"} not present on ${upstreamRef}. Push them or move them to another branch before retrying; automatic updates will not discard local commits.`;
}

function assertNoLocalCommitsBeforeHardSync(branchRef: string, branchName: string, upstreamRef: string): void {
  const ahead = getCommitsAhead(branchRef, upstreamRef);
  if (ahead > 0) {
    throw new Error(hardSyncRefusalMessage(branchName, upstreamRef, ahead));
  }
}

/** Validate an update before the runner acknowledges it and stops the server. */
export function assertUpdateCanHardSync(): void {
  const currentBranch = getCurrentBranch();
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to resolve current git branch");
  }
  const currentUpstream = getUpstreamRefForSync(currentBranch);
  assertNoLocalCommitsBeforeHardSync("HEAD", currentBranch, currentUpstream);
}

/** Validate a branch switch before the runner acknowledges it and stops the server. */
export function assertBranchCanHardSync(target: string): void {
  if (!AVAILABLE_BRANCHES.includes(target as any)) {
    throw new Error(`Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
  }
  const targetUpstream = getUpstreamRefForSync(target);
  assertNoLocalCommitsBeforeHardSync(target, target, targetUpstream);
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
  assertUpdateCanHardSync();

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

    await ensureBunRuntime(PROJECT_ROOT);
    await ensureChangedDependencies(frontendDir, changedFiles, reportProgress, {
      fromRef: previousHead,
      toRef: currentHead,
    });
    if (shouldRebuildFrontend(changedFiles)) {
      const summary = changedFiles ? summarizeFrontendChanges(changedFiles) : "change list unavailable";
      reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
      log(`Frontend changes detected in update; waiting for Vite build (${summary}).`);
      await rebuildFrontend(frontendDir, reportProgress);
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
  assertBranchCanHardSync(target);

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

    await ensureBunRuntime(PROJECT_ROOT);
    await ensureChangedDependencies(frontendDir, changedFiles, reportProgress, {
      fromRef: previousHead,
      toRef: currentHead,
    });
    if (shouldRebuildFrontend(changedFiles)) {
      const summary = changedFiles ? summarizeFrontendChanges(changedFiles) : "change list unavailable";
      reportProgress?.(`Waiting for Vite build to finish${summary ? ` (${summary})` : ""}...`);
      log(`Frontend changes detected after branch switch; waiting for Vite build (${summary}).`);
      await rebuildFrontend(frontendDir, reportProgress);
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
const LOCAL_INSTALL_INPUTS = ["package.json", "bun.lock", "bunfig.toml", ".npmrc"];

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
  const missingPackages = declaredPackages.filter((packageName) => {
    const packageDir = packageInstallPath(nodeModules, packageName);
    return !existsSync(join(packageDir, "package.json"));
  });

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

/**
 * Detect an install that began after new dependency inputs landed but never
 * reached writeInstallStamp(). This lets the next update retry even when the
 * failed update already advanced HEAD and its manifest delta is no longer in
 * the next changed-file range. Missing stamps may belong to a healthy manual
 * install, so only an existing, provably older stamp is considered stale.
 */
export function dependencyInstallStampIsStale(dir: string): boolean {
  const stampPath = join(dir, INSTALL_STAMP);
  if (!existsSync(stampPath)) return false;

  try {
    const stampMtime = statSync(stampPath).mtimeMs;
    return LOCAL_INSTALL_INPUTS.some((relativePath) => {
      const inputPath = join(dir, relativePath);
      return existsSync(inputPath) && statSync(inputPath).mtimeMs > stampMtime;
    });
  } catch {
    // A concurrently replaced stamp/input is safest to reconcile by reinstalling.
    return true;
  }
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

// Keep these aligned with frontend/package.json overrides and optionalDependencies.
// Rolldown >=1.2.4 includes the Android ARMv8.0 SIGILL fix.
const TERMUX_FRONTEND_NATIVE_DEPS = [
  "@oxc-transform-react/binding-android-arm64@0.154.0",
  "@rolldown/binding-android-arm64@1.2.15",
  "lightningcss-android-arm64@1.33.0",
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
      timeoutMs: bunInstallTimeoutMs(),
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

type DependencyTreeLabel = "backend" | "frontend";

class DependencyValidationError extends Error {
  constructor(
    readonly dependencyTree: DependencyTreeLabel,
    message: string,
  ) {
    super(message);
    this.name = "DependencyValidationError";
  }
}

async function verifyBackendDependencies(dir: string): Promise<void> {
  try {
    await runCommandOrThrow(backendDependencyProbeCmd(), {
      cwd: dir,
      // A first native Android run may download the verified Sharp/libvips engine.
      timeoutMs: 360_000,
      label: "backend dependency validation",
    });
  } catch (error) {
    throw new DependencyValidationError("backend", errorMessage(error));
  }
}

async function verifyFrontendDependencies(dir: string): Promise<void> {
  try {
    await runCommandOrThrow(frontendDependencyProbeCmd(), {
      cwd: dir,
      timeoutMs: 60_000,
      label: "frontend dependency validation",
    });
  } catch (error) {
    throw new DependencyValidationError("frontend", errorMessage(error));
  }
}

async function clearBunInstallCacheForRepair(dir: string): Promise<void> {
  try {
    await runCommandOrThrow(bunRuntimeCmd(["pm", "cache", "rm"]), {
      cwd: dir,
      timeoutMs: 60_000,
      label: "Bun package cache clear",
    });
  } catch (error) {
    log(`Could not clear Bun's package cache before dependency repair: ${errorMessage(error)}`);
  }
}

async function repairDependencies(
  dir: string,
  label: DependencyTreeLabel,
  installCmd: string[],
  postInstall: () => Promise<void>,
): Promise<void> {
  const nodeModules = join(dir, "node_modules");
  const backupDir = join(
    dir,
    `${INSTALL_BACKUP_PREFIX}dependency-repair-${Date.now()}-${process.pid}`,
  );

  log(`${label[0]?.toUpperCase() ?? ""}${label.slice(1)} dependency validation failed; clearing the package cache and reinstalling from a clean tree...`);
  try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
  if (existsSync(nodeModules)) renameSync(nodeModules, backupDir);

  try {
    await clearBunInstallCacheForRepair(dir);
    await installDependenciesForDir(
      dir,
      label,
      installCmd,
      postInstall,
    );
    try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
    log(`${label[0]?.toUpperCase() ?? ""}${label.slice(1)} dependency tree repaired.`);
  } catch (error) {
    try { rmSync(nodeModules, { recursive: true, force: true }); } catch {}
    if (existsSync(backupDir)) renameSync(backupDir, nodeModules);
    throw error;
  }
}

async function finishFrontendDependencyInstall(frontendDir: string): Promise<void> {
  await repairTermuxFrontendNativeDeps(frontendDir);
  await verifyFrontendDependencies(frontendDir);
}

async function ensureFrontendDependencyTreeHealthy(frontendDir: string): Promise<void> {
  try {
    await verifyFrontendDependencies(frontendDir);
  } catch (error) {
    if (!(error instanceof DependencyValidationError) || error.dependencyTree !== "frontend") throw error;
    await repairDependencies(
      frontendDir,
      "frontend",
      bunInstallCmd(),
      async () => finishFrontendDependencyInstall(frontendDir),
    );
  }
}

export async function ensureDependencies(frontendDir: string): Promise<void> {
  await ensureBackendDependencies();
  await ensureFrontendDependencies(frontendDir);
}

export async function ensureBackendDependencies(): Promise<void> {
  clearBunInstallCacheIfTermux();
  const installCmd = bunInstallCmd();
  const postInstall = async (): Promise<void> => verifyBackendDependencies(PROJECT_ROOT);
  try {
    await installDependenciesForDir(
      PROJECT_ROOT,
      "backend",
      installCmd,
      postInstall,
    );
  } catch (error) {
    if (!(error instanceof DependencyValidationError) || error.dependencyTree !== "backend") throw error;
    await repairDependencies(PROJECT_ROOT, "backend", installCmd, postInstall);
  }
}

export async function ensureFrontendDependencies(frontendDir: string): Promise<void> {
  clearBunInstallCacheIfTermux();
  const installCmd = bunInstallCmd();
  const postInstall = async (): Promise<void> => finishFrontendDependencyInstall(frontendDir);
  try {
    await installDependenciesForDir(frontendDir, "frontend", installCmd, postInstall);
  } catch (error) {
    if (!(error instanceof DependencyValidationError) || error.dependencyTree !== "frontend") throw error;
    await repairDependencies(frontendDir, "frontend", installCmd, postInstall);
  }
}

async function ensureChangedDependencies(
  frontendDir: string,
  changedFiles: string[] | null,
  reportProgress?: ProgressReporter,
  manifestRefs?: DependencyManifestRefs,
): Promise<void> {
  const plan = planChangedDependencies(
    changedFiles,
    isTermuxRuntime() || isProotRuntime(),
    manifestRefs,
  );
  const retryBackendInstall = !plan.installBackend && dependencyInstallStampIsStale(PROJECT_ROOT);
  const retryFrontendInstall = !plan.installFrontend && dependencyInstallStampIsStale(frontendDir);
  const installBackend = plan.installBackend || retryBackendInstall;
  const installFrontend = plan.installFrontend || retryFrontendInstall;

  if (retryBackendInstall) {
    log("Backend dependency inputs are newer than the last successful install; retrying.");
  }
  if (retryFrontendInstall) {
    log("Frontend dependency inputs are newer than the last successful install; retrying.");
  }

  if (installBackend) {
    reportProgress?.("Installing backend dependencies...");
    await ensureBackendDependencies();
  } else if (isTermuxRuntime()) {
    // Source-only updates also need to repair trees installed before the
    // Android Sharp preflight existed, even when package.json is unchanged.
    reportProgress?.("Validating Android backend native dependencies...");
    await verifyBackendDependencies(PROJECT_ROOT);
  }
  if (installFrontend) {
    reportProgress?.("Installing frontend dependencies...");
    await ensureFrontendDependencies(frontendDir);
  }
  if (!installBackend && !installFrontend) {
    log("Dependency manifests are unchanged; skipping package installation.");
  }
  if (plan.repairTermuxFrontendNativeDeps && !installFrontend) {
    reportProgress?.("Repairing Termux frontend native bindings...");
    await repairTermuxFrontendNativeDeps(frontendDir);
  }
}

export const FRONTEND_BUILD_STEPS = [
  {
    label: "frontend component metadata extraction",
    progress: "Extracting frontend component metadata...",
    command: ["bun", "run", "scripts/extract-props.ts"],
  },
  {
    label: "frontend CSS variable extraction",
    progress: "Extracting frontend CSS variables...",
    command: ["bun", "run", "scripts/extract-css-vars.ts"],
  },
  {
    label: "frontend theme reference generation",
    progress: "Generating frontend theme references...",
    command: ["bun", "run", "scripts/generate-theme-reference.ts"],
  },
  {
    label: "frontend Vite bundling",
    progress: "Building the frontend bundle with Vite...",
    command: ["bun", "run", "scripts/build-frontend.ts"],
  },
] as const;

function desktopInstallBundleArgs(): string[] {
  switch (platform()) {
    case "darwin": return ["--bundles", "app"];
    case "win32": return ["--bundles", "nsis"];
    case "linux": return ["--bundles", "appimage"];
    default: return [];
  }
}

export const DESKTOP_BUILD_STEPS = [
  {
    label: "desktop dependency install",
    progress: "Installing desktop app dependencies...",
    // Resolved at run time: bunInstallCmd() carries the Windows copyfile
    // backend and the Termux proot wrapping that a bare `bun install` lacks.
    command: null,
  },
  {
    label: "desktop Tauri build",
    progress: "Compiling the desktop app — this can take several minutes...",
    // The scripted workflow installs the native app artifact directly. Avoid
    // also building optional distributable media (notably macOS DMGs), whose
    // Finder/mount tooling can fail after the usable .app already succeeded.
    command: ["bun", "run", "tauri:finalized", "build", ...desktopInstallBundleArgs()],
  },
] as const satisfies ReadonlyArray<{ label: string; progress: string; command: readonly string[] | null }>;

/** Keep the Bun running this build and cargo available to every child process. */
export function desktopBuildEnv(
  env: Record<string, string | undefined> = process.env,
  bunExecutable = configuredBunExecutable(env),
  cargoBin = join(homedir(), ".cargo", "bin"),
  target: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const separator = target === "win32" ? ";" : delimiter;
  const pathKeys = Object.keys(env).filter((key) => target === "win32" ? key.toLowerCase() === "path" : key === "PATH");
  const current = pathKeys.map((key) => env[key]).filter(Boolean).join(separator);
  const bunBin = (target === "win32" ? win32.dirname : dirname)(bunExecutable);
  const seen = new Set<string>();
  const paths = [bunBin, cargoBin, ...current.split(separator)].filter((entry) => {
    if (!entry) return false;
    const key = target === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const buildEnv = { ...env };
  for (const key of pathKeys) delete buildEnv[key];
  return { ...buildEnv, PATH: paths.join(separator) };
}

/**
 * Where `tauri build` leaves the installable artifact, per platform. Checked in
 * order; the first hit wins. macOS names its bundle deterministically, so it is
 * matched directly, while the Windows and Linux artifacts carry the version in
 * their filenames and are found by extension.
 */
const DESKTOP_BUNDLE_CANDIDATES: Array<{ dir: string; exact?: string; extensions?: string[] }> = [
  { dir: "macos", exact: "Lumiverse Desktop.app" },
  { dir: "dmg", extensions: [".dmg"] },
  { dir: "msi", extensions: [".msi"] },
  { dir: "nsis", extensions: [".exe"] },
  { dir: "appimage", extensions: [".AppImage"] },
  { dir: "deb", extensions: [".deb"] },
  { dir: "rpm", extensions: [".rpm"] },
];

/**
 * Resolve the freshly built bundle so the tray can point the user straight at
 * it. Returns the bundle root when no known artifact is present — a directory
 * the user can open is more useful than reporting nothing.
 */
export function resolveDesktopBundlePath(): string | null {
  return selectDesktopBundleArtifact(
    join(PROJECT_ROOT, "desktop", "src-tauri", "target", "release", "bundle"),
  );
}

/** The artifact-picking half of {@link resolveDesktopBundlePath}, taking an
 * explicit root so it can be exercised against fixtures. */
export function selectDesktopBundleArtifact(bundleRoot: string): string | null {
  if (!existsSync(bundleRoot)) return null;

  for (const candidate of DESKTOP_BUNDLE_CANDIDATES) {
    const dir = join(bundleRoot, candidate.dir);
    if (!existsSync(dir)) continue;

    if (candidate.exact) {
      const exact = join(dir, candidate.exact);
      if (existsSync(exact)) return exact;
      continue;
    }

    // Newest by mtime, not last by name: `bundle/` is never cleared, so a
    // stale artifact from an earlier version can sit beside the fresh one,
    // and "0.9.0" sorts after "0.10.0" lexicographically.
    const match = readdirSync(dir)
      .filter((entry) => candidate.extensions?.some((ext) => entry.endsWith(ext)))
      .map((entry) => ({ entry, mtimeMs: statSync(join(dir, entry)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (match) return join(dir, match.entry);
  }

  return bundleRoot;
}

/**
 * Build the desktop shell in place.
 *
 * Deliberately not wrapped in `runWithServerStopped`. The frontend rebuild
 * stops the server because it replaces the bundle the server is actively
 * serving; a Tauri build only writes to `desktop/src-tauri/target`, which
 * nothing serves. Users can keep chatting while it compiles.
 *
 * Note this cannot replace the running tray — it produces a bundle, and
 * installing it is a separate step.
 */
export async function rebuildDesktopShell(
  reportProgress?: ProgressReporter,
  options: { mirrorOutput?: boolean } = {},
): Promise<string | null> {
  const desktopDir = join(PROJECT_ROOT, "desktop");
  if (!existsSync(join(desktopDir, "src-tauri"))) {
    throw new Error("This checkout has no desktop/src-tauri directory to build");
  }

  log("Rebuilding the desktop shell...");
  const deadline = Date.now() + TIMEOUT_DESKTOP_BUILD_MS;
  const env = desktopBuildEnv();
  const msvc = process.platform === "win32" ? await resolveWindowsMsvc({ env }) : null;
  if (msvc && !msvc.ready) throw new Error(`MSVC build tools: ${msvc.detail}`);

  for (const step of DESKTOP_BUILD_STEPS) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) {
      throw new Error(
        `${step.label} did not start because the desktop build exceeded its ${TIMEOUT_DESKTOP_BUILD_MS / 60_000}m timeout`,
      );
    }

    reportProgress?.(step.progress);
    log(step.progress);
    const command = step.command ? [...step.command] : bunInstallCmd();
    const buildCommand = step.command && msvc?.vcvarsall && msvc.architecture
      ? windowsMsvcCommand(command, msvc.vcvarsall, msvc.architecture, env)
      : command;
    await runCommandOrThrow(buildCommand, {
      cwd: desktopDir,
      timeoutMs,
      label: step.label,
      env,
      windowsVerbatimArguments: buildCommand !== command,
      onOutput: options.mirrorOutput
        ? (source, text) => (source === "stdout" ? process.stdout : process.stderr).write(text)
        : undefined,
    });
  }

  log("Desktop shell rebuilt successfully.");
  return resolveDesktopBundlePath();
}

export async function rebuildFrontend(
  frontendDir: string,
  reportProgress?: ProgressReporter,
): Promise<void> {
  await ensureFrontendDependencyTreeHealthy(frontendDir);
  log("Rebuilding frontend...");
  const deadline = Date.now() + TIMEOUT_BUN_BUILD_MS;

  for (const step of FRONTEND_BUILD_STEPS) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) {
      throw new Error(
        `${step.label} did not start because the frontend build exceeded its ${TIMEOUT_BUN_BUILD_MS / 1000}s timeout`,
      );
    }

    reportProgress?.(step.progress);
    log(step.progress);
    await runCommandOrThrow(bunRuntimeCmd([...step.command].slice(1)), {
      cwd: frontendDir,
      timeoutMs,
      label: step.label,
    });
  }
  log("Frontend rebuilt successfully.");
}

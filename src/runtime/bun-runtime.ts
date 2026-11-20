import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";

export const MINIMUM_BUN_VERSION = "1.4.4";
export const BUN_EXECUTABLE_ENV = "LUMIVERSE_BUN_EXECUTABLE";

interface RuntimeEnvironment {
  [key: string]: string | undefined;
}

export function meetsBunVersion(value: string, minimum: string): boolean {
  const parse = (text: string): number[] => text
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  const actual = parse(value);
  const required = parse(minimum);
  const length = Math.max(actual.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

/** Read the floor at use time so a long-running runner notices pulled updates. */
export function requiredBunVersion(projectRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      engines?: { bun?: unknown };
      packageManager?: unknown;
    };
    const engine = typeof manifest.engines?.bun === "string" ? manifest.engines.bun : "";
    const engineMatch = engine.match(/(\d+\.\d+\.\d+)/);
    const manager = typeof manifest.packageManager === "string" ? manifest.packageManager : "";
    const managerMatch = manager.match(/^bun@(\d+\.\d+\.\d+)/);
    const declared = engineMatch?.[1] || managerMatch?.[1];
    // A pulled manifest can raise the floor for an older runner, but an old
    // or partially updated manifest cannot lower this runtime's safety floor.
    if (declared && meetsBunVersion(declared, MINIMUM_BUN_VERSION)) return declared;
  } catch {
    // The compiled-in floor still gives a useful failure when the manifest is
    // temporarily unreadable during a checkout operation.
  }
  return MINIMUM_BUN_VERSION;
}

export function windowsRuntimeRoot(
  minimum: string,
  env: RuntimeEnvironment = process.env,
  projectRoot: string = resolve(import.meta.dir, "../.."),
): string {
  const base = env.LOCALAPPDATA
    || (env.USERPROFILE ? win32.join(env.USERPROFILE, "AppData", "Local") : "");
  return base
    ? win32.join(base, "Lumiverse", "runtimes", `bun-${minimum}`)
    : join(projectRoot, "data", ".bun-runtime", `bun-${minimum}`);
}

export function configuredBunExecutable(env: RuntimeEnvironment = process.env): string {
  return env[BUN_EXECUTABLE_ENV] || process.execPath;
}

/**
 * Non-Windows launchers may have reached the current Bun through an external
 * compatibility wrapper (for example Termux `grun`). If this process already
 * satisfies the floor, it is authoritative: respawning `process.execPath` just
 * to probe it can discard that wrapper even though the current runtime works.
 */
export function canTrustCurrentBunRuntime(
  value: string,
  minimum: string,
  target: NodeJS.Platform = process.platform,
): boolean {
  return target !== "win32" && meetsBunVersion(value, minimum);
}

function runtimePath(root: string, target: NodeJS.Platform): string {
  return target === "win32" ? win32.join(root, "bin", "bun.exe") : join(root, "bin", "bun");
}

async function probeVersion(executable: string): Promise<string | null> {
  if (!existsSync(executable)) return null;
  try {
    const proc = Bun.spawn({
      cmd: [executable, "--version"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? output.trim().split(/\s+/)[0] ?? null : null;
  } catch {
    return null;
  }
}

function withRuntimeOnPath(env: RuntimeEnvironment, executable: string): RuntimeEnvironment {
  const next: RuntimeEnvironment = { ...env, [BUN_EXECUTABLE_ENV]: executable };
  const isWindows = process.platform === "win32";
  const separator = isWindows ? ";" : delimiter;
  const pathKeys = Object.keys(next).filter((key) => isWindows ? key.toLowerCase() === "path" : key === "PATH");
  const current = pathKeys.map((key) => next[key]).filter(Boolean).join(separator);
  for (const key of pathKeys) delete next[key];
  const runtimeDir = isWindows ? win32.dirname(executable) : dirname(executable);
  next.PATH = [runtimeDir, current].filter(Boolean).join(separator);
  return next;
}

async function installWindowsRuntime(
  projectRoot: string,
  installRoot: string,
  minimum: string,
): Promise<void> {
  const installer = join(projectRoot, "scripts", "install-bun-runtime.ps1");
  const proc = Bun.spawn({
    cmd: [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", installer,
      "-InstallRoot", installRoot,
      "-MinimumVersion", minimum,
    ],
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Bun runtime installer exited with code ${exitCode}`);
}

/**
 * Return a runtime that satisfies the checkout's current engine floor.
 *
 * Windows uses a versioned side-by-side install because the runner itself may
 * be holding the user's normal bun.exe open. That also avoids the npm Bun
 * shim problem where `bun upgrade` updates a temporary executable while the
 * shell continues to resolve an older ~/.bun copy.
 */
export async function ensureBunRuntime(
  projectRoot: string,
  target: NodeJS.Platform = process.platform,
  env: RuntimeEnvironment = process.env,
): Promise<string> {
  const minimum = requiredBunVersion(projectRoot);

  // A packaged release owns its pinned runtime. Never replace it through the
  // Windows side-by-side installer or select a separate system runtime.
  if (env.LUMIVERSE_BUNDLE_ID) {
    if (!meetsBunVersion(Bun.version, minimum)) throw new Error(`This server bundle requires Bun >= ${minimum}. Download a newer server artifact.`);
    process.env[BUN_EXECUTABLE_ENV] = process.execPath;
    return process.execPath;
  }

  // On native Termux, start.sh may have launched this exact Bun binary through
  // grun/proot. The raw process.execPath is not executable by Android itself,
  // so probing it would incorrectly report a working Bun as too old.
  if (canTrustCurrentBunRuntime(Bun.version, minimum, target)) {
    process.env[BUN_EXECUTABLE_ENV] = process.execPath;
    return process.execPath;
  }

  const configured = env[BUN_EXECUTABLE_ENV];
  const localRoot = windowsRuntimeRoot(minimum, env, projectRoot);
  const localRuntime = runtimePath(localRoot, target);
  const candidates = [configured, process.execPath, localRuntime].filter(
    (candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    const version = await probeVersion(candidate);
    if (version && meetsBunVersion(version, minimum)) {
      process.env[BUN_EXECUTABLE_ENV] = candidate;
      return candidate;
    }
  }

  if (target !== "win32") {
    throw new Error(`Bun ${Bun.version} is too old — Lumiverse requires Bun >= ${minimum}. Run ./start.sh to upgrade.`);
  }

  console.warn(`[startup] Bun ${Bun.version} is below the required ${minimum}; installing the supported Windows runtime...`);
  await installWindowsRuntime(projectRoot, localRoot, minimum);
  const installedVersion = await probeVersion(localRuntime);
  if (!installedVersion || !meetsBunVersion(installedVersion, minimum)) {
    throw new Error(`The installed Bun runtime does not satisfy the required version ${minimum}.`);
  }
  process.env[BUN_EXECUTABLE_ENV] = localRuntime;
  return localRuntime;
}

/** Re-run a directly launched script under the validated runtime and proxy it. */
export async function bootstrapBunRuntime(projectRoot: string): Promise<void> {
  const executable = await ensureBunRuntime(projectRoot);
  const normalize = (path: string): string => process.platform === "win32"
    ? win32.normalize(path).toLowerCase()
    : resolve(path);
  if (normalize(executable) === normalize(process.execPath)) return;

  const minimum = requiredBunVersion(projectRoot);
  console.log(`[startup] Restarting Lumiverse with Bun >= ${minimum}...`);
  const child = Bun.spawn({
    cmd: [executable, ...process.argv.slice(1)],
    cwd: process.cwd(),
    env: withRuntimeOnPath(process.env, executable),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  // When this is the backend child of an older runner, the runner owns this
  // proxy PID. Forward its lifecycle signals to the replacement process so a
  // normal restart still shuts down databases/workers cleanly and cannot leave
  // the upgraded backend orphaned.
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    try { child.kill(signal); } catch {}
    if (signal === "SIGTERM" && forceKill === null) {
      forceKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 10_000);
    }
  };
  const onSigterm = (): void => forwardSignal("SIGTERM");
  const onSigint = (): void => forwardSignal("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  const exitCode = await child.exited;
  if (forceKill !== null) clearTimeout(forceKill);
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
  process.exit(exitCode);
}

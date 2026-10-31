import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnAsync } from "./lib/spawn-async.js";
import {
  FRONTEND_BUILD_STEPS,
  backendDependencyProbeCmd,
  bunInstallCmd,
  bunInstallTimeoutMs,
  bunRuntimeCmd,
  desktopBuildEnv,
  dependencyInstallStampIsStale,
  frontendDependencyProbeCmd,
  hardSyncRefusalMessage,
  inspectDependencyTree,
  packageInstallInputsChanged,
  planChangedDependencies,
  prepareDependencyInstall,
  restoreDependencyInstall,
  runWithServerStopped,
} from "./git-ops.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-git-ops-"));
  tempDirs.push(dir);
  return dir;
}

function writePackageJson(
  dir: string,
  packageNames: { dependencies?: string[]; devDependencies?: string[] },
): void {
  const manifest = {
    name: "runner-install-fixture",
    dependencies: Object.fromEntries((packageNames.dependencies ?? []).map((name) => [name, "1.0.0"])),
    devDependencies: Object.fromEntries((packageNames.devDependencies ?? []).map((name) => [name, "1.0.0"])),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

function installPackage(dir: string, packageName: string): void {
  const packageDir = join(dir, "node_modules", ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
}

function installEsmPackage(dir: string, packageName: string, source: string): void {
  const packageDir = join(dir, "node_modules", ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: packageName,
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(join(packageDir, "index.js"), source);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a manual install without a runner stamp", () => {
  const dir = makeTempDir();
  writePackageJson(dir, {
    dependencies: ["hono"],
    devDependencies: ["bun-types"],
  });
  installPackage(dir, "hono");
  installPackage(dir, "bun-types");

  expect(inspectDependencyTree(dir)).toEqual({
    hasNodeModules: true,
    hasStamp: false,
    missingPackages: [],
  });

  const prepared = prepareDependencyInstall(dir, "backend");
  expect(prepared.backupDir).toBeNull();
  expect(existsSync(join(dir, "node_modules", ".lumiverse-install-complete"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "hono"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "bun-types"))).toBe(true);
});

test("treats an empty direct package directory as an incomplete install", () => {
  const dir = makeTempDir();
  writePackageJson(dir, { dependencies: ["linkedom"] });
  mkdirSync(join(dir, "node_modules", "linkedom"), { recursive: true });

  expect(inspectDependencyTree(dir).missingPackages).toEqual(["linkedom"]);
});

test("uses copyfile installs on Windows", () => {
  expect(bunInstallCmd("win32")).toEqual(["bun", "install", "--backend=copyfile"]);
  expect(bunInstallCmd("linux")).toEqual(["bun", "install"]);
});

test("uses the runtime selected by the Windows version bootstrap", () => {
  const env = { LUMIVERSE_BUN_EXECUTABLE: "C:\\Lumiverse\\bun-1.4.2\\bin\\bun.exe" };
  expect(bunInstallCmd("win32", env)).toEqual([
    env.LUMIVERSE_BUN_EXECUTABLE,
    "install",
    "--backend=copyfile",
  ]);
  expect(bunRuntimeCmd(["--version"], env)).toEqual([
    env.LUMIVERSE_BUN_EXECUTABLE,
    "--version",
  ]);
});

test("desktop builds retain Windows Path and the Bun that started the runner", () => {
  const env = desktopBuildEnv(
    { Path: "C:\\Windows\\System32;C:\\TOOLS\\BUN", PATH: "C:\\Other\\bin", SYSTEMROOT: "C:\\Windows" },
    "C:\\Tools\\Bun\\bun.exe",
    "C:\\Users\\Alice\\.cargo\\bin",
    "win32",
  );

  expect(env).toEqual({
    SYSTEMROOT: "C:\\Windows",
    PATH: "C:\\Tools\\Bun;C:\\Users\\Alice\\.cargo\\bin;C:\\Windows\\System32;C:\\Other\\bin",
  });
});

test("desktop builds find Bun even if it is absent from the inherited PATH", async () => {
  if (process.platform === "win32") return;

  const env = desktopBuildEnv({ PATH: "/no/bun/on/path" }, process.execPath, "/no/cargo", process.platform);
  const result = await spawnAsync(["bun", "--version"], { env });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(Bun.version);
});

test("wraps native Termux installs in proot using the detected Bun launcher", () => {
  expect(bunInstallCmd("linux", {
    LUMIVERSE_IS_TERMUX: "true",
    LUMIVERSE_BUN_METHOD: "direct",
    LUMIVERSE_BUN_PATH: "/data/data/com.termux/files/home/.bun/bin/bun",
  })).toEqual([
    "proot",
    "--link2symlink",
    "-0",
    "/data/data/com.termux/files/home/.bun/bin/bun",
    "install",
    "--backend=copyfile",
    "--ignore-scripts",
  ]);

  expect(bunInstallCmd("linux", {
    LUMIVERSE_IS_TERMUX: "true",
    LUMIVERSE_BUN_METHOD: "grun",
    LUMIVERSE_BUN_PATH: "/data/data/com.termux/files/home/.bun/bin/bun",
  }).slice(0, 5)).toEqual([
    "proot",
    "--link2symlink",
    "-0",
    "grun",
    "/data/data/com.termux/files/home/.bun/bin/bun",
  ]);
});

test("validates backend and frontend dependencies with the same Termux runtime wrapper", () => {
  const env = {
    LUMIVERSE_IS_TERMUX: "true",
    LUMIVERSE_BUN_METHOD: "grun",
    LUMIVERSE_BUN_PATH: "/data/data/com.termux/files/home/.bun/bin/bun",
  };

  expect(bunRuntimeCmd(["--version"], env)).toEqual([
    "grun",
    env.LUMIVERSE_BUN_PATH,
    "--version",
  ]);

  const probe = backendDependencyProbeCmd(env);
  expect(probe.slice(0, 2)).toEqual(["grun", env.LUMIVERSE_BUN_PATH]);
  expect(probe.at(-1)).toContain("import('better-auth')");
  expect(probe.at(-1)).toContain("import('@better-auth/oauth-provider')");
  expect(probe.at(-1)).toContain("configureSharpNativeOverride()");
  expect(probe.at(-1)).toContain("import('sharp')");
  expect(probe.at(-1)).toContain(".png().toBuffer()");
  expect(probe.at(-1)).not.toMatch(/\s/);

  const frontendProbe = frontendDependencyProbeCmd(env);
  expect(frontendProbe.slice(0, 2)).toEqual(["grun", env.LUMIVERSE_BUN_PATH]);
  expect(frontendProbe.at(-1)).toContain("import('@better-auth/oauth-provider/client')");
  expect(frontendProbe.at(-1)).not.toMatch(/\s/);
});

test("Better Auth validation detects a missing exported core subpath", () => {
  const dir = makeTempDir();
  const coreDir = join(dir, "node_modules", "@better-auth", "core");
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, "package.json"), JSON.stringify({
    name: "@better-auth/core",
    version: "1.0.0",
    type: "module",
    exports: { "./context": "./context.js" },
  }));
  const contextPath = join(coreDir, "context.js");
  writeFileSync(contextPath, "export const context = {};\n");
  installEsmPackage(dir, "better-auth", "import '@better-auth/core/context';\n");
  installEsmPackage(dir, "@better-auth/oauth-provider", "import '@better-auth/core/context';\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/sharp-preflight.ts"), "export async function configureSharpNativeOverride() {}\n");
  installEsmPackage(dir, "sharp", "export default () => ({ png: () => ({ toBuffer: async () => Buffer.from('png') }) });\n");

  const runProbe = () => Bun.spawnSync({
    cmd: backendDependencyProbeCmd({}),
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(runProbe().exitCode).toBe(0);
  rmSync(contextPath);
  expect(runProbe().exitCode).not.toBe(0);
});

test("backend validation rejects an installed Sharp package whose native engine cannot load", () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/sharp-preflight.ts"), "export async function configureSharpNativeOverride() {}\n");
  installEsmPackage(dir, "sharp", "throw new Error('Could not load sharp using the android-arm64 runtime');\n");
  const probe = Bun.spawnSync({ cmd: backendDependencyProbeCmd({}), cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode).not.toBe(0);
  expect(probe.stderr.toString()).toContain("Could not load sharp");
});

test("frontend dependency validation detects a missing transitive Better Auth module", () => {
  const dir = makeTempDir();
  const coreDir = join(dir, "node_modules", "@better-auth", "core");
  const coreUtilsDir = join(coreDir, "utils");
  const coreContextDir = join(coreDir, "context");
  mkdirSync(coreUtilsDir, { recursive: true });
  mkdirSync(coreContextDir, { recursive: true });
  writeFileSync(join(coreDir, "package.json"), JSON.stringify({
    name: "@better-auth/core",
    version: "1.0.0",
    type: "module",
    exports: { "./utils/json": "./utils/json.js" },
  }));
  writeFileSync(
    join(coreUtilsDir, "json.js"),
    "import '../context/global.js'; export const safeJSONParse = JSON.parse;\n",
  );
  const globalPath = join(coreContextDir, "global.js");
  writeFileSync(globalPath, "export const context = {};\n");

  const oauthDir = join(dir, "node_modules", "@better-auth", "oauth-provider");
  mkdirSync(oauthDir, { recursive: true });
  writeFileSync(join(oauthDir, "package.json"), JSON.stringify({
    name: "@better-auth/oauth-provider",
    version: "1.0.0",
    type: "module",
    exports: { "./client": "./client.js" },
  }));
  writeFileSync(
    join(oauthDir, "client.js"),
    "import { safeJSONParse } from '@better-auth/core/utils/json'; export { safeJSONParse };\n",
  );

  const runProbe = () => Bun.spawnSync({
    cmd: frontendDependencyProbeCmd({}),
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(runProbe().exitCode).toBe(0);
  rmSync(globalPath);
  expect(runProbe().exitCode).not.toBe(0);
});

test("uses a longer install timeout only on Termux-like runtimes", () => {
  expect(bunInstallTimeoutMs({})).toBe(10 * 60_000);
  expect(bunInstallTimeoutMs({ LUMIVERSE_IS_TERMUX: "true" })).toBe(30 * 60_000);
  expect(bunInstallTimeoutMs({ LUMIVERSE_IS_PROOT: "true" })).toBe(30 * 60_000);
});

test("detects dependency inputs newer than the last completed install", () => {
  const dir = makeTempDir();
  writePackageJson(dir, { dependencies: ["hono"] });
  installPackage(dir, "hono");
  prepareDependencyInstall(dir, "backend");

  expect(dependencyInstallStampIsStale(dir)).toBe(false);

  const future = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "package.json"), future, future);
  expect(dependencyInstallStampIsStale(dir)).toBe(true);
});

test("runner rebuilds run every package generation step before bundling", () => {
  const { scripts } = JSON.parse(readFileSync(join(import.meta.dir, "../../frontend/package.json"), "utf8"));
  const generationCommands = scripts.generate.split(/\s*&&\s*/).map((command: string) => {
    const name = command.replace(/^bun run /, "");
    return scripts[name].split(/\s+/);
  });
  expect(FRONTEND_BUILD_STEPS.slice(0, -1).map((step) => [...step.command])).toEqual(generationCommands);
});

test("reports frontend build phases separately while preserving their order", () => {
  expect(FRONTEND_BUILD_STEPS.map(({ label, command }) => ({ label, command }))).toEqual([
    {
      label: "frontend component metadata extraction",
      command: ["bun", "run", "scripts/extract-props.ts"],
    },
    {
      label: "frontend CSS variable extraction",
      command: ["bun", "run", "scripts/extract-css-vars.ts"],
    },
    {
      label: "frontend theme reference generation",
      command: ["bun", "run", "scripts/generate-theme-reference.ts"],
    },
    {
      label: "frontend Vite bundling",
      command: ["bun", "run", "scripts/build-frontend.ts"],
    },
  ]);
});

test("runs frontend build entrypoints directly through the selected Termux Bun wrapper", () => {
  const env = {
    LUMIVERSE_IS_TERMUX: "true",
    LUMIVERSE_BUN_METHOD: "grun",
    LUMIVERSE_BUN_PATH: "/data/data/com.termux/files/home/.bun/bin/bun",
  };

  expect(FRONTEND_BUILD_STEPS.map((step) =>
    bunRuntimeCmd([...step.command].slice(1), env),
  )).toEqual([
    ["grun", env.LUMIVERSE_BUN_PATH, "run", "scripts/extract-props.ts"],
    ["grun", env.LUMIVERSE_BUN_PATH, "run", "scripts/extract-css-vars.ts"],
    ["grun", env.LUMIVERSE_BUN_PATH, "run", "scripts/generate-theme-reference.ts"],
    ["grun", env.LUMIVERSE_BUN_PATH, "run", "scripts/build-frontend.ts"],
  ]);
});

test("explains how to resolve a hard-sync refusal without losing local commits", () => {
  expect(hardSyncRefusalMessage("staging", "origin/staging", 3)).toBe(
    "Cannot update 'staging' because it has 3 local commits not present on origin/staging. Push them or move them to another branch before retrying; automatic updates will not discard local commits.",
  );
  expect(hardSyncRefusalMessage("main", "origin/main", 1)).toContain("1 local commit not present");
});

test("restores the previous dependency tree after a failed repair attempt", () => {
  const dir = makeTempDir();
  writePackageJson(dir, {
    dependencies: ["hono", "@types/node"],
  });
  installPackage(dir, "hono");

  const prepared = prepareDependencyInstall(dir, "backend");
  expect(prepared.backupDir).not.toBeNull();
  expect(existsSync(join(dir, "node_modules"))).toBe(false);

  mkdirSync(join(dir, "node_modules"), { recursive: true });
  installPackage(dir, "not-the-right-package");

  restoreDependencyInstall(dir, "backend", prepared);

  expect(existsSync(join(dir, "node_modules", "hono"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "@types", "node"))).toBe(false);
  expect(existsSync(join(dir, "node_modules", ".lumiverse-install-complete"))).toBe(false);
});

test("restarts the server after a stopped operation fails", async () => {
  const calls: string[] = [];

  await expect(runWithServerStopped(
    "test operation",
    async () => { calls.push("stop"); },
    async () => { calls.push("start"); },
    async () => {
      calls.push("operation");
      throw new Error("build failed");
    },
  )).rejects.toThrow("build failed");

  expect(calls).toEqual(["stop", "operation", "start"]);
});

test("starts the server once after a stopped operation succeeds", async () => {
  const calls: string[] = [];

  await runWithServerStopped(
    "test operation",
    async () => { calls.push("stop"); },
    async () => { calls.push("start"); },
    async () => { calls.push("operation"); },
  );

  expect(calls).toEqual(["stop", "operation", "start"]);
});

test("repairs Termux native bindings before a source-only frontend rebuild", () => {
  expect(planChangedDependencies(["frontend/src/App.tsx"], true)).toEqual({
    installBackend: false,
    installFrontend: false,
    repairTermuxFrontendNativeDeps: true,
  });
});

test("Termux repair paths install the same native bindings as the frontend lock inputs", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../frontend/package.json", import.meta.url), "utf8"));
  const repairSources = ["./git-ops.ts", "../../start.sh"].map((path) => (
    readFileSync(new URL(path, import.meta.url), "utf8")
  ));

  for (const [engine, binding] of [
    ["oxc-transform-react", "@oxc-transform-react/binding-android-arm64"],
    ["rolldown", "@rolldown/binding-android-arm64"],
    ["lightningcss", "lightningcss-android-arm64"],
  ]) {
    const version = manifest.optionalDependencies[binding];
    expect(version).toBe(manifest.overrides[engine] ?? manifest.devDependencies[engine]);
    for (const source of repairSources) {
      expect(source).toContain(`"${binding}@${version}"`);
    }
  }
});

test("does not duplicate the Termux binding repair after a frontend install", () => {
  expect(planChangedDependencies(["frontend/package.json"], true)).toEqual({
    installBackend: false,
    installFrontend: true,
    repairTermuxFrontendNativeDeps: false,
  });
});

test("does not repair frontend bindings for backend-only or non-Termux updates", () => {
  expect(planChangedDependencies(["src/main.ts"], true).repairTermuxFrontendNativeDeps).toBe(false);
  expect(planChangedDependencies(["frontend/src/App.tsx"], false).repairTermuxFrontendNativeDeps).toBe(false);
});

test("does not reinstall for package metadata or script-only changes", () => {
  const previous = JSON.stringify({
    version: "1.0.0",
    scripts: { build: "vite build" },
    dependencies: { vite: "1.0.0" },
  });
  const current = JSON.stringify({
    version: "1.0.1",
    scripts: { build: "bun run build-frontend.ts" },
    dependencies: { vite: "1.0.0" },
  });

  expect(packageInstallInputsChanged(previous, current)).toBe(false);
});

test("reinstalls when a package-resolution input changes or cannot be read", () => {
  const previous = JSON.stringify({
    dependencies: { vite: "1.0.0" },
    optionalDependencies: { binding: "1.0.0" },
  });
  const current = JSON.stringify({
    dependencies: { vite: "2.0.0" },
    optionalDependencies: { binding: "1.0.0" },
  });

  expect(packageInstallInputsChanged(previous, current)).toBe(true);
  expect(packageInstallInputsChanged("not json", current)).toBe(true);
});

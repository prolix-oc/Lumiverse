#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerBundleManifest } from "../src/runtime/bundle";
import { stageIntelLanceDb } from "./lancedb-macos-native";
import { unzipSync } from "fflate";

const ROOT = resolve(import.meta.dir, "..");

export function serverBuildTarget(target?: string, platform = process.platform as string, arch = process.arch as string) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Unsupported bundled server platform.");
  if (!target) return { platform, arch, cross: false };
  const windowsTargets: Record<string, string> = { "x86_64-pc-windows-msvc": "x64", "aarch64-pc-windows-msvc": "arm64" };
  const requested = windowsTargets[target];
  if (!requested || platform !== "win32" || (requested !== arch && !(arch === "x64" && requested === "arm64"))) {
    throw new Error("Server cross-compilation supports Windows x64 to Windows ARM64 only.");
  }
  return { platform, arch: requested, cross: requested !== arch };
}

export function verifyWindowsRuntime(bytes: Uint8Array, arch: string): void {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported Windows runtime architecture");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || data.getUint16(0, true) !== 0x5a4d) throw new Error("Invalid Windows Bun runtime header");
  const offset = data.getUint32(0x3c, true);
  if (offset > bytes.length - 6 || data.getUint32(offset, true) !== 0x00004550
    || data.getUint16(offset + 4, true) !== (arch === "arm64" ? 0xaa64 : 0x8664)) {
    throw new Error("Windows Bun runtime architecture does not match the server target");
  }
}

async function windowsArmRuntime(): Promise<string> {
  // Keep the embedded runtime pinned independently of the host Bun used to
  // compile the launcher. The final ARM64 runtime still needs native smoke.
  if (Bun.version !== "1.4.4") throw new Error("Update the verified ARM64 runtime checksum when changing the pinned Bun version.");
  const expected = "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09";
  const cache = join(ROOT, ".tmp", "windows-arm64-runtime", Bun.version);
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, "bun.zip");
  if (!existsSync(archive) || createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected) {
    const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}/bun-windows-aarch64.zip`);
    if (!response.ok) throw new Error(`Pinned Windows ARM64 Bun download failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Pinned Windows ARM64 Bun checksum mismatch");
    await Bun.write(archive, bytes);
  }
  const entry = "bun-windows-aarch64/bun.exe";
  const bytes = unzipSync(readFileSync(archive), { filter: (file) => file.name === entry })[entry];
  if (!bytes) throw new Error("Pinned Windows ARM64 Bun archive is missing its runtime");
  verifyWindowsRuntime(bytes, "arm64");
  const runtime = join(cache, "bun.exe");
  await Bun.write(runtime, bytes);
  return runtime;
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await process.exited !== 0) throw new Error(`Build step failed: ${cmd.join(" ")}`);
}

function git(...args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  return child.exitCode === 0 ? child.stdout.toString().trim() : "unknown";
}

/** Resolve symlinks into regular archive entries, including Windows native libraries. */
export function collectBundleFiles(root: string): { files: Record<string, Uint8Array>; executableFiles: string[] } {
  root = realpathSync(root);
  const files: Record<string, Uint8Array> = Object.create(null);
  const executableFiles: string[] = [];
  const visit = (directory: string, ancestors: Set<string>) => {
    const canonical = realpathSync(directory);
    if (ancestors.has(canonical)) throw new Error(`Cyclic directory in server payload: ${directory}`);
    const next = new Set(ancestors).add(canonical);
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const actual = realpathSync(path);
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error(`Server payload links outside its staging directory: ${path}`);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path, next);
      else if (stat.isFile()) {
        const name = relative(root, path).split(sep).join("/");
        // Bun 1.4.2 archives file-backed Blob entries as empty files. Materialize
        // bytes before creating the archive; native binaries must survive exactly.
        files[name] = readFileSync(path);
        if (stat.mode & 0o111) executableFiles.push(name);
      } else throw new Error(`Unsupported file in server payload: ${path}`);
    }
  };
  visit(root, new Set());
  return { files, executableFiles };
}

export async function writeBundleArchive(path: string, files: Record<string, Uint8Array>): Promise<void> {
  // Bun.write(Archive) writes an uncompressed tar on 1.4.2 even when compress
  // was requested. bytes() honors compression and is covered by a round-trip test.
  await Bun.write(path, await new Bun.Archive(files, { compress: "gzip", level: 6 }).bytes());
}

async function build(): Promise<void> {
  const args = process.argv.slice(2);
  let outfile: string | undefined;
  let skipFrontend = false;
  let offline = false;
  let requestedTarget: string | undefined;
  let intelLanceDbDirectory = join(ROOT, "dist/native/lancedb-darwin-x64");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--outfile" && args[i + 1]) outfile = resolve(args[++i]!);
    else if (args[i] === "--skip-frontend-build") skipFrontend = true;
    else if (args[i] === "--offline") offline = true;
    else if (args[i] === "--target" && args[i + 1]) requestedTarget = args[++i];
    else if (args[i] === "--lancedb-native-dir" && args[i + 1]) intelLanceDbDirectory = resolve(args[++i]!);
    else throw new Error(`Unknown build option: ${args[i]}`);
  }
  const target = serverBuildTarget(requestedTarget);
  if (target.cross && offline) throw new Error("An ARM64 cross-build needs its pinned runtime download; build without --offline.");
  if (process.platform === "darwin" && process.arch === "x64" && !existsSync(join(intelLanceDbDirectory, "manifest.json"))) {
    throw new Error("Build the version-matched Intel LanceDB addon first: bun run build:lancedb:macos");
  }
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  if (Bun.version !== pkg.packageManager.replace("bun@", "")) throw new Error(`Build with ${pkg.packageManager} for a reproducible runtime.`);
  if (!skipFrontend) await run([process.execPath, "run", "build"], join(ROOT, "frontend"));
  for (const name of ["index.html", "sw.js"]) if (!existsSync(join(ROOT, "frontend", "dist", name))) throw new Error(`Build the frontend first: missing frontend/dist/${name}`);
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  const staging = mkdtempSync(join(ROOT, ".tmp", "server-build-"));
  const app = join(staging, "app");
  mkdirSync(app);
  const output = outfile || join(ROOT, "dist", "server", `lumiverse-server-${target.platform}-${target.arch}${target.platform === "win32" ? ".exe" : ""}`);
  try {
    for (const name of ["package.json", "bun.lock", "tsconfig.json", "LICENSE.md"]) copyFileSync(join(ROOT, name), join(app, name));
    mkdirSync(join(app, "runtime"));
    const runtime = target.cross ? await windowsArmRuntime() : process.execPath;
    copyFileSync(runtime, join(app, "runtime", target.platform === "win32" ? "bun.exe" : "bun"));
    await run([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile",
      ...(target.cross ? ["--os=win32", "--cpu=arm64"] : []), ...(offline ? ["--offline"] : [])], app);
    if (process.platform === "darwin" && process.arch === "x64") stageIntelLanceDb(app, intelLanceDbDirectory);
    // ffmpeg-static uses an install script. Copy an already installed matching
    // binary when possible; otherwise fetch it at build time, never at launch.
    const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffmpegDir = join(app, "node_modules", "ffmpeg-static");
    const ffmpegPath = join(ffmpegDir, ffmpegName);
    if (existsSync(ffmpegDir) && !(target.platform === "win32" && target.arch === "arm64")) {
      const installed = join(ROOT, "node_modules", "ffmpeg-static");
      const installedPackage = await Bun.file(join(installed, "package.json")).json().catch(() => null);
      const stagedPackage = await Bun.file(join(ffmpegDir, "package.json")).json();
      if (installedPackage?.version === stagedPackage.version && existsSync(join(installed, ffmpegName))) {
        for (const name of readdirSync(installed).filter((name) => name === ffmpegName || name.startsWith(ffmpegName + "."))) copyFileSync(join(installed, name), join(ffmpegDir, name));
      } else {
        if (offline) throw new Error("The offline build needs an installed ffmpeg-static binary. Install it or build without --offline.");
        await run([process.execPath, "install.js"], ffmpegDir);
      }
    }
    cpSync(join(ROOT, "src"), join(app, "src"), { recursive: true, filter: (path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !["test-fixtures", "__tests__"].includes(path.split(sep).at(-1)!) });
    mkdirSync(join(app, "scripts"));
    for (const name of ["reset-password.ts", "input.ts", "ui.ts"]) copyFileSync(join(ROOT, "scripts", name), join(app, "scripts", name));
    cpSync(join(ROOT, "frontend", "dist"), join(app, "frontend", "dist"), { recursive: true });
    copyFileSync(join(ROOT, "frontend", "package.json"), join(app, "frontend", "package.json"));
    cpSync(join(ROOT, "user-docs", "docs"), join(app, "user-docs", "docs"), { recursive: true });
    const { files, executableFiles } = collectBundleFiles(realpathSync(app));
    const requiredFiles = ["src/index.ts", "src/db/baseline.sql", "src/db/execution-subprocess.ts", "frontend/dist/index.html", "src/runtime/bundled-check.ts", "package.json", `runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`,
      ...Object.keys(files).filter((path) => /\.(node|dylib|dll|so(?:\.\d+)*)$/.test(path))];
    console.log(`[bundle] Archiving ${Object.keys(files).length} files for ${target.platform}-${target.arch}...`);
    const archivePath = join(staging, "payload.tar.gz");
    await writeBundleArchive(archivePath, files);
    const payloadSha256 = createHash("sha256").update(await Bun.file(archivePath).bytes()).digest("hex");
    const manifest: ServerBundleManifest = {
      format: 1, version: pkg.version, bunVersion: Bun.version, platform: target.platform, arch: target.arch,
      branch: git("rev-parse", "--abbrev-ref", "HEAD"), commit: git("rev-parse", "--short", "HEAD"),
      payloadSha256, executableFiles, requiredFiles, ffmpeg: existsSync(ffmpegPath),
    };
    await Bun.write(join(staging, "manifest.json"), JSON.stringify(manifest));
    const entry = join(staging, "launcher.ts");
    await Bun.write(entry, `import archive from "./payload.tar.gz" with { type: "file" };\nimport manifest from "./manifest.json";\nimport { runBundledServer } from ${JSON.stringify(join(ROOT, "src/runtime/bundled-launcher.ts"))};\ntry { await runBundledServer(archive, manifest as any); } catch (error) { console.error("[bundle]", error instanceof Error ? error.message : error); process.exitCode = 1; }\n`);
    mkdirSync(dirname(output), { recursive: true });
    const result = await Bun.build({ entrypoints: [entry], minify: true, sourcemap: "linked",
      compile: { outfile: output, autoloadDotenv: false, autoloadBunfig: false,
        ...(target.cross ? { target: "bun-windows-arm64" as const } : {}) } });
    if (!result.success) throw new AggregateError(result.logs, "Server executable compilation failed");
    const sha256 = createHash("sha256").update(await Bun.file(output).bytes()).digest("hex");
    await Bun.write(output + ".json", JSON.stringify({ ...manifest, executableFiles: undefined, requiredFiles: undefined, sha256 }, null, 2) + "\n");
    await Bun.write(output + ".sha256", `${sha256}  ${output.split(sep).at(-1)}\n`);
    console.log(`[bundle] Built ${output} (${(Bun.file(output).size / 1024 ** 2).toFixed(1)} MiB). Run it with --check to verify the extracted runtime.`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (import.meta.main) await build();

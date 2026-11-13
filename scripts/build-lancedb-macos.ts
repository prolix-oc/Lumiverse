#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { INTEL_LANCEDB, INTEL_LANCEDB_RELEASE_PROFILE, intelLanceDbBuildId, readIntelLanceDbArtifact, validateIntelMachO, type IntelLanceDbManifest } from "./lancedb-macos-native";

const root = resolve(import.meta.dir, "..");

async function run(cmd: string[], cwd: string, env?: Record<string, string | undefined>): Promise<void> {
  const child = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${cmd.join(" ")}`);
}

function capture(cmd: string[], cwd = root): string {
  const child = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${child.stderr.toString().trim()}`);
  return child.stdout.toString().trim();
}

function visitSourceFiles(directory: string, visit: (path: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visitSourceFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

async function build(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Build the Intel LanceDB addon on macOS with the Apple SDK.");
  const args = process.argv.slice(2);
  let sourceDirectory: string | undefined;
  let outputDirectory = join(root, "dist/native/lancedb-darwin-x64");
  let prepareOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-dir" && args[i + 1]) sourceDirectory = resolve(args[++i]!);
    else if (args[i] === "--out-dir" && args[i + 1]) outputDirectory = resolve(args[++i]!);
    else if (args[i] === "--prepare-only") prepareOnly = true;
    else throw new Error(`Unknown Intel LanceDB build option: ${args[i]}`);
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@lancedb/lancedb"];
  if (version !== INTEL_LANCEDB.version) throw new Error("Update the Intel LanceDB source pin to match package.json before building.");
  const cache = join(root, ".tmp/lancedb-macos", version);
  mkdirSync(cache, { recursive: true });
  const upstream = sourceDirectory || join(cache, "upstream");
  if (!existsSync(upstream)) {
    if (sourceDirectory) throw new Error(`Missing source checkout: ${upstream}`);
    await run(["git", "clone", "--depth", "1", "--branch", `v${version}`, "https://github.com/lancedb/lancedb.git", upstream], root);
  }
  const commit = capture(["git", "rev-parse", `v${version}^{commit}`], upstream);
  if (commit !== INTEL_LANCEDB.sourceCommit) throw new Error("LanceDB source tag does not match the pinned commit.");
  const source = join(cache, "source");
  // Bun extraction resets mtimes. Retain them only when the pinned file bytes
  // are unchanged, so a retry can reuse Cargo's expensive release compilation.
  const previous = new Map<string, { digest: string; atime: Date; mtime: Date }>();
  visitSourceFiles(source, (path) => {
    const stat = statSync(path);
    previous.set(path, { digest: createHash("sha256").update(readFileSync(path)).digest("hex"), atime: stat.atime, mtime: stat.mtime });
  });
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source);
  // Archive the pinned commit, excluding local patches, .git, node_modules, and build outputs.
  const snapshot = Bun.spawnSync(["git", "archive", commit], { cwd: upstream, stdout: "pipe", stderr: "pipe" });
  if (snapshot.exitCode !== 0) throw new Error(snapshot.stderr.toString());
  await new Bun.Archive(snapshot.stdout).extract(source);
  visitSourceFiles(source, (path) => {
    const old = previous.get(path);
    if (old && old.digest === createHash("sha256").update(readFileSync(path)).digest("hex")) utimesSync(path, old.atime, old.mtime);
  });
  const sourcePackage = JSON.parse(readFileSync(join(source, "nodejs/package.json"), "utf8"));
  const toolchain = Bun.TOML.parse(readFileSync(join(source, "rust-toolchain.toml"), "utf8")) as { toolchain: { channel: string } };
  if (sourcePackage.version !== version || toolchain.toolchain.channel !== INTEL_LANCEDB.rustToolchain) throw new Error("Unexpected source version or Rust toolchain.");
  console.log(`[lancedb-macos] Prepared ${version} (${commit}) in ${source}`);
  if (prepareOnly) return;
  for (const tool of ["rustup", "cargo", "protoc", "cmake", "clang"]) {
    if (!Bun.which(tool)) throw new Error(`Install the build prerequisite: ${tool}`);
  }
  const installed = capture(["rustup", "toolchain", "list"]);
  if (!installed.split("\n").some((line) => line.startsWith(INTEL_LANCEDB.rustToolchain + "-"))) {
    await run(["rustup", "toolchain", "install", INTEL_LANCEDB.rustToolchain, "--profile", "minimal"], root);
  }
  const targets = capture(["rustup", "target", "list", "--installed", "--toolchain", INTEL_LANCEDB.rustToolchain]);
  if (!targets.split("\n").includes(INTEL_LANCEDB.target)) {
    await run(["rustup", "target", "add", INTEL_LANCEDB.target, "--toolchain", INTEL_LANCEDB.rustToolchain], root);
  }
  const targetDirectory = join(cache, "target");
  const env: Record<string, string | undefined> = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: INTEL_LANCEDB.minimumMacOS,
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS: `-C target-cpu=${INTEL_LANCEDB.cpu}`,
    CARGO_PROFILE_RELEASE_LTO: INTEL_LANCEDB_RELEASE_PROFILE.lto,
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: String(INTEL_LANCEDB_RELEASE_PROFILE.codegenUnits),
    // Rust 1.97's LLVM strip can misalign Mach-O proc-macros on macOS 27.
    // Keep host debug tables and use Apple's strip only on the finished addon.
    CARGO_PROFILE_RELEASE_STRIP: INTEL_LANCEDB_RELEASE_PROFILE.strip,
    CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP: INTEL_LANCEDB_RELEASE_PROFILE.buildOverrideStrip,
    CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG: String(INTEL_LANCEDB_RELEASE_PROFILE.buildOverrideDebug),
    CARGO_INCREMENTAL: INTEL_LANCEDB_RELEASE_PROFILE.incremental ? "1" : "0",
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "4",
    CFLAGS: `-mmacosx-version-min=${INTEL_LANCEDB.minimumMacOS}`,
    CXXFLAGS: `-mmacosx-version-min=${INTEL_LANCEDB.minimumMacOS}`,
  };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  // The 0.41.0 tag retains beta workspace versions in Cargo.lock. Refresh only
  // workspace packages, keeping third-party dependencies pinned for --locked.
  await run(["cargo", `+${INTEL_LANCEDB.rustToolchain}`, "update", "--workspace"], source, env);
  console.log(`[lancedb-macos] Building ${INTEL_LANCEDB.target} for macOS ${INTEL_LANCEDB.minimumMacOS}, CPU ${INTEL_LANCEDB.cpu}...`);
  await run(["cargo", `+${INTEL_LANCEDB.rustToolchain}`, "build", "--manifest-path", join(source, "nodejs/Cargo.toml"), "--locked", "--release", "--target", INTEL_LANCEDB.target], source, env);
  mkdirSync(outputDirectory, { recursive: true });
  const binary = join(outputDirectory, INTEL_LANCEDB.binaryName);
  copyFileSync(join(targetDirectory, INTEL_LANCEDB.target, "release/liblancedb_nodejs.dylib"), binary);
  await run(["/usr/bin/strip", "-x", binary], root);
  const bytes = readFileSync(binary);
  validateIntelMachO(bytes);
  // otool -L also lists the dylib's own install name; it is not a dependency.
  const installName = capture(["/usr/bin/otool", "-D", binary]).split("\n")[1]?.trim();
  const dependencies = capture(["/usr/bin/otool", "-L", binary]).split("\n").slice(1).map((line) => line.trim().split(" (", 1)[0]!);
  for (const dependency of dependencies) {
    if (!dependency || dependency === installName || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) continue;
    throw new Error(`Intel LanceDB requires an unbundled dynamic library: ${dependency}`);
  }
  if (!/\b_napi_register_module_v1$/m.test(capture(["/usr/bin/nm", "-gU", binary]))) throw new Error("Missing LanceDB Node-API addon entrypoint.");
  const manifest: IntelLanceDbManifest = { format: 1, buildId: intelLanceDbBuildId(), version, sourceCommit: commit, target: INTEL_LANCEDB.target,
    rustToolchain: INTEL_LANCEDB.rustToolchain, minimumMacOS: INTEL_LANCEDB.minimumMacOS, cpu: INTEL_LANCEDB.cpu,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  copyFileSync(join(source, "LICENSE"), join(outputDirectory, "LICENSE"));
  await Bun.write(join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  readIntelLanceDbArtifact(outputDirectory, version);
  console.log(`[lancedb-macos] Built ${binary} (${(bytes.length / 1024 ** 2).toFixed(1)} MiB).`);
  if (process.arch === "x64") {
    await run([process.execPath, "--no-env-file", join(root, "scripts/check-lancedb-macos.ts"), "--artifact-dir", outputDirectory], root);
  } else console.log("[lancedb-macos] Cross-build only: execute the native checks on Intel macOS; CI uses an Intel runner.");
}

if (import.meta.main) await build();

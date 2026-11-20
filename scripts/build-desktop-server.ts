#!/usr/bin/env bun
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serverBuildTarget } from "./build-server";

const root = resolve(import.meta.dir, "..");
const targets: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu", "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
export function desktopServerTarget(args: string[], platform = process.platform as string, arch = process.arch as string) {
  const native = targets[`${platform}-${arch}`];
  if (!native) throw new Error("No bundled desktop server is available for this platform.");
  const index = args.indexOf("--target");
  const equalsFlag = args.find(arg => arg.startsWith("--target="));
  const requested = equalsFlag?.slice("--target=".length)
    ?? (index >= 0 ? args[index + 1] : undefined);
  if ((index >= 0 || equalsFlag !== undefined) && (!requested || requested.startsWith("--"))) throw new Error("--target needs a desktop target triple");
  const selected = requested && requested !== native ? serverBuildTarget(requested, platform, arch) : { platform, arch, cross: false };
  return { ...selected, target: targets[`${selected.platform}-${selected.arch}`]! };
}
async function run(cmd: string[], cwd = root) {
  const child = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${cmd.join(" ")}`);
}
async function build() {
  const pkg = await Bun.file(join(root, "package.json")).json();
  if (`bun@${Bun.version}` !== pkg.packageManager) throw new Error(`Build with ${pkg.packageManager} for a reproducible desktop runtime.`);
  const args = process.argv.slice(2);
  const selected = desktopServerTarget(args);
  const reuse = args.includes("--reuse-server");
  const stageOnly = args.includes("--stage-only");
  const tauriArgs = args.filter((arg) => !["--reuse-server", "--stage-only"].includes(arg));
  if (!reuse) await run([process.execPath, "run", "build:server", ...(selected.cross ? ["--target", selected.target] : [])]);
  const extension = selected.platform === "win32" ? ".exe" : "";
  const server = join(root, "dist/server", `lumiverse-server-${selected.platform}-${selected.arch}${extension}`);
  const metadata = await Bun.file(server + ".json").json();
  if (metadata.platform !== selected.platform || metadata.arch !== selected.arch || metadata.bunVersion !== Bun.version) throw new Error("The staged server must match the requested desktop architecture and pinned Bun version.");
  const directory = join(root, "desktop/src-tauri/binaries");
  mkdirSync(directory, { recursive: true });
  copyFileSync(server, join(directory, `lumiverse-server-${selected.target}${extension}`));
  console.log(`[desktop-bundle] Staged the ${selected.target} server.`);
  if (!stageOnly) await run([process.execPath, "run", "tauri:finalized", "build", "--config", "src-tauri/tauri.server-bundle.conf.json",
    ...(tauriArgs.includes("--debug") || tauriArgs.includes("-d") ? ["--config", "src-tauri/tauri.debug-profile.conf.json"] : []),
    ...tauriArgs], join(root, "desktop"));
}

if (import.meta.main) await build();

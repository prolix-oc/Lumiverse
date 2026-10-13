#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DESKTOP_DIR = join(PROJECT_ROOT, "desktop");

type GStreamerDirectoryVariable = "pluginsdir" | "pluginscannerdir";
type GStreamerDirectoryResolver = (variable: GStreamerDirectoryVariable) => string | undefined;

function resolveGStreamerDirectory(
  variable: GStreamerDirectoryVariable,
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: ["pkg-config", `--variable=${variable}`, "gstreamer-1.0"],
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    const directory = new TextDecoder().decode(result.stdout).trim();
    return directory && existsSync(directory) ? directory : undefined;
  } catch {
    return undefined;
  }
}

export function requestedAppImage(args: string[]): boolean {
  const equalsForm = args.find((arg) => arg.startsWith("--bundles="));
  const flagIndex = args.indexOf("--bundles");
  const value = equalsForm?.slice("--bundles=".length)
    ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (!value) return true;
  return value.split(",").some((bundle) => bundle === "appimage" || bundle === "all");
}

export function appImageBundleDirectory(args: string[]): string {
  const equalsForm = args.find((arg) => arg.startsWith("--target="));
  const flagIndex = args.indexOf("--target");
  const target = equalsForm?.slice("--target=".length)
    ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  const targetRoot = target
    ? join(DESKTOP_DIR, "src-tauri", "target", target)
    : join(DESKTOP_DIR, "src-tauri", "target");
  return join(targetRoot, "release", "bundle", "appimage");
}

export function tauriBuildEnvironment(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  resolveGStreamer: GStreamerDirectoryResolver = (variable) =>
    resolveGStreamerDirectory(variable, env),
): NodeJS.ProcessEnv {
  if (platform !== "linux" || args[0] !== "build" || !requestedAppImage(args)) {
    return env;
  }

  const pluginsDir = env.GSTREAMER_PLUGINS_DIR || resolveGStreamer("pluginsdir");
  const helpersDir = env.GSTREAMER_HELPERS_DIR || resolveGStreamer("pluginscannerdir");

  return {
    ...env,
    // Tauri's linuxdeploy and output plugin are AppImages themselves. Run
    // them without FUSE so source builds work on hosts without libfuse.so.2.
    APPIMAGE_EXTRACT_AND_RUN: "1",
    // linuxdeploy ships an old binutils strip that cannot read modern RELR
    // sections used by Arch/CachyOS libraries. Distribution libraries are
    // already stripped; skipping this optional pass is safe and portable.
    NO_STRIP: "1",
    // Tauri's GStreamer linuxdeploy plugin guesses Ubuntu's multiarch paths.
    // pkg-config makes the same finalized build work on Fedora and Arch and
    // ensures its AppRun hook points at the scanner copied into the image.
    ...(pluginsDir ? { GSTREAMER_PLUGINS_DIR: pluginsDir } : {}),
    ...(helpersDir ? { GSTREAMER_HELPERS_DIR: helpersDir } : {}),
  };
}

const NOTARIZATION_CREDENTIALS = [
  "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH",
] as const;

export function tauriBuildLogLine(
  line: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  // Ad hoc signing is intentional for these installers. Preserve diagnostics for any configured notarization.
  if (platform !== "darwin" || env.APPLE_SIGNING_IDENTITY !== "-"
    || NOTARIZATION_CREDENTIALS.some((key) => env[key])) return line;

  const expected = "Warn skipping app notarization, no APPLE_ID & APPLE_PASSWORD & APPLE_TEAM_ID or APPLE_API_KEY & APPLE_API_ISSUER & APPLE_API_KEY_PATH environment variables found";
  return stripVTControlCharacters(line).trim() === expected
    ? "        Info macOS installer uses ad hoc signing without notarization."
    : line;
}

export async function forwardTauriBuildStderr(
  stream: ReadableStream<Uint8Array>,
  write: (line: string) => void,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const lines = createInterface({ input: Readable.fromWeb(stream), crlfDelay: Infinity });
  for await (const line of lines) write(`${tauriBuildLogLine(line, platform, env)}\n`);
}

async function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  formatMacOSBuildLogs = false,
): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: formatMacOSBuildLogs ? "pipe" : "inherit",
  });
  const logs = formatMacOSBuildLogs && child.stderr
    ? forwardTauriBuildStderr(child.stderr, (line) => { process.stderr.write(line); }, process.platform, env)
    : Promise.resolve();
  const [exitCode] = await Promise.all([child.exited, logs]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with code ${exitCode}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await run(
    [process.execPath, "run", "tauri", ...args],
    DESKTOP_DIR,
    tauriBuildEnvironment(args),
    process.platform === "darwin" && args[0] === "build",
  );

  if (process.platform !== "linux" || args[0] !== "build" || !requestedAppImage(args)) {
    return;
  }

  await run(
    ["bash", join(PROJECT_ROOT, "scripts", "finalize-appimage.sh"), appImageBundleDirectory(args)],
    PROJECT_ROOT,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Desktop bundle finalization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

/**
 * Native installation helpers for the Tauri desktop bundle.
 *
 * The Tauri bundler creates a different kind of artifact on each platform.
 * This module turns the freshly built artifact into an installed app and
 * makes it reachable from the platform's normal launcher (plus the desktop
 * when that folder exists).
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type DesktopInstallPlatform = "darwin" | "win32" | "linux";

export interface DesktopInstallResult {
  installedPath: string;
  shortcuts: string[];
}

export interface DesktopInstallOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  runCommand?: (command: string[]) => Promise<number>;
  /** Override used by tests; normal macOS installs belong in /Applications. */
  macApplicationsDir?: string;
}

const ARTIFACT_CANDIDATES: Record<DesktopInstallPlatform, Array<{ dir: string; extension: string }>> = {
  darwin: [{ dir: "macos", extension: ".app" }],
  // Prefer NSIS: its current-user install does not require elevation and it
  // creates the Start menu shortcut as part of the normal Tauri install.
  win32: [
    { dir: "nsis", extension: ".exe" },
    { dir: "msi", extension: ".msi" },
  ],
  // AppImage supports a predictable, administrator-free local install on all
  // Linux distributions. The .desktop file below supplies shell integration.
  linux: [{ dir: "appimage", extension: ".AppImage" }],
};

const UNIX_DESKTOP_STOP_SCRIPT = String.raw`
app_name="$1"
command -v pgrep >/dev/null 2>&1 || {
  echo "Cannot stop Lumiverse Desktop because pgrep is unavailable" >&2
  exit 127
}

roots="$(pgrep -x "$app_name" 2>/dev/null || true)"
[ -n "$roots" ] || exit 0

collect_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    collect_tree "$child"
  done
  printf '%s\n' "$1"
}

tree=""
for root in $roots; do
  tree="$tree $(collect_tree "$root")"
done

# TERM gives the tray, runner and server a chance to clean up. KILL is only a
# fallback for processes that remain after five seconds.
kill -TERM $tree 2>/dev/null || true
remaining="$tree"
attempt=0
while [ "$attempt" -lt 5 ]; do
  next=""
  for pid in $remaining; do
    if kill -0 "$pid" 2>/dev/null; then next="$next $pid"; fi
  done
  remaining="$next"
  [ -n "$remaining" ] || exit 0
  sleep 1
  attempt=$((attempt + 1))
done

kill -KILL $remaining 2>/dev/null || true
sleep 1
for pid in $remaining; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "Lumiverse Desktop process $pid is still running" >&2
    exit 1
  fi
done
`;

/** Build the narrowly scoped platform command used to stop an installed app. */
export function desktopStopCommand(target: DesktopInstallPlatform): string[] {
  if (target === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$names = @('lumiverse-tray', 'Lumiverse Desktop')",
      "$processes = @(Get-Process -Name $names -ErrorAction SilentlyContinue)",
      "foreach ($process in $processes) {",
      "  & taskkill.exe /PID $process.Id /T /F | Out-Null",
      "  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {",
      "    throw \"Lumiverse Desktop process $($process.Id) could not be stopped\"",
      "  }",
      "}",
    ].join("\n");
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ];
  }

  return ["/bin/sh", "-c", UNIX_DESKTOP_STOP_SCRIPT, "lumiverse-desktop-stop", "lumiverse-tray"];
}

function newestArtifact(dir: string, extension: string): string | null {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir)
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => ({ path: join(dir, entry), mtimeMs: statSync(join(dir, entry)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  return match?.path ?? null;
}

/** Select the preferred platform-native artifact for installation. */
export function selectDesktopInstallArtifact(
  bundleRoot: string,
  target: DesktopInstallPlatform,
): string | null {
  for (const candidate of ARTIFACT_CANDIDATES[target]) {
    const artifact = newestArtifact(join(bundleRoot, candidate.dir), candidate.extension);
    if (artifact) return artifact;
  }
  return null;
}

function createDesktopSymlink(source: string, target: string): boolean {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    // existsSync follows symlinks and therefore misses a dangling shortcut.
    existing = lstatSync(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing) {
    // Refresh a shortcut from an earlier scripted install, but never replace a
    // real file or app the user placed on their desktop.
    if (!existing.isSymbolicLink()) return false;
    rmSync(target);
  }
  symlinkSync(source, target);
  return true;
}

function replaceMacApp(artifact: string, installedPath: string): void {
  // Replacing this exact app bundle is the update path for a previous install.
  // User data lives in Tauri's app-data directory, not inside the bundle.
  rmSync(installedPath, { recursive: true, force: true });
  cpSync(artifact, installedPath, { recursive: true, force: true });
}

function removeLegacyUserMacApp(homeDir: string, installedPath: string): void {
  const legacyPath = join(homeDir, "Applications", "Lumiverse Desktop.app");
  if (legacyPath === installedPath) return;

  // Early installers used ~/Applications. Leaving that bundle behind gives
  // LaunchServices two apps with the same identifier, and Spotlight may keep
  // launching the stale per-user copy after /Applications is updated. Only
  // remove a directory that has Lumiverse's exact executable layout.
  const legacyExecutable = join(legacyPath, "Contents", "MacOS", "lumiverse-tray");
  if (!existsSync(legacyExecutable)) return;
  rmSync(legacyPath, { recursive: true, force: true });
  console.log(`Removed stale legacy desktop install: ${legacyPath}`);
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "EACCES" || error.code === "EPERM");
}

function elevatedMacInstallCommand(artifact: string, installedPath: string): string[] {
  // Pass paths as AppleScript arguments so its `quoted form` handles spaces
  // and shell-significant characters before the privileged command runs.
  const script = [
    "on run argv",
    "  set sourcePath to item 1 of argv",
    "  set targetPath to item 2 of argv",
    "  set commandText to \"/bin/rm -rf \" & quoted form of targetPath & \" && /usr/bin/ditto \" & quoted form of sourcePath & \" \" & quoted form of targetPath",
    "  do shell script commandText with administrator privileges",
    "end run",
  ].join("\n");
  return ["/usr/bin/osascript", "-e", script, "--", artifact, installedPath];
}

async function installMacApp(
  artifact: string,
  homeDir: string,
  applicationsDir: string,
  runCommand: (command: string[]) => Promise<number>,
): Promise<DesktopInstallResult> {
  const installedPath = join(applicationsDir, "Lumiverse Desktop.app");
  mkdirSync(applicationsDir, { recursive: true });

  try {
    replaceMacApp(artifact, installedPath);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    const exitCode = await runCommand(elevatedMacInstallCommand(artifact, installedPath));
    if (exitCode !== 0) {
      throw new Error(`macOS application install exited with code ${exitCode}`);
    }
  }
  removeLegacyUserMacApp(homeDir, installedPath);

  const shortcuts = [installedPath];
  const desktopDir = join(homeDir, "Desktop");
  if (existsSync(desktopDir)) {
    const desktopShortcut = join(desktopDir, "Lumiverse Desktop.app");
    if (createDesktopSymlink(installedPath, desktopShortcut)) shortcuts.push(desktopShortcut);
  }

  // Tauri leaves the bundle under target/release/bundle/macos. Spotlight
  // indexes that copy too, so consume the build artifact only after the
  // installed app and its optional shortcut have been staged successfully.
  rmSync(artifact, { recursive: true, force: true });

  // A raw filesystem copy does not always notify LaunchServices immediately.
  // Register the final path and ask Spotlight to import its bundle metadata so
  // it appears promptly in system application search surfaces.
  const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  const registrationExitCode = await runCommand([launchServices, "-f", installedPath]);
  if (registrationExitCode !== 0) {
    console.warn(`Lumiverse Desktop was installed, but LaunchServices registration exited with code ${registrationExitCode}.`);
  }
  const spotlightExitCode = await runCommand(["/usr/bin/mdimport", installedPath]);
  if (spotlightExitCode !== 0) {
    console.warn(`Lumiverse Desktop was installed, but Spotlight import exited with code ${spotlightExitCode}.`);
  }
  return { installedPath, shortcuts };
}

function expandUserDir(value: string, homeDir: string): string | null {
  const expanded = value
    .replace(/^\$HOME(?=\/|$)/, homeDir)
    .replace(/^\$\{HOME\}(?=\/|$)/, homeDir);
  return expanded.startsWith("/") ? expanded : null;
}

/** Resolve the freedesktop desktop folder without depending on xdg-user-dir. */
export function resolveLinuxDesktopDir(
  homeDir: string,
  env: Record<string, string | undefined>,
): string | null {
  const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  const userDirsFile = join(configHome, "user-dirs.dirs");
  if (existsSync(userDirsFile)) {
    const line = readFileSync(userDirsFile, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("XDG_DESKTOP_DIR="));
    const raw = line?.slice("XDG_DESKTOP_DIR=".length).trim();
    if (raw?.startsWith('"') && raw.endsWith('"')) {
      const configured = expandUserDir(raw.slice(1, -1), homeDir);
      if (configured && existsSync(configured)) return configured;
    }
  }

  const fallback = join(homeDir, "Desktop");
  return existsSync(fallback) ? fallback : null;
}

function quoteDesktopEntryValue(value: string): string {
  if (value.includes("\n") || value.includes("\0")) {
    throw new Error("Desktop install path contains an unsupported character");
  }
  return `"${value.replace(/[\\`"$]/g, "\\$&")}"`;
}

export function linuxDesktopEntry(executablePath: string): string {
  const command = quoteDesktopEntryValue(executablePath);
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Lumiverse Desktop",
    "Comment=Lumiverse integrated browser and server controls",
    `Exec=${command}`,
    "Icon=chat.lumiverse.tray",
    "Terminal=false",
    "Categories=Utility;Network;",
    "StartupNotify=true",
    "",
  ].join("\n");
}

function installLinuxAppImage(
  artifact: string,
  homeDir: string,
  env: Record<string, string | undefined>,
): DesktopInstallResult {
  const installDir = join(homeDir, ".local", "opt", "lumiverse-desktop");
  const installedPath = join(installDir, "lumiverse-desktop.AppImage");
  mkdirSync(installDir, { recursive: true });
  copyFileSync(artifact, installedPath);
  chmodSync(installedPath, 0o755);

  const iconSource = join(import.meta.dir, "..", "desktop", "src-tauri", "icons", "128x128.png");
  const iconPath = join(homeDir, ".local", "share", "icons", "hicolor", "128x128", "apps", "chat.lumiverse.tray.png");
  mkdirSync(dirname(iconPath), { recursive: true });
  copyFileSync(iconSource, iconPath);

  const applicationsDir = join(homeDir, ".local", "share", "applications");
  const launcherPath = join(applicationsDir, "chat.lumiverse.tray.desktop");
  mkdirSync(applicationsDir, { recursive: true });
  writeFileSync(launcherPath, linuxDesktopEntry(installedPath), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  const shortcuts = [launcherPath];
  const desktopDir = resolveLinuxDesktopDir(homeDir, env);
  if (desktopDir) {
    const desktopShortcut = join(desktopDir, "Lumiverse Desktop.desktop");
    copyFileSync(launcherPath, desktopShortcut);
    chmodSync(desktopShortcut, 0o755);
    shortcuts.push(desktopShortcut);
  }
  return { installedPath, shortcuts };
}

async function defaultRunCommand(command: string[]): Promise<number> {
  const child = Bun.spawn({
    cmd: command,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/** Stop the installed tray and its owned runner/server tree before replacement. */
export async function stopInstalledDesktopApp(
  target: DesktopInstallPlatform,
  runCommand: (command: string[]) => Promise<number> = defaultRunCommand,
): Promise<void> {
  const exitCode = await runCommand(desktopStopCommand(target));
  if (exitCode !== 0) {
    throw new Error(`Could not stop the running Lumiverse Desktop app (exit ${exitCode})`);
  }
}

async function installWindowsBundle(
  artifact: string,
  runCommand: (command: string[]) => Promise<number>,
): Promise<DesktopInstallResult> {
  const isMsi = artifact.toLowerCase().endsWith(".msi");
  const command = isMsi
    ? ["msiexec.exe", "/i", artifact, "/passive", "/norestart"]
    : [artifact, "/S"];
  const exitCode = await runCommand(command);
  if (exitCode !== 0) throw new Error(`Desktop installer exited with code ${exitCode}`);

  // Tauri's NSIS/MSI installer creates a Start menu link. Copy that link to
  // the user's real Desktop folder (which may be redirected to OneDrive) so
  // the scripted path provides both launcher shortcuts without guessing the
  // installed executable's version-dependent location.
  const shortcutScript = [
    "$ErrorActionPreference = 'Stop'",
    "$roots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }",
    "$link = Get-ChildItem -LiteralPath $roots -Filter 'Lumiverse Desktop.lnk' -File -Recurse | Select-Object -First 1",
    "if (-not $link) { throw 'Lumiverse Desktop Start menu shortcut was not created by the installer' }",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "Copy-Item -LiteralPath $link.FullName -Destination (Join-Path $desktop 'Lumiverse Desktop.lnk') -Force",
  ].join("; ");
  const shortcutExitCode = await runCommand([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    shortcutScript,
  ]);
  if (shortcutExitCode !== 0) {
    throw new Error(`Desktop app installed, but its desktop shortcut could not be created (exit ${shortcutExitCode})`);
  }
  return {
    installedPath: artifact,
    shortcuts: [
      "Windows Start menu: Lumiverse Desktop",
      "Windows Desktop: Lumiverse Desktop.lnk",
    ],
  };
}

export async function installDesktopBundle(
  artifact: string,
  target: DesktopInstallPlatform,
  options: DesktopInstallOptions = {},
): Promise<DesktopInstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunCommand;
  await stopInstalledDesktopApp(target, runCommand);
  switch (target) {
    case "darwin":
      return installMacApp(
        artifact,
        homeDir,
        options.macApplicationsDir ?? "/Applications",
        runCommand,
      );
    case "linux":
      return installLinuxAppImage(artifact, homeDir, env);
    case "win32":
      return installWindowsBundle(artifact, runCommand);
  }
}

export function currentInstallPlatform(): DesktopInstallPlatform {
  const target = platform();
  if (target === "darwin" || target === "win32" || target === "linux") return target;
  throw new Error(`Lumiverse Desktop installation is not supported on ${target}`);
}

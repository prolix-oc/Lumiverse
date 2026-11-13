/**
 * Prerequisite inspection for building Lumiverse Desktop.
 *
 * The desktop app ships no binaries — every install is compiled locally — so
 * the build toolchain is the first thing standing between a new user and a
 * working tray. Discovering a missing prerequisite as a linker error part-way
 * through a Rust build is a poor introduction, and the requirements differ per
 * platform.
 *
 * Shared by `bun run desktop:doctor` and the first-run setup wizard.
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { resolveWindowsMsvc } from "./windows-msvc";

/** Minimum Bun the desktop build requires (see desktop/README.md). */
export const MIN_BUN_VERSION = "1.4.4";

export type CheckStatus = "ok" | "missing" | "unverified";

export interface ToolchainCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** What was found, or why the check could not conclude. */
  detail: string;
  /** How to satisfy the requirement, one line per step. */
  remedy: string[];
}

export type DesktopPlatform = "macos" | "windows" | "linux" | "other";

export interface DesktopToolchainReport {
  platform: DesktopPlatform;
  /** No required check is missing. Unverified checks do not block. */
  ready: boolean;
  checks: ToolchainCheck[];
}

export function currentDesktopPlatform(): DesktopPlatform {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

/** Platform-native Rust installation instructions printed by the doctor. */
export function rustInstallRemedy(target: DesktopPlatform = currentDesktopPlatform()): string[] {
  if (target === "windows") {
    return [
      "Run these PowerShell commands to install Rust:",
      "  $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }",
      "  $arch = if ($cpu -eq 'ARM64') { 'aarch64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x86_64' } else { 'i686' }",
      "  $rustup = Join-Path $env:TEMP 'rustup-init.exe'",
      "  Invoke-WebRequest \"https://win.rustup.rs/$arch\" -UseBasicParsing -OutFile $rustup",
      "  & $rustup",
      "After rustup finishes, rerun .\\start.ps1 -InstallDesktop.",
    ];
  }

  return [
    "Install the Rust toolchain:",
    "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  ];
}

interface ProbeResult {
  ok: boolean;
  out: string;
}

async function probe(command: string[]): Promise<ProbeResult> {
  try {
    // stderr is deliberately dropped rather than piped: a pipe nobody reads
    // fills its buffer and stalls the child. Only the exit code and stdout
    // carry signal here.
    const proc = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "ignore" });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, out: out.trim() };
  } catch {
    // A missing executable throws rather than exiting non-zero.
    return { ok: false, out: "" };
  }
}

/** Compare dotted numeric versions. Returns true when `value` >= `minimum`. */
export function meetsVersion(value: string, minimum: string): boolean {
  const parse = (text: string) =>
    text
      .split(".")
      .map((part) => parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
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

function checkBun(): ToolchainCheck {
  // This script is running under Bun, so the version is already known and
  // needs no subprocess.
  const version = Bun.version;
  const ok = meetsVersion(version, MIN_BUN_VERSION);
  return {
    id: "bun",
    label: "Bun",
    status: ok ? "ok" : "missing",
    detail: ok ? `v${version}` : `v${version}, below the required v${MIN_BUN_VERSION}`,
    remedy: ok ? [] : ["Upgrade Bun:", "  bun upgrade"],
  };
}

/**
 * Locate cargo. A desktop-session shell and a GUI-launched process see very
 * different PATHs, so fall back to the standard rustup location the same way
 * the tray's own bun lookup does.
 */
async function checkCargo(target: DesktopPlatform): Promise<ToolchainCheck> {
  const remedy = rustInstallRemedy(target);

  const onPath = await probe(["cargo", "--version"]);
  if (onPath.ok) {
    return { id: "cargo", label: "Rust (cargo)", status: "ok", detail: onPath.out, remedy: [] };
  }

  const fallback = join(homedir(), ".cargo", "bin", target === "windows" ? "cargo.exe" : "cargo");
  if (existsSync(fallback)) {
    const direct = await probe([fallback, "--version"]);
    if (direct.ok) {
      return {
        id: "cargo",
        label: "Rust (cargo)",
        status: "ok",
        detail: `${direct.out} (at ${fallback}, not on PATH)`,
        remedy: [
          "cargo works but is not on your PATH. Add it so the build can find it:",
          '  export PATH="$HOME/.cargo/bin:$PATH"',
        ],
      };
    }
  }

  return { id: "cargo", label: "Rust (cargo)", status: "missing", detail: "not found", remedy };
}

async function checkMacosPrerequisites(): Promise<ToolchainCheck[]> {
  const tools = await probe(["xcode-select", "-p"]);
  return [
    {
      id: "xcode-clt",
      label: "Xcode Command Line Tools",
      status: tools.ok ? "ok" : "missing",
      detail: tools.ok ? tools.out : "not installed",
      remedy: tools.ok ? [] : ["Install them:", "  xcode-select --install"],
    },
  ];
}

async function checkLinuxPrerequisites(): Promise<ToolchainCheck[]> {
  const nativeRemedy = [
    "Install the GTK/WebKitGTK and AppIndicator development packages.",
    "The exact package names for Debian, Fedora and Arch are listed in",
    "desktop/README.md under Prerequisites.",
  ];
  const checks: ToolchainCheck[] = [];

  const pkgConfig = await probe(["pkg-config", "--version"]);
  if (!pkgConfig.ok) {
    // Without pkg-config there is no reliable way to ask about the libraries,
    // and guessing package state from the filesystem is worse than admitting
    // the check could not run.
    checks.push({
      id: "webkitgtk",
      label: "WebKitGTK / AppIndicator",
      status: "unverified",
      detail: "pkg-config is not installed, so the libraries could not be checked",
      remedy: nativeRemedy,
    });
  } else {
    for (const [id, label, packages] of [
      ["webkitgtk", "WebKitGTK 4.1", ["webkit2gtk-4.1"]],
      // Either implementation satisfies the build. desktop/README.md installs
      // the Ayatana package on Debian and libappindicator-gtk3 on Fedora and
      // Arch, and the two register different pkg-config names.
      ["appindicator", "AppIndicator", ["ayatana-appindicator3-0.1", "appindicator3-0.1"]],
    ] as const) {
      let found: string | null = null;
      for (const pkg of packages) {
        if ((await probe(["pkg-config", "--exists", pkg])).ok) {
          found = pkg;
          break;
        }
      }
      checks.push({
        id,
        label,
        status: found ? "ok" : "missing",
        detail: found ? `${found} found` : `${packages.join(" / ")} not found`,
        remedy: found ? [] : nativeRemedy,
      });
    }
  }

  const requiredAudioElements = ["appsrc", "autoaudiosink", "mpg123audiodec", "pulsesink"];
  const missingAudioElements: string[] = [];
  for (const element of requiredAudioElements) {
    if (!(await probe(["gst-inspect-1.0", element])).ok) missingAudioElements.push(element);
  }
  checks.push({
    id: "gstreamer-audio",
    label: "GStreamer audio plugins",
    status: missingAudioElements.length === 0 ? "ok" : "missing",
    detail: missingAudioElements.length === 0
      ? "AppImage audio factories found"
      : `missing ${missingAudioElements.join(", ")}`,
    remedy: missingAudioElements.length === 0
      ? []
      : [
          "Install GStreamer tools plus the base and good plugin sets.",
          "The platform-specific commands are listed in desktop/README.md",
          "under Prerequisites.",
        ],
  });
  return checks;
}

async function checkWindowsPrerequisites(): Promise<ToolchainCheck[]> {
  const msvc = await resolveWindowsMsvc();
  return [
    {
      id: "msvc",
      label: "MSVC build tools",
      status: msvc.ready ? "ok" : "missing",
      detail: msvc.detail,
      remedy: msvc.ready ? [] : [
        "In Visual Studio Installer, modify Build Tools and select Desktop development with C++",
        "with MSVC C++ build tools and a Windows SDK, then retry.",
        "Or use the x64 Native Tools Command Prompt and verify: where link.exe",
      ],
    },
    {
      id: "webview2",
      label: "WebView2 runtime",
      status: "unverified",
      detail: "preinstalled on Windows 11; not detected by this check",
      remedy: [
        "On Windows 10, install the WebView2 Evergreen runtime from Microsoft",
        "if the app fails to open its window.",
      ],
    },
  ];
}

export async function inspectDesktopToolchain(): Promise<DesktopToolchainReport> {
  const target = currentDesktopPlatform();
  const checks: ToolchainCheck[] = [checkBun(), await checkCargo(target)];

  switch (target) {
    case "macos":
      checks.push(...(await checkMacosPrerequisites()));
      break;
    case "linux":
      checks.push(...(await checkLinuxPrerequisites()));
      break;
    case "windows":
      checks.push(...(await checkWindowsPrerequisites()));
      break;
    default:
      break;
  }

  return {
    platform: target,
    ready: checks.every((check) => check.status !== "missing"),
    checks,
  };
}

/** The command that builds the desktop app on the current platform. */
export function desktopBuildCommand(target: DesktopPlatform = currentDesktopPlatform()): string {
  return target === "windows"
    ? ".\\start.ps1 -InstallDesktop"
    : "cd desktop && bun install && bun run tauri:finalized build";
}

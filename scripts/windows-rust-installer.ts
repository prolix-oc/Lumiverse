/** Automatic rustup bootstrap used by the explicit Windows desktop install. */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { retryWindowsRename } from "./windows-fs-retry";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WindowsRustInstallOptions {
  arch?: string;
  env?: Record<string, string | undefined>;
  fetcher?: Fetcher;
  homeDir?: string;
  tempDir?: string;
  runCommand?: (command: string[]) => Promise<number>;
}

export interface WindowsRustInstallResult {
  cargoBin: string;
  rustupUrl: string;
}

/** Map Bun/Node architecture names to the official win.rustup.rs endpoints. */
export function rustupWindowsArchitecture(arch: string): string {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "ia32":
      return "i686";
    default:
      throw new Error(`Automatic Rust installation does not support Windows architecture '${arch}'`);
  }
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

function prependPath(env: Record<string, string | undefined>, directory: string): void {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  if (!entries.some((entry) => entry.toLowerCase() === directory.toLowerCase())) {
    env[pathKey] = [directory, current].filter(Boolean).join(delimiter);
  }
}

/** Download and run the official rustup bootstrapper non-interactively. */
export async function installRustForWindows(
  options: WindowsRustInstallOptions = {},
): Promise<WindowsRustInstallResult> {
  const arch = rustupWindowsArchitecture(options.arch ?? process.arch);
  const rustupUrl = `https://win.rustup.rs/${arch}`;
  const fetcher = options.fetcher ?? fetch;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const tempDir = options.tempDir ?? tmpdir();
  mkdirSync(tempDir, { recursive: true });
  const workingDir = mkdtempSync(join(tempDir, "lumiverse-rustup-"));
  const installerPath = join(workingDir, "rustup-init.exe");

  try {
    const response = await fetcher(rustupUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) {
      throw new Error(`Rustup download failed with HTTP ${response.status}`);
    }
    // Bun 1.4.1+ streams Response bodies in Bun.write instead of buffering the
    // whole rustup executable in the JavaScript heap.
    const bytesWritten = await Bun.write(installerPath, response);
    const signature = await Bun.file(installerPath).slice(0, 2).bytes();
    // Avoid executing an HTML error page or proxy response as a program.
    if (bytesWritten < 2 || signature[0] !== 0x4d || signature[1] !== 0x5a) {
      throw new Error("Rustup download was not a valid Windows executable");
    }

    const exitCode = await runCommand([
      installerPath,
      "-y",
      "--profile",
      "minimal",
      "--default-toolchain",
      "stable",
    ]);
    if (exitCode !== 0) throw new Error(`rustup-init exited with code ${exitCode}`);

    const cargoBin = join(homeDir, ".cargo", "bin");
    prependPath(env, cargoBin);
    return { cargoBin, rustupUrl };
  } finally {
    // The installed toolchain lives under the user's profile; only the
    // downloaded bootstrapper and its private temporary directory are removed.
    // Antivirus can briefly retain the executable after it exits, so cleanup
    // is best-effort and must not turn a successful Rust install into failure.
    try {
      await retryWindowsRename(() => rmSync(workingDir, { recursive: true, force: true }));
    } catch {}
  }
}

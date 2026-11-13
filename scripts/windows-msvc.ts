import { existsSync } from "node:fs";
import { win32 } from "node:path";

type Environment = Record<string, string | undefined>;

interface ProbeResult {
  ok: boolean;
  out: string;
}

type CommandProbe = (command: string[], env: Environment, windowsVerbatimArguments?: boolean) => Promise<ProbeResult>;

export interface WindowsMsvcOptions {
  arch?: string;
  env?: Environment;
  exists?: (path: string) => boolean;
  probe?: CommandProbe;
}

export interface WindowsMsvcResult {
  ready: boolean;
  detail: string;
  vcvarsall?: string;
  architecture?: string;
}

async function probe(command: string[], env: Environment, windowsVerbatimArguments = false): Promise<ProbeResult> {
  try {
    const child = Bun.spawn({ cmd: command, env, stdout: "pipe", stderr: "ignore", timeout: 30_000, windowsVerbatimArguments });
    const [out, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { ok: exitCode === 0, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

export function windowsMsvcCommand(command: string[], vcvarsall: string, architecture: string, env: Environment): string[] {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [
    env.ComSpec || "cmd.exe",
    "/d",
    "/s",
    "/c",
    `"call ${quote(vcvarsall)} ${architecture} >nul && ${command.map(quote).join(" ")}"`,
  ];
}

export async function resolveWindowsMsvc(options: WindowsMsvcOptions = {}): Promise<WindowsMsvcResult> {
  const env = options.env ?? process.env;
  const run = options.probe ?? probe;
  const exists = options.exists ?? existsSync;
  const arch = options.arch ?? process.arch;
  const architecture = arch === "arm64" ? "amd64_arm64" : arch === "ia32" ? "x86" : "amd64";
  const target = arch === "arm64" ? "arm64" : arch === "ia32" ? "x86" : "x64";
  const hasTargetLinker = (out: string) => out.split(/\r?\n/).some((path) =>
    path.toLowerCase().includes("\\vc\\tools\\msvc\\")
    && path.toLowerCase().endsWith(`\\${target}\\link.exe`));

  const currentLinker = await run(["where.exe", "link.exe"], env);
  if (currentLinker.ok && hasTargetLinker(currentLinker.out) && env.LIB && env.INCLUDE
    && (!env.VSCMD_ARG_TGT_ARCH || env.VSCMD_ARG_TGT_ARCH.toLowerCase() === target)) {
    return { ready: true, detail: "MSVC linker and library environment are available" };
  }

  const programFiles = env["ProgramFiles(x86)"] || env.ProgramFiles || "C:\\Program Files (x86)";
  const vswhere = win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const remedy = "Install the Desktop development with C++ workload (MSVC compiler and Windows SDK) in Visual Studio Installer.";
  if (!exists(vswhere)) {
    return { ready: false, detail: `link.exe is not configured and ${vswhere} was not found. ${remedy}` };
  }

  const instances = await run([vswhere, "-products", "*", "-property", "installationPath"], env);
  const installationPaths = instances.ok ? instances.out.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) : [];
  if (installationPaths.length === 0) {
    return { ready: false, detail: `No usable Visual Studio installation was found by ${vswhere}. ${remedy}` };
  }

  let foundSetup = false;
  for (const installationPath of installationPaths) {
    const vcvarsall = win32.join(installationPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
    if (!exists(vcvarsall)) continue;
    foundSetup = true;

    const activatedLinker = await run(
      windowsMsvcCommand(["where.exe", "link.exe"], vcvarsall, architecture, env),
      env,
      true,
    );
    if (!activatedLinker.ok || !hasTargetLinker(activatedLinker.out)) continue;

    return {
      ready: true,
      detail: `MSVC linker found at ${installationPath}; build will load its developer environment`,
      vcvarsall,
      architecture,
    };
  }

  return {
    ready: false,
    detail: foundSetup
      ? `Visual Studio C++ toolchain could not provide link.exe for ${architecture}. ${remedy}`
      : `Visual Studio is installed, but C++ toolchain setup is missing. ${remedy}`,
  };
}

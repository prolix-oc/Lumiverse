#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"];
const USAGE = "Usage: bun run build:linux-appimage <SSH-profile-or-user@host> [--arch x64|arm64] [--cross] [--remote-output directory] [--no-download] [--jobs 12] [--smoke]\n       bun run build:linux-appimage --local [--arch x64|arm64] [--cross] [--output directory] [--jobs 12] [--smoke]\n       --cross uses native x64 compilation for --arch arm64 on an x64 Linux build host.";

export function parseOptions(args: string[]) {
  const host = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;
  if (host && !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) throw new Error(USAGE);
  let jobs = 12;
  let arch: "x64" | "arm64" = "x64";
  let output = join(ROOT, ".cache/linux-appimage");
  let local = false, smoke = false, download = true, cross = false;
  let remoteOutput: string | undefined;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--local") { local = true; continue; }
    if (flag === "--smoke") { smoke = true; continue; }
    if (flag === "--cross") { cross = true; continue; }
    if (flag === "--no-download") { download = false; continue; }
    const value = args.shift();
    if (flag === "--arch" && (value === "x64" || value === "arm64")) arch = value;
    else if (flag === "--jobs" && value && /^[1-9][0-9]*$/.test(value) && Number(value) <= 64) jobs = Number(value);
    else if (flag === "--output" && value) output = resolve(value);
    else if (flag === "--remote-output" && value?.startsWith("/") && !/[\r\n]/.test(value)) remoteOutput = value;
    else throw new Error(USAGE);
  }
  if ((local && (host || remoteOutput || !download)) || (!local && !host)) throw new Error(USAGE);
  if (cross && arch !== "arm64") throw new Error("--cross requires --arch arm64");
  return { host, jobs, arch, output, local, smoke, download, remoteOutput, cross };
}

export function includeSnapshotPath(path: string): boolean {
  const parts = path.split("/");
  return !!path && !path.startsWith("/") && !parts.includes("..")
    && !parts.some(part => [".git", "node_modules", "target", ".cache", ".signing"].includes(part))
    && !["data", ".tmp", "dist"].includes(parts[0]!)
    && !parts.some(part => part.startsWith(".env") && part !== ".env.example")
    && !path.startsWith("desktop/src-tauri/binaries/lumiverse-server")
    && path !== "desktop/src-tauri/tauri.release-updater.conf.json";
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function diagnosticVersion(baseVersion: string, buildId: string): string {
  if (!/^\d{8}T\d{6}Z-(?:(?:x64|arm64)-)?[a-f0-9]{10}$/.test(buildId)) {
    throw new Error("Invalid diagnostic build ID");
  }
  const parts = buildId.split("-");
  const source = parts.pop();
  // Keep our version-stamping CLI's dot-only suffix, and prevent an all-digit
  // source hash from becoming a SemVer numeric identifier with leading zeroes.
  return `${baseVersion.split("-")[0]}-diagnostic.${parts.join(".")}.s${source}`;
}

async function run(cmd: string[], input?: string | Uint8Array, capture = false): Promise<string> {
  const child = Bun.spawn(cmd, {
    cwd: ROOT, env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: input === undefined ? "ignore" : "pipe", stdout: capture ? "pipe" : "inherit", stderr: "inherit",
  });
  if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
  const output = capture ? new Response(child.stdout).text() : Promise.resolve("");
  const [status, text] = await Promise.all([child.exited, output]);
  if (status !== 0) throw new Error(`${cmd[0]} exited with status ${status}`);
  return text;
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return; }
  const { host, jobs, arch, output, local, smoke, download, remoteOutput, cross } = parseOptions(args);
  if (local && process.platform !== "linux") throw new Error("--local requires Linux with Docker access.");
  const execute = (script: string, arguments_: string[] = [], capture = false) => host
    ? run(["ssh", ...SSH_OPTIONS, host, `bash -s -- ${arguments_.map(shellQuote).join(" ")}`], script, capture)
    : run(["bash", "-s", "--", ...arguments_], script, capture);
  const temporary = mkdtempSync(join(tmpdir(), "lumiverse-linux-build-"));
  try {
    // Copy current file bytes, including uncommitted source changes. Never copy
    // Git credentials, local dependencies, instance data, or signing material.
    const listed = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, true);
    const paths = [...new Set(listed.split("\0").filter(path => includeSnapshotPath(path) && existsSync(join(ROOT, path))))].sort();
    const fileList = join(temporary, "files");
    const archive = join(temporary, "source.tar.gz");
    writeFileSync(fileList, paths.join("\0") + "\0");
    await run(["tar", "--no-xattrs", "--null", "-czf", archive, "-T", fileList]);
    const sourceArchiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const baseRevision = (await run(["git", "rev-parse", "HEAD"], undefined, true)).trim();
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const id = `${timestamp}-${arch}-${sourceArchiveSha256.slice(0, 10)}`;
    const cache = local ? join(homedir(), ".cache/lumiverse-appimage-build")
      : (await execute('printf "%s/.cache/lumiverse-appimage-build" "$HOME"\n', [], true)).trim();
    if (!cache.startsWith("/") || /[\r\n,]/.test(cache)) throw new Error("Unsupported remote build home directory.");
    const remoteRun = `${cache}/runs/${id}`;
    const metadata = JSON.stringify({ format: 1, id, baseRevision, sourceArchiveSha256, arch, jobs, compiler: cross ? "native-x64-cross" : "target-container", createdAt: new Date().toISOString(), kind: "unsigned-diagnostic" }, null, 2) + "\n";
    console.log(`[remote-build] ${host || "local"}: ${remoteRun}`);
    await execute('set -eu\ncommand -v docker >/dev/null\ndocker info >/dev/null\nif test -n "$2"; then test -d "$2" && test -w "$2"; fi\nmkdir -p "$1/source"\n', [remoteRun, remoteOutput || ""]);
    if (host) await run(["scp", ...SSH_OPTIONS, archive, `${host}:${remoteRun}/source.tar.gz`]);
    else copyFileSync(archive, join(remoteRun, "source.tar.gz"));
    // Send metadata as data rather than interpolating it into a shell program.
    if (host) await run(["ssh", ...SSH_OPTIONS, host, `cat > ${shellQuote(`${remoteRun}/build-source.json`)}`], metadata);
    else writeFileSync(join(remoteRun, "build-source.json"), metadata);
    await execute('set -eu\ntar -xzf "$1/source.tar.gz" -C "$1/source"\nexec bash "$1/source/scripts/linux-appimage-builder/run-remote.sh" "$1" "$2" "$3" "$4" "$5" "$6"\n', [remoteRun, cache, String(jobs), smoke ? "1" : "0", arch, cross ? "1" : "0"]);
    if (remoteOutput) {
      await execute('set -eu\ncd "$1/artifacts"\nsha256sum -c SHA256SUMS\nmkdir -p "$2/lumiverse-diagnostics"\ndestination="$2/lumiverse-diagnostics/$3"\nmkdir "$destination"\ncp -a . "$destination/"\nchmod -R a+rX "$destination"\ncd "$destination"\nsha256sum -c SHA256SUMS\nprintf "[remote-build] Shared output: %s\\n" "$destination"\n', [remoteRun, remoteOutput, id]);
    }
    if (!download) { console.log(`[remote-build] Artifacts retained on ${host}: ${remoteRun}/artifacts`); return; }
    mkdirSync(output, { recursive: true });
    const localRun = join(output, id);
    if (host) await run(["scp", ...SSH_OPTIONS, "-r", `${host}:${remoteRun}/artifacts`, localRun]);
    else cpSync(join(remoteRun, "artifacts"), localRun, { recursive: true });
    const checksums = readFileSync(join(localRun, "SHA256SUMS"), "utf8").trim().split("\n");
    if (JSON.parse(readFileSync(join(localRun, "runtime-manifest.json"), "utf8")).architecture !== arch) {
      throw new Error(`Downloaded AppImage runtime does not match requested ${arch} architecture`);
    }
    for (const line of checksums) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match || match[2]!.includes("/") || match[2]!.includes("\\")) throw new Error("Invalid downloaded artifact checksum list");
      const actual = createHash("sha256").update(readFileSync(join(localRun, match[2]!))).digest("hex");
      if (actual !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
    }
    console.log(`[remote-build] Downloaded and verified: ${localRun}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

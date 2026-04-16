/**
 * SMB filesystem provider — shells out to the system `smbclient` binary.
 *
 * This avoids all native addon and JS protocol implementation issues by
 * delegating to Samba's battle-tested SMB1/2/3 client. The binary is
 * available on every major platform:
 *   - Debian/Ubuntu: apt install smbclient
 *   - RHEL/Fedora:   dnf install samba-client
 *   - Arch:          pacman -S smbclient
 *   - Alpine:        apk add samba-client
 *   - macOS:         brew install samba
 *   - Termux:        pkg install samba
 *
 * Windows users don't need this — SMB shares are native filesystem paths.
 */

import { posix } from "path";
import type { FileSystem, FileEntry, FileStat, SMBConnectionConfig } from "../types";

/** Internal parsed ls entry — includes modifiedAt for stat() use. */
interface SmbLsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modifiedAt?: number;
}

/** Check whether `smbclient` is available on this system. */
export async function isSmbClientAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["smbclient", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export class SMBFileSystem implements FileSystem {
  readonly type = "smb" as const;
  private config: SMBConnectionConfig;

  constructor(config: SMBConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Verify smbclient exists
    if (!(await isSmbClientAvailable())) {
      throw new Error(
        "smbclient is not installed. Install the samba-client package for your OS.",
      );
    }
    // Test connectivity by listing the share root
    await this.runCommand("ls");
  }

  async disconnect(): Promise<void> {
    // no-op — each command is a separate process
  }

  // ─── FileSystem interface ──────────────────────────────────────────────

  async exists(path: string): Promise<boolean> {
    try {
      // Use `ls` on the specific path — smbclient exits non-zero if not found
      const smbPath = this.toSmbPath(path);
      // For directories, ls the path directly. For files, ls the parent with a filter.
      await this.runCommand(`ls "${smbPath}"`);
      return true;
    } catch {
      // Try as a file by listing parent with the filename as pattern
      try {
        const dir = posix.dirname(path);
        const base = posix.basename(path);
        const smbDir = this.toSmbPath(dir);
        const output = await this.runCommand(`cd "${smbDir}"; ls "${base}"`);
        return output.trim().length > 0 && !output.includes("NT_STATUS_");
      } catch {
        return false;
      }
    }
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = this.toSmbPath(path);

    // Try listing the path as a directory
    try {
      const output = await this.runCommand(`ls "${normalized}\\*"`);
      // If we can list contents, it's a directory
      const entries = this.parseLsOutput(output);
      // Find the "." entry for size/date
      const self = entries.find((e) => e.name === ".");
      return {
        isDirectory: true,
        isFile: false,
        size: self?.size ?? 0,
        modifiedAt: self?.modifiedAt,
      };
    } catch {
      // Not a directory — try as file
    }

    // Try as a file: ls the parent and find the entry
    const dir = posix.dirname(path);
    const base = posix.basename(path);
    const parentPath = this.toSmbPath(dir);
    const output = await this.runCommand(
      parentPath
        ? `ls "${parentPath}\\${base}"`
        : `ls "${base}"`,
    );
    const entries = this.parseLsOutput(output);
    const entry = entries.find(
      (e) => e.name.toLowerCase() === base.toLowerCase(),
    );

    if (!entry) {
      throw new Error(`Not found: ${path}`);
    }

    return {
      isDirectory: entry.isDirectory,
      isFile: !entry.isDirectory,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
    };
  }

  async readdir(path: string): Promise<FileEntry[]> {
    const smbPath = this.toSmbPath(path);
    const pattern = smbPath ? `${smbPath}\\*` : "*";
    const output = await this.runCommand(`ls "${pattern}"`);
    return this.parseLsOutput(output)
      .filter((e) => e.name !== "." && e.name !== "..")
      .map(({ name, isDirectory, isFile, size }) => ({ name, isDirectory, isFile, size }));
  }

  async readFile(path: string): Promise<Buffer> {
    const smbPath = this.toSmbPath(path);
    // Download to a temp file, read it, delete it
    const tmpPath = `/tmp/lumiverse-smb-${crypto.randomUUID()}`;
    try {
      await this.runCommand(`get "${smbPath}" "${tmpPath}"`);
      const data = await Bun.file(tmpPath).arrayBuffer();
      return Buffer.from(data);
    } finally {
      try {
        const { unlinkSync } = require("fs");
        unlinkSync(tmpPath);
      } catch { /* ignore */ }
    }
  }

  async readText(path: string): Promise<string> {
    const buf = await this.readFile(path);
    return buf.toString("utf-8");
  }

  // ─── Path helpers ──────────────────────────────────────────────────────

  /**
   * Convert forward-slash paths to backslash and reject any character that
   * would let an attacker break out of the quoted `-c` argument. smbclient
   * honors `!cmd` to spawn a local shell, so a path containing `"; !id; ls "`
   * was previously enough to get arbitrary code execution on the host.
   */
  private toSmbPath(path: string): string {
    if (typeof path !== "string") {
      throw new Error("SMB path must be a string");
    }
    // Disallow shell-meta and quote characters outright. SMB filenames can
    // technically contain quotes/semicolons, but supporting that safely would
    // require building commands without `-c` shell concatenation; rejecting
    // these characters keeps the simple spawn path safe.
    if (/["'`;!\n\r\u0000$<>|&]/.test(path)) {
      throw new Error("SMB path contains disallowed characters");
    }
    return path.replace(/^\/+/, "").replace(/\//g, "\\");
  }

  join(...parts: string[]): string {
    return posix.join(...parts);
  }

  dirname(path: string): string {
    return posix.dirname(path);
  }

  basename(path: string, ext?: string): string {
    return ext ? posix.basename(path, ext) : posix.basename(path);
  }

  extname(path: string): string {
    return posix.extname(path);
  }

  // ─── smbclient execution ──────────────────────────────────────────────

  private async runCommand(command: string): Promise<string> {
    const { args, password } = this.buildArgs(command);
    // Pass the password via env (PASSWD) instead of `-U user%pass` so it does
    // not appear in /proc/<pid>/cmdline or `ps` output. smbclient honors
    // PASSWD for non-interactive auth; this is the standard way to script it.
    const envForChild: Record<string, string> = {};
    if (process.env.PATH) envForChild.PATH = process.env.PATH;
    if (password) envForChild.PASSWD = password;
    const proc = Bun.spawn(["smbclient", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: envForChild,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    // smbclient prints warnings and deprecation notices to stderr even on
    // success. Only treat stderr as an error when the exit code is non-zero
    // AND stderr contains an actual error (not just warnings/deprecation).
    if (proc.exitCode !== 0) {
      // Filter out known non-fatal warnings from stderr
      const stderrLines = stderr
        .split("\n")
        .filter((l) => l.trim())
        .filter((l) => !l.includes("WARNING:") && !l.includes("deprecated"));
      const errMsg = stderrLines.join("\n").trim() || stdout.trim();
      if (errMsg) {
        throw new Error(`smbclient error: ${errMsg}`);
      }
    }

    // Check for NT_STATUS errors in stdout (smbclient sometimes exits 0 but
    // includes errors inline)
    const statusMatch = stdout.match(/NT_STATUS_\S+/);
    if (statusMatch && !stdout.includes("NT_STATUS_NO_MORE_FILES")) {
      throw new Error(`SMB error: ${statusMatch[0]}`);
    }

    return stdout;
  }

  private buildArgs(command: string): { args: string[]; password: string | undefined } {
    const { host, share, port, username, password, domain } = this.config;
    const service = `//${host}/${share}`;

    const args: string[] = [service, "-c", command];

    if (port && port !== 445) {
      args.push("-p", String(port));
    }

    if (username) {
      // Username goes on the command line; password is delivered via the
      // PASSWD env var by runCommand() so it never appears in argv.
      args.push("-U", username);
    } else {
      // Anonymous / guest
      args.push("-N");
    }

    if (domain) {
      args.push("-W", domain);
    }

    return { args, password: username ? password : undefined };
  }

  // ─── Output parsing ───────────────────────────────────────────────────

  /**
   * Parse smbclient `ls` output. Format:
   *   .                        D        0  Mon Mar 31 10:00:00 2025
   *   ..                       D        0  Mon Mar 31 10:00:00 2025
   *   filename.txt             A   123456  Mon Mar 31 10:00:00 2025
   *   subdirectory             D        0  Mon Mar 31 10:00:00 2025
   *
   * The attributes column can contain: D(irectory), A(rchive), H(idden),
   * S(ystem), R(ead-only), N(ormal). The line ends with a date string.
   */
  private parseLsOutput(output: string): SmbLsEntry[] {
    const entries: SmbLsEntry[] = [];

    // Match lines with the smbclient ls format:
    // name (padded)  attributes  size  date
    const lineRegex = /^\s{2}(.+?)\s+([DAHSRN]+)\s+(\d+)\s+(.+)$/;

    for (const line of output.split("\n")) {
      const match = line.match(lineRegex);
      if (!match) continue;

      const [, name, attrs, sizeStr, dateStr] = match;
      const trimmedName = name.trimEnd();
      const isDir = attrs.includes("D");
      const size = parseInt(sizeStr, 10) || 0;

      let modifiedAt: number | undefined;
      try {
        const d = new Date(dateStr.trim());
        if (!isNaN(d.getTime())) {
          modifiedAt = Math.floor(d.getTime() / 1000);
        }
      } catch { /* ignore */ }

      entries.push({
        name: trimmedName,
        isDirectory: isDir,
        isFile: !isDir,
        size,
      });
    }

    return entries;
  }
}

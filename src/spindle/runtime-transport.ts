import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

import { env } from "../env";
import { bunCmd } from "./manager.service";

export type RuntimeTransportMode = "worker" | "process" | "sandbox";

export interface RuntimeTransport {
  readonly mode: RuntimeTransportMode;
  readonly pid: number | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface CreateRuntimeTransportOptions {
  runtimePath: string;
  extensionIdentifier: string;
  repoPath: string;
  storagePath: string;
  onMessage: (message: unknown) => void;
  onError: (message: string) => void;
  onExit: (exitCode: number | null, signalCode: number | null, error?: Error | undefined) => void;
}

function escapeSandboxRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/");
}

function buildSandboxProfile(opts: {
  workspaceRoot: string;
  repoPath: string;
  storagePath: string;
  dataDir: string;
  homeDir: string;
}): string {
  const workspaceRoot = escapeSandboxRegex(opts.workspaceRoot);
  const repoPath = escapeSandboxRegex(opts.repoPath);
  const storagePath = escapeSandboxRegex(opts.storagePath);
  const dataDir = escapeSandboxRegex(opts.dataDir);
  const homeDir = escapeSandboxRegex(opts.homeDir);

  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec)",
    `
(deny file-write* (require-all
    (regex "^${workspaceRoot}($|\/.*)")
    (require-not (regex "^${storagePath}($|\/.*)"))))`.trim(),
    `
(deny file-write* (require-all
    (regex "^${dataDir}($|\/.*)")
    (require-not (regex "^${storagePath}($|\/.*)"))))`.trim(),
    `
(deny file-read* (require-all
    (regex "^${dataDir}($|\/.*)")
    (require-not (regex "^${repoPath}($|\/.*)"))
    (require-not (regex "^${storagePath}($|\/.*)"))))`.trim(),
    `
(deny file-read* (regex "^${workspaceRoot}\/\.env(?:\..*)?$"))`.trim(),
    `
(deny file-read* (regex "^${homeDir}\/(?:\\.ssh|\\.aws|\\.gnupg|Library\/Keychains)($|\/.*)"))`.trim(),
    `
(deny file-write* (regex "^${homeDir}\/(?:\\.ssh|\\.aws|\\.gnupg|Library\/Keychains)($|\/.*)"))`.trim(),
  ].join("\n");
}

function writeSandboxProfile(identifier: string, repoPath: string, storagePath: string): string {
  const profileDir = join(env.dataDir, "extensions", "_sandbox");
  mkdirSync(profileDir, { recursive: true });

  const workspaceRoot = resolve(import.meta.dir, "..", "..");
  const profilePath = join(profileDir, `${identifier}.sb`);
  const profile = buildSandboxProfile({
    workspaceRoot,
    repoPath,
    storagePath,
    dataDir: env.dataDir,
    homeDir: homedir(),
  });
  writeFileSync(profilePath, profile, "utf8");
  return profilePath;
}

function resolveRuntimeMode(): RuntimeTransportMode {
  const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_MODE?.trim().toLowerCase();
  if (raw === "worker") return "worker";
  if (raw === "sandbox") return "sandbox";
  return "process";
}

function createWorkerTransport(opts: CreateRuntimeTransportOptions): RuntimeTransport {
  const worker = new Worker(opts.runtimePath, { type: "module" });
  worker.onmessage = (event) => {
    opts.onMessage(event.data);
  };
  worker.onerror = (event) => {
    opts.onError(event.message);
  };

  return {
    mode: "worker",
    pid: null,
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

function createSubprocessTransport(
  opts: CreateRuntimeTransportOptions,
  mode: Extract<RuntimeTransportMode, "process" | "sandbox">
): RuntimeTransport {
  const runtimeCmd = bunCmd(opts.runtimePath, "--spindle-subprocess");
  const sandboxExecPath = "/usr/bin/sandbox-exec";
  const sandboxAvailable =
    mode === "sandbox" && process.platform === "darwin" && existsSync(sandboxExecPath);
  const effectiveMode: Extract<RuntimeTransportMode, "process" | "sandbox"> =
    sandboxAvailable ? "sandbox" : "process";
  const cmd = sandboxAvailable
    ? [
        sandboxExecPath,
        "-f",
        writeSandboxProfile(opts.extensionIdentifier, opts.repoPath, opts.storagePath),
        ...runtimeCmd,
      ]
    : runtimeCmd;

  const proc = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    serialization: "advanced",
    ipc(message) {
      opts.onMessage(message);
    },
    onExit(subprocess, exitCode, signalCode, error) {
      void subprocess;
      opts.onExit(exitCode, signalCode, error);
    },
  });

  return {
    mode: effectiveMode,
    pid: proc.pid,
    postMessage(message: unknown): void {
      proc.send(message);
    },
    terminate(): void {
      proc.kill("SIGTERM");
    },
  };
}

export function createRuntimeTransport(opts: CreateRuntimeTransportOptions): RuntimeTransport {
  const mode = resolveRuntimeMode();
  if (mode === "worker") {
    return createWorkerTransport(opts);
  }
  return createSubprocessTransport(opts, mode);
}

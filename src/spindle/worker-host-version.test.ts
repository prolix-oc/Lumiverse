import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import {
  WorkerHost,
  getLumiverseVersionInfo,
  normalizeGitReportValue,
} from "./worker-host";

function gitValue(...args: string[]): string | null {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  const value = proc.stdout.toString().trim();
  return value ? value : null;
}

function expectedGitValue(value: string | null): string | null {
  if (!value || value === "HEAD" || value === "unknown") return null;
  return value;
}

async function waitForResponse(
  posted: any[],
  requestId: string,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = posted.find(
      (message) => message.type === "response" && message.requestId === requestId,
    );
    if (response) return response;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for response ${requestId}`);
}

test("git report values map unavailable placeholders to null", () => {
  expect(normalizeGitReportValue("")).toBeNull();
  expect(normalizeGitReportValue("unknown")).toBeNull();
  expect(normalizeGitReportValue("HEAD")).toBeNull();
  expect(normalizeGitReportValue("bundled")).toBeNull();
  expect(normalizeGitReportValue(" main ")).toBe("main");
  expect(normalizeGitReportValue("26939aa5")).toBe("26939aa5");
});

test("worker host serves the version report on the free tier", async () => {
  const host = new WorkerHost(
    "version-test",
    { identifier: "version-test", permissions: [] } as unknown as SpindleManifest,
    {
      id: "version-test", identifier: "version-test", name: "Test", version: "0.0.0", author: "",
      description: "", github: "", homepage: "", permissions: [], granted_permissions: [],
      enabled: true, installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false,
      status: "stopped", metadata: { install_scope: "user", installed_by_user_id: "owner" },
    } satisfies ExtensionInfo,
  );
  const internal = host as unknown as {
    handleMessage(message: unknown): void;
    postToWorker(message: unknown): void;
  };
  const posted: any[] = [];
  internal.postToWorker = (message) => { posted.push(message); };

  const expectedCommit = expectedGitValue(gitValue("rev-parse", "--short", "HEAD"));
  const expectedBranch = expectedGitValue(gitValue("rev-parse", "--abbrev-ref", "HEAD"));

  internal.handleMessage({ type: "version_get_info", requestId: "info-1" });
  internal.handleMessage({ type: "version_get_commit", requestId: "commit-1" });
  internal.handleMessage({ type: "version_get_branch", requestId: "branch-1" });
  internal.handleMessage({ type: "version_get_backend", requestId: "backend-1" });

  const info = await waitForResponse(posted, "info-1");
  expect(info.error).toBeUndefined();
  expect(info.result.backend).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.result.frontend).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.result.commit).toBe(expectedCommit);
  expect(info.result.branch).toBe(expectedBranch);

  const commit = await waitForResponse(posted, "commit-1");
  expect(commit.result).toBe(expectedCommit);

  const branch = await waitForResponse(posted, "branch-1");
  expect(branch.result).toBe(expectedBranch);

  const backend = await waitForResponse(posted, "backend-1");
  expect(backend.result).toBe(info.result.backend);

  // The combined helper and the individual getters agree.
  expect(await getLumiverseVersionInfo()).toEqual(info.result);
});

test("worker runtime exposes version getters to extensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spindle-version-test-"));
  const entry = join(directory, "backend.mjs");
  await Bun.write(entry, `
    const info = await spindle.version.getInfo();
    const commit = await spindle.version.getCommit();
    const branch = await spindle.version.getBranch();
    const backend = await spindle.version.getBackend();
    const frontend = await spindle.version.getFrontend();
    spindle.sendToFrontend({ info, commit, branch, backend, frontend });
  `);
  const received: any[] = [];
  const listeners = new Set<() => void>();
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "worker-runtime.ts")], {
    stdout: "ignore", stderr: "pipe",
    ipc(message: any, child) {
      received.push(message);
      if (message.type === "permissions_get_granted") {
        child.send({ type: "response", requestId: message.requestId, result: [] });
      } else if (message.type === "version_get_info") {
        child.send({ type: "response", requestId: message.requestId, result: { backend: "1.2.5", frontend: "1.2.4", commit: "26939aa5", branch: "main" } });
      } else if (message.type === "version_get_commit") {
        child.send({ type: "response", requestId: message.requestId, result: "26939aa5" });
      } else if (message.type === "version_get_branch") {
        child.send({ type: "response", requestId: message.requestId, result: "main" });
      } else if (message.type === "version_get_backend") {
        child.send({ type: "response", requestId: message.requestId, result: "1.2.5" });
      } else if (message.type === "version_get_frontend") {
        child.send({ type: "response", requestId: message.requestId, result: "1.2.4" });
      }
      for (const listener of listeners) listener();
    },
  });
  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error("Worker did not deliver the expected version response"));
      }, 5_000);
      const check = () => {
        const message = received.find(predicate);
        if (!message) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(message);
      };
      listeners.add(check);
      check();
    });
  }
  try {
    worker.send({
      type: "init",
      manifest: { identifier: "version-test", entry_backend: pathToFileURL(entry).href, permissions: [] },
      storagePath: directory,
      host: {
        descriptorVersion: 1,
        lumiverseVersion: "1.2.5",
        capabilities: {},
        extensionInstallationId: "version-test",
      },
    });
    const message = await waitFor((candidate) => candidate.type === "frontend_message");
    expect(message.payload).toEqual({
      info: { backend: "1.2.5", frontend: "1.2.4", commit: "26939aa5", branch: "main" },
      commit: "26939aa5",
      branch: "main",
      backend: "1.2.5",
      frontend: "1.2.4",
    });
    expect(received.map((candidate) => candidate.type)).toContain("version_get_info");
  } finally {
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

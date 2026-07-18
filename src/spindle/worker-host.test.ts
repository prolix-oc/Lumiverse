import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import * as managerSvc from "./manager.service";
import { WorkerHost } from "./worker-host";

function makeManifest(identifier: string): SpindleManifest {
  return {
    identifier,
    name: "Worker host startup boundary test",
    version: "1.0.0",
    author: "Lumiverse",
    github: "https://github.com/prolix-oc/lumiverse-worker-host-startup-boundary-test",
    homepage: "https://lumiverse.chat",
    permissions: [],
    entry_backend: "dist/backend.js",
  };
}

function makeExtensionInfo(
  installationId: string,
  manifest: SpindleManifest,
): ExtensionInfo {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: installationId,
    identifier: manifest.identifier,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description ?? "",
    github: manifest.github,
    homepage: manifest.homepage,
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: now,
    updated_at: now,
    has_frontend: false,
    has_backend: true,
    status: "running",
    metadata: {},
  };
}

describe("WorkerHost public startup boundary", () => {
  test("rejects source-load failure and leaves stop idempotent", async () => {
    const installationId = crypto.randomUUID();
    const identifier = `worker_host_startup_boundary_${crypto.randomUUID().replaceAll("-", "")}`;
    const manifest = makeManifest(identifier);
    const repoPath = managerSvc.getRepoPath(identifier);
    const extensionRoot = dirname(repoPath);
    const storagePath = managerSvc.getStoragePath(identifier);
    const host = new WorkerHost(
      installationId,
      manifest,
      makeExtensionInfo(installationId, manifest),
    );

    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, "dist"), { recursive: true });
    await Bun.write(join(repoPath, "spindle.json"), JSON.stringify(manifest));
    await Bun.write(
      join(repoPath, "dist", "backend.js"),
      'throw new Error("source-load-failure");',
    );

    try {
      await expect(host.start()).rejects.toThrow("source-load-failure");
      await expect(host.stop()).resolves.toBeUndefined();
      await expect(host.stop()).resolves.toBeUndefined();
    } finally {
      await host.stop();
      rmSync(extensionRoot, { recursive: true, force: true });
      rmSync(storagePath, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });
});

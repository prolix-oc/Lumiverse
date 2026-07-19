import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { interceptorPipeline } from "./interceptor-pipeline";
import type { RuntimeTransport } from "./runtime-transport";
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
    interceptorTimeoutMs: 1_000,
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

type CapturedRuntimeMessage = {
  type?: string;
  requestId?: string;
  registrationId?: string;
  registrationGeneration?: string;
  workerId?: string;
  hostGeneration?: string;
  messages?: Array<{ role: string; content: string }>;
  context?: Record<string, unknown>;
};

type WorkerHostInternals = {
  runtime: RuntimeTransport | null;
  hostGeneration: string;
  hasPermission: (permission: string) => boolean;
  handleRegisterInterceptor: (registrationId: string, priority?: number, match?: unknown) => void;
  cleanup: () => void;
};

const TEST_REGISTRATION_ID = "registration-worker-host-test";

function makeTestHost(failInterceptRequest = true): {
  internals: WorkerHostInternals;
  messages: CapturedRuntimeMessage[];
} {
  const installationId = crypto.randomUUID();
  const identifier = `worker_host_interceptor_${crypto.randomUUID().replaceAll("-", "")}`;
  const manifest = makeManifest(identifier);
  const host = new WorkerHost(
    installationId,
    manifest,
    makeExtensionInfo(installationId, manifest),
  );
  const internals = host as unknown as WorkerHostInternals;
  const messages: CapturedRuntimeMessage[] = [];
  internals.runtime = {
    mode: "worker",
    pid: null,
    postMessage(message: unknown): void {
      const cloned = structuredClone(message) as CapturedRuntimeMessage;
      messages.push(cloned);
      if (failInterceptRequest && cloned.type === "intercept_request") {
        throw new Error("synchronous transport failure");
      }
    },
    terminate(): void {},
  };
  internals.hasPermission = () => true;
  internals.handleRegisterInterceptor(TEST_REGISTRATION_ID);
  return { internals, messages };
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

describe("WorkerHost interceptor transport boundary", () => {
  test("sends a cloneable signal-free context with hostGeneration and settles sync transport failure", async () => {
    const { internals, messages } = makeTestHost();
    const outerController = new AbortController();
    const dispatch = interceptorPipeline.run(
      [{ role: "user", content: "hello" }],
      {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-1",
        generationType: "normal",
      },
      undefined,
      outerController.signal,
    );

    try {
      const result = await dispatch;
      expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
      const request = messages.find((message) => message.type === "intercept_request");
      expect(request).toBeDefined();
      expect(request?.registrationId).toBe(TEST_REGISTRATION_ID);
      expect(request?.hostGeneration).toBe(internals.hostGeneration);
      const context = request?.context;
      expect(context).toBeDefined();
      expect("signal" in (context ?? {})).toBe(false);
      expect(structuredClone(context ?? {})).toEqual(context ?? {});
    } finally {
      outerController.abort(new Error("test cleanup"));
      await dispatch;
      internals.cleanup();
    }
  }, { timeout: 1_000 });

  test("propagates an outer abort to the matching worker invocation", async () => {
    const { internals, messages } = makeTestHost(false);
    const outerController = new AbortController();
    const dispatch = interceptorPipeline.run(
      [{ role: "user", content: "hello" }],
      {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-1",
        generationType: "normal",
      },
      undefined,
      outerController.signal,
    );

    try {
      const request = messages.find((message) => message.type === "intercept_request");
      expect(request).toBeDefined();
      outerController.abort(new DOMException("Aborted", "AbortError"));
      await expect(dispatch).rejects.toMatchObject({ name: "AbortError" });
      const aborts = messages.filter((message) => message.type === "intercept_abort");
      expect(aborts).toHaveLength(1);
      expect(aborts[0]?.requestId).toBe(request?.requestId);
      expect(aborts[0]?.registrationId).toBe(request?.registrationId);
    } finally {
      internals.cleanup();
    }
  }, { timeout: 1_000 });
});

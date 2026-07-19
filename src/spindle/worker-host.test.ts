import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConnectionDispatchDescriptorDTO,
  ExtensionInfo,
  SpindleManifest,
} from "lumiverse-spindle-types";
import { interceptorPipeline } from "./interceptor-pipeline";
import type { RuntimeTransport } from "./runtime-transport";
import * as managerSvc from "./manager.service";
import * as dispatchStateSvc from "../services/dispatch-state.service";
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

type TestBoundEnvelope = {
  workerId: string;
  registrationGeneration: string;
  callbackUserId: string;
  hostGeneration: string;
  requestId: string;
  token: string;
  operationRequestId?: string;
};

type TestFrontendScopeEnvelope = {
  token: string;
  operationRequestId?: string;
};

type CapturedRuntimeMessage = {
  type?: string;
  requestId?: string;
  registrationId?: string;
  registrationGeneration?: string;
  workerId?: string;
  hostGeneration?: string;
  messages?: Array<{ role: string; content: string }>;
  context?: Record<string, unknown>;
  finalResponse?: unknown;
  __spindle_private_bound?: TestBoundEnvelope;
  result?: unknown;
  error?: unknown;
  payload?: unknown;
  userId?: string;
  token?: string;
  __spindle_private_frontend?: TestFrontendScopeEnvelope;
};

type WorkerHostInternals = {
  runtime: RuntimeTransport | null;
  runtimeGeneration: string;
  hasPermission: (permission: string) => boolean;
  handleRegisterInterceptor: (registrationId: string, priority?: number, match?: unknown) => void;
  handleInterceptorResult: (message: unknown) => void;
  boundInvocation: (
    requestId: string,
    envelope?: TestBoundEnvelope,
  ) => { controller: AbortController } | null;
  handleCancelGeneration: (requestId: string, envelope?: TestBoundEnvelope) => void;
  sendFrontendMessage: (payload: unknown, userId: string) => void;
  handleMessage: (message: unknown) => void;
  handleDispatchResolution: (message: {
    type: "connections_resolve_dispatch";
    requestId: string;
    connectionId: string;
    __spindle_private_bound?: TestBoundEnvelope;
    __spindle_private_frontend?: TestFrontendScopeEnvelope;
  }) => Promise<void>;
  cleanup: () => void;
};

const TEST_REGISTRATION_ID = "registration-worker-host-test";

function makeParentSnapshot(hostGeneration: string): ParentGenerationSnapshot {
  return {
    kind: "parent-generation",
    hostGeneration: brandHostGenerationId(hostGeneration),
    generationId: "parent-generation-worker-host-test",
    userId: "user-1",
    chatId: "chat-1",
    main: { kind: "main" },
    retrieval: { kind: "parent-retrieval", capturedAt: 1 },
    parentIdentities: {},
    options: { generationType: "normal" },
    parentPrefill: { id: "prefill-worker-host-test", state: "absent" },
    interceptorDeadlineAt: 10_000,
    boundWorkDeadlineAt: 9_000,
  } as unknown as ParentGenerationSnapshot;
}

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

describe("WorkerHost frontend-message dispatch authority", () => {
  test("resolves only through a live authenticated user scope with generation permission", async () => {
    const { internals, messages } = makeTestHost(false);
    const descriptor = {
      connectionId: "connection-1",
      connectionName: "Test connection",
      provider: "openai-compatible",
      model: "test-model",
      endpointOrigin: "https://example.test",
      dispatchKind: "concrete",
      connectionDispatchRevision: "revision-1",
    } satisfies ConnectionDispatchDescriptorDTO;
    // Test seam: this handler exposes only the descriptor from the larger service result.
    const resolved = { descriptor } as unknown as dispatchStateSvc.ResolvedDispatchDescriptor;
    const resolveSpy = spyOn(dispatchStateSvc, "resolveDispatchDescriptor").mockReturnValue(resolved);

    try {
      internals.sendFrontendMessage({ type: "inspect" }, "user-1");
      const delivered = messages.find((message) => message.type === "frontend_message");
      expect(delivered).toMatchObject({
        payload: { type: "inspect" },
        userId: "user-1",
      });
      const token = delivered?.__spindle_private_frontend?.token;
      expect(token).toEqual(expect.any(String));

      await internals.handleDispatchResolution({
        type: "connections_resolve_dispatch",
        requestId: "frontend-dispatch-1",
        connectionId: "connection-1",
        __spindle_private_frontend: {
          token: token!,
          operationRequestId: "frontend-dispatch-1",
        },
      });
      expect(resolveSpy).toHaveBeenCalledWith("user-1", {
        source: "slot",
        connectionId: "connection-1",
      });
      expect(messages.find((message) => message.requestId === "frontend-dispatch-1")).toMatchObject({
        type: "response",
        result: descriptor,
      });

      internals.handleMessage({
        type: "frontend_message_scope_complete",
        token,
      });
      await internals.handleDispatchResolution({
        type: "connections_resolve_dispatch",
        requestId: "frontend-dispatch-expired",
        connectionId: "connection-1",
        __spindle_private_frontend: {
          token: token!,
          operationRequestId: "frontend-dispatch-expired",
        },
      });
      expect(messages.find((message) => message.requestId === "frontend-dispatch-expired")).toMatchObject({
        type: "response",
        error: "CONNECTION_DISPATCH_SCOPE_REQUIRED",
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      internals.sendFrontendMessage({ type: "inspect-denied" }, "user-1");
      const deniedDelivery = messages.find(
        (message) => message.type === "frontend_message" &&
          (message.payload as { type?: string } | undefined)?.type === "inspect-denied",
      );
      internals.hasPermission = () => false;
      await internals.handleDispatchResolution({
        type: "connections_resolve_dispatch",
        requestId: "frontend-dispatch-denied",
        connectionId: "connection-1",
        __spindle_private_frontend: {
          token: deniedDelivery?.__spindle_private_frontend?.token ?? "",
          operationRequestId: "frontend-dispatch-denied",
        },
      });
      expect(messages.find((message) => message.requestId === "frontend-dispatch-denied")).toMatchObject({
        type: "response",
        error: expect.stringContaining("PERMISSION_DENIED: generation"),
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    } finally {
      resolveSpy.mockRestore();
      internals.cleanup();
    }
  });
});

describe("WorkerHost interceptor transport boundary", () => {
  test("sends a cloneable signal-free context with runtimeGeneration and settles sync transport failure", async () => {
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
      expect(request?.hostGeneration).toBe(internals.runtimeGeneration);
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
  test("settles a parent-bound result with distinct runtime and parent provenance", async () => {
    const { internals, messages } = makeTestHost(false);
    const parent = makeParentSnapshot("parent-host-generation-worker-host-test");
    const dispatch = interceptorPipeline.run(
      [{ role: "user", content: "hello" }],
      {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-1",
        generationType: "normal",
      },
      "user-1",
      undefined,
      { parentGenerationSnapshot: parent },
    );
    const request = messages.find((message) => message.type === "intercept_request");
    expect(request).toBeDefined();
    expect(request?.hostGeneration).toBe(internals.runtimeGeneration);
    expect(request?.hostGeneration).not.toBe(parent.hostGeneration);
    expect(request?.__spindle_private_bound?.hostGeneration).toBe(parent.hostGeneration);
    const grantSpy = spyOn(managerSvc, "getPermissionGrantId").mockImplementation(
      (_identifier, permission) => permission === "final_response" ? "final-grant" : undefined,
    );

    try {
      const requestId = request?.requestId;
      const registrationId = request?.registrationId;
      const registrationGeneration = request?.registrationGeneration;
      const workerId = request?.workerId;
      const runtimeGeneration = request?.hostGeneration;
      if (!requestId || !registrationId || !registrationGeneration || !workerId || !runtimeGeneration) {
        throw new Error("interceptor request fixture is incomplete");
      }
      internals.handleInterceptorResult({
        type: "intercept_result",
        requestId,
        registrationId,
        registrationGeneration,
        workerId,
        hostGeneration: runtimeGeneration,
        messages: [
          { role: "system", content: "inserted by callback" },
          { role: "user", content: "hello" },
        ],
        breakdown: [{ messageIndex: 0, name: "callback insertion" }],
        finalResponse: {
          content: "authoritative response",
          fallbackMessageIndex: 0,
        },
      });
      const result = await dispatch;
      expect(result.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "system", content: "inserted by callback" },
        { role: "user", content: "hello" },
      ]);
      expect(result.finalResponseState).toMatchObject({
        status: "valid",
        hostGeneration: parent.hostGeneration,
      });
    } finally {
      grantSpy.mockRestore();
      internals.cleanup();
      await dispatch;
    }
  }, { timeout: 1_000 });

  test("does not let a foreign bound callback cancel another callback operation", async () => {
    const { internals, messages } = makeTestHost(false);
    const dispatchA = interceptorPipeline.run(
      [{ role: "user", content: "first" }],
      {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-a",
        generationType: "normal",
      },
      "user-1",
      undefined,
      { parentGenerationSnapshot: makeParentSnapshot("parent-host-generation-a") },
    );
    const dispatchB = interceptorPipeline.run(
      [{ role: "user", content: "second" }],
      {
        userId: "user-1",
        chatId: "chat-1",
        generationId: "generation-b",
        generationType: "normal",
      },
      "user-1",
      undefined,
      { parentGenerationSnapshot: makeParentSnapshot("parent-host-generation-b") },
    );

    try {
      const requests = messages.filter((message) => message.type === "intercept_request");
      expect(requests).toHaveLength(2);
      const first = requests[0];
      const second = requests[1];
      if (!first?.requestId || !first.__spindle_private_bound || !second?.__spindle_private_bound) {
        throw new Error("bound interceptor request fixtures are incomplete");
      }
      const operationRequestId = "bound-operation-a";
      const operation = internals.boundInvocation(operationRequestId, {
        ...first.__spindle_private_bound,
        operationRequestId,
      });
      expect(operation).not.toBeNull();
      internals.handleCancelGeneration(operationRequestId, {
        ...second.__spindle_private_bound,
        operationRequestId,
      });
      expect(operation?.controller.signal.aborted).toBe(false);
    } finally {
      internals.cleanup();
      await dispatchA;
      await dispatchB;
    }
  }, { timeout: 1_000 });
});

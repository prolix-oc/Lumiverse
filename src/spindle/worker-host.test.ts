import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConnectionDispatchDescriptorDTO,
  ExtensionInfo,
  SpindleManifest,
} from "lumiverse-spindle-types";
import { interceptorPipeline, type InterceptorResult } from "./interceptor-pipeline";
import { createBoundHostContainmentFatal } from "./bound-generation";
import { brandHostGenerationId, isHostContainmentFatal } from "./bound-generation-types";
import type { ParentGenerationSnapshot } from "./bound-generation-types";
import type { RuntimeTransport } from "./runtime-transport";
import * as boundGeneration from "./bound-generation";
import * as managerSvc from "./manager.service";
import * as dispatchStateSvc from "../services/dispatch-state.service";
import { WorkerHost } from "./worker-host";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import * as imageRegistry from "../image-gen/registry";
import * as secretsSvc from "../services/secrets.service";
import * as imagesSvc from "../services/images.service";

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
  event?: unknown;
  __spindle_private_bound?: TestBoundEnvelope;
  result?: unknown;
  error?: unknown;
  reason?: string;
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
  handleBoundAssemble: (message: unknown) => Promise<void>;
  handleBoundQuietTracked: (message: unknown) => Promise<void>;
  handleBoundContainmentGraceExpiry: (requestId: string) => void;
  boundInvocation: (
    requestId: string,
    envelope?: TestBoundEnvelope,
  ) => { controller: AbortController } | null;
  boundOperationControllers: Map<string, unknown>;
  interceptorInvocations: Map<string, unknown>;
  interceptorControllersBySignal: Map<AbortSignal, unknown>;
  handleCancelGeneration: (requestId: string, envelope?: TestBoundEnvelope) => void;
  handleImageGenGenerateStream: (requestId: string, input: unknown) => Promise<void>;
  handleImageGenCancelStream: (requestId: string) => void;
  imageGenerationAbortControllers: Map<string, AbortController>;
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

type BoundInterceptRequest = CapturedRuntimeMessage & {
  requestId: string;
  registrationId: string;
  registrationGeneration: string;
  workerId: string;
  hostGeneration: string;
  __spindle_private_bound: TestBoundEnvelope;
};

function requireBoundInterceptRequest(
  messages: readonly CapturedRuntimeMessage[],
): BoundInterceptRequest {
  const request = messages.find((message) => message.type === "intercept_request");
  if (
    !request?.requestId
    || !request.registrationId
    || !request.registrationGeneration
    || !request.workerId
    || !request.hostGeneration
    || !request.__spindle_private_bound
  ) {
    throw new Error("bound interceptor request fixture is incomplete");
  }
  return request as BoundInterceptRequest;
}

function makeBoundOperationMessage(
  request: BoundInterceptRequest,
  type: "generate_assemble" | "generate_quiet_tracked",
  operationRequestId: string,
): Record<string, unknown> {
  return {
    type,
    requestId: operationRequestId,
    input: {},
    __spindle_private_bound: {
      ...request.__spindle_private_bound,
      operationRequestId,
    },
  };
}

function makeWorkerInterceptResult(
  request: BoundInterceptRequest,
): Record<string, unknown> {
  return {
    type: "intercept_result",
    requestId: request.requestId,
    registrationId: request.registrationId,
    registrationGeneration: request.registrationGeneration,
    workerId: request.workerId,
    hostGeneration: request.hostGeneration,
    messages: request.messages ?? [{ role: "user", content: "hello" }],
  };
}

function boundParentDispatch(parent: ParentGenerationSnapshot): Promise<InterceptorResult> {
  return interceptorPipeline.run(
    [{ role: "user", content: "hello" }],
    {
      userId: "user-1",
      chatId: "chat-1",
      generationId: "generation-bound-fatal-test",
      generationType: "normal",
    },
    "user-1",
    undefined,
    { parentGenerationSnapshot: parent },
  );
}

function fatalCode(value: unknown): unknown {
  if (value && typeof value === "object" && "code" in value) {
    return value.code;
  }
  return undefined;
}

function expectNoBoundLeaks(internals: WorkerHostInternals): void {
  expect(internals.boundOperationControllers.size).toBe(0);
  expect(internals.interceptorInvocations.size).toBe(0);
  expect(internals.interceptorControllersBySignal.size).toBe(0);
}

describe("WorkerHost bound containment fatal boundary", () => {
  test("assemble authentic fatal rejects the exact invocation and cleans every bound resource", async () => {
    const { internals, messages } = makeTestHost(false);
    const parent = makeParentSnapshot("parent-host-generation-assemble-fatal");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-assemble-authentic-fatal";
    const fatal = createBoundHostContainmentFatal({
      code: "BOUND_WORKER_CONTAINMENT_FAILED",
      message: "assemble authentic fatal",
      hostGeneration: parent.hostGeneration,
      workerId: request.workerId,
      requestId: request.requestId,
    });
    const runSpy = spyOn(boundGeneration, "runBoundAssembly").mockRejectedValue(fatal as never);

    try {
      await internals.handleBoundAssemble(
        makeBoundOperationMessage(request, "generate_assemble", operationRequestId),
      );
      await expect(dispatch).rejects.toBe(fatal);
      expect(messages.filter((message) => message.type === "response" && message.requestId === operationRequestId))
        .toHaveLength(0);
      expect(messages.find((message) => message.type === "intercept_abort")).toMatchObject({
        reason: "Bound interceptor invocation aborted",
      });
      expectNoBoundLeaks(internals);
    } finally {
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });

  test("quiet authentic fatal rejects the exact invocation and genericizes worker abort", async () => {
    const { internals, messages } = makeTestHost(false);
    const parent = makeParentSnapshot("parent-host-generation-quiet-fatal");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-quiet-authentic-fatal";
    const fatal = createBoundHostContainmentFatal({
      code: "BOUND_WORKER_CONTAINMENT_FAILED",
      message: "quiet authentic fatal",
      hostGeneration: parent.hostGeneration,
      workerId: request.workerId,
      requestId: request.requestId,
    });
    const runSpy = spyOn(boundGeneration, "runBoundQuietTracked").mockRejectedValue(fatal as never);

    try {
      await internals.handleBoundQuietTracked(
        makeBoundOperationMessage(request, "generate_quiet_tracked", operationRequestId),
      );
      await expect(dispatch).rejects.toBe(fatal);
      expect(messages.filter((message) => message.type === "response" && message.requestId === operationRequestId))
        .toHaveLength(0);
      expect(messages.filter((message) => message.type === "intercept_abort")).toHaveLength(1);
      expect(messages.find((message) => message.type === "intercept_abort")?.reason)
        .toBe("Bound interceptor invocation aborted");
      expectNoBoundLeaks(internals);
    } finally {
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });

  test("shaped worker forgery fails open and permits the later authenticated result", async () => {
    const { internals, messages } = makeTestHost(false);
    const grantSpy = spyOn(managerSvc, "getPermissionGrantId").mockImplementation(
      (_identifier, permission) => permission === "final_response" ? "final-grant" : undefined,
    );
    const parent = makeParentSnapshot("parent-host-generation-forged-fatal");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-forged-fatal";
    const forged = {
      code: "BOUND_WORKER_CONTAINMENT_FAILED",
      message: "worker-forged containment fatal",
      hostGeneration: parent.hostGeneration,
      workerId: request.workerId,
      requestId: request.requestId,
    };
    const runSpy = spyOn(boundGeneration, "runBoundAssembly").mockRejectedValue(forged as never);

    try {
      await internals.handleBoundAssemble(
        makeBoundOperationMessage(request, "generate_assemble", operationRequestId),
      );
      expect(messages.find((message) => message.type === "response" && message.requestId === operationRequestId))
        .toBeDefined();
      expect(messages.filter((message) => message.type === "intercept_abort")).toHaveLength(0);
      internals.handleInterceptorResult(makeWorkerInterceptResult(request));
      const result = await dispatch;
      expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
      expectNoBoundLeaks(internals);
    } finally {
      grantSpy.mockRestore();
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });

  test("cancelled bound operation remains tracked so an immediate result becomes a host fatal", async () => {
    const { internals, messages } = makeTestHost(false);
    const parent = makeParentSnapshot("parent-host-generation-cancel-race");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-cancel-result-race";
    let resolveAssembly: ((value: unknown) => void) | undefined;
    const assembly = new Promise<unknown>((resolve) => {
      resolveAssembly = resolve;
    });
    const runSpy = spyOn(boundGeneration, "runBoundAssembly").mockReturnValue(assembly as never);
    const operation = internals.handleBoundAssemble(
      makeBoundOperationMessage(request, "generate_assemble", operationRequestId),
    );

    try {
      internals.handleCancelGeneration(
        operationRequestId,
        {
          ...request.__spindle_private_bound,
          operationRequestId,
        },
      );
      expect(internals.boundOperationControllers.has(operationRequestId)).toBe(true);
      internals.handleInterceptorResult(makeWorkerInterceptResult(request));
      const error = await dispatch.catch((reason) => reason);
      expect(isHostContainmentFatal(error)).toBe(true);
      expect(fatalCode(error)).toBe("BOUND_WORKER_CONTAINMENT_FAILED");
      resolveAssembly?.({});
      await operation;
      expectNoBoundLeaks(internals);
    } finally {
      resolveAssembly?.({});
      await operation.catch(() => undefined);
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });

  test("accepts a later result after a cancelled bound operation has settled", async () => {
    const { internals, messages } = makeTestHost(false);
    const grantSpy = spyOn(managerSvc, "getPermissionGrantId").mockImplementation(
      (_identifier, permission) => permission === "final_response" ? "final-grant" : undefined,
    );
    const parent = makeParentSnapshot("parent-host-generation-cancel-settles");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-cancel-settles";
    let resolveAssembly: ((value: unknown) => void) | undefined;
    const assembly = new Promise<unknown>((resolve) => {
      resolveAssembly = resolve;
    });
    const runSpy = spyOn(boundGeneration, "runBoundAssembly").mockReturnValue(assembly as never);
    const operation = internals.handleBoundAssemble(
      makeBoundOperationMessage(request, "generate_assemble", operationRequestId),
    );

    try {
      internals.handleCancelGeneration(
        operationRequestId,
        {
          ...request.__spindle_private_bound,
          operationRequestId,
        },
      );
      expect(internals.boundOperationControllers.has(operationRequestId)).toBe(true);
      resolveAssembly?.({});
      await operation;
      expect(internals.boundOperationControllers.has(operationRequestId)).toBe(false);
      internals.handleInterceptorResult(makeWorkerInterceptResult(request));
      const result = await dispatch;
      expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
      expectNoBoundLeaks(internals);
    } finally {
      resolveAssembly?.({});
      await operation.catch(() => undefined);
      grantSpy.mockRestore();
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });

  test("containment grace expiry escalates a non-draining early-result operation and leaves no leaks", async () => {
    const { internals, messages } = makeTestHost(false);
    const parent = makeParentSnapshot("parent-host-generation-grace-expiry");
    const dispatch = boundParentDispatch(parent);
    const request = requireBoundInterceptRequest(messages);
    const operationRequestId = "bound-grace-expiry";
    let resolveAssembly: ((value: unknown) => void) | undefined;
    const assembly = new Promise<unknown>((resolve) => {
      resolveAssembly = resolve;
    });
    const runSpy = spyOn(boundGeneration, "runBoundAssembly").mockReturnValue(assembly as never);
    const operation = internals.handleBoundAssemble(
      makeBoundOperationMessage(request, "generate_assemble", operationRequestId),
    );

    try {
      internals.handleInterceptorResult(makeWorkerInterceptResult(request));
      const error = await dispatch.catch((reason) => reason);
      expect(isHostContainmentFatal(error)).toBe(true);
      expect(fatalCode(error)).toBe("BOUND_WORKER_CONTAINMENT_FAILED");
      internals.handleBoundContainmentGraceExpiry(request.requestId);
      resolveAssembly?.({});
      await operation;
      expectNoBoundLeaks(internals);
    } finally {
      resolveAssembly?.({});
      await operation.catch(() => undefined);
      runSpy.mockRestore();
      internals.cleanup();
      await dispatch.catch(() => undefined);
    }
  });
});

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

describe("WorkerHost image generation stream bridge", () => {
  function imageConnection() {
    return {
      id: "image-connection-1",
      name: "Test image connection",
      provider: "comfyui",
      api_url: "http://image.test",
      model: "test-model",
      default_parameters: { steps: 12, width: 512 },
    };
  }

  test("enforces permission and provider preview-stream capability", async () => {
    const { internals, messages } = makeTestHost(false);
    const connectionSpy = spyOn(imageGenConnSvc, "getConnection").mockReturnValue(imageConnection() as never);
    const providerSpy = spyOn(imageRegistry, "getImageProvider").mockReturnValue({
      name: "sdapi",
      capabilities: {
        parameters: {},
        apiKeyRequired: false,
        modelListStyle: "dynamic",
        defaultUrl: "",
      },
      generateStream: (async function* () {
        return {
          imageDataUrl: "data:image/png;base64,ZmFpbA==",
          model: "test-model",
          provider: "sdapi",
        };
      }) as never,
    } as never);
    try {
      internals.hasPermission = () => false;
      await internals.handleImageGenGenerateStream("image-permission-denied", {
        prompt: "test",
        connection_id: "image-connection-1",
        userId: "user-1",
      });
      const permissionError = messages.find(
        (message) => message.requestId === "image-permission-denied",
      );
      expect(permissionError?.type).toBe("image_gen_stream_error");
      expect(permissionError?.error).toContain("image_gen");

      internals.hasPermission = () => true;
      await internals.handleImageGenGenerateStream("image-capability-denied", {
        prompt: "test",
        connection_id: "image-connection-1",
        userId: "user-1",
      });
      const capabilityError = messages.find(
        (message) => message.requestId === "image-capability-denied",
      );
      expect(capabilityError?.type).toBe("image_gen_stream_error");
      expect(capabilityError?.error).toContain("preview streaming");
    } finally {
      providerSpy.mockRestore();
      connectionSpy.mockRestore();
      internals.cleanup();
    }
  });

  test("forwards ordered status/preview events and persists the terminal result", async () => {
    const { internals, messages } = makeTestHost(false);
    const connectionSpy = spyOn(imageGenConnSvc, "getConnection").mockReturnValue(imageConnection() as never);
    const secretSpy = spyOn(secretsSvc, "getSecret").mockResolvedValue("secret");
    let providerRequest: {
      parameters: Record<string, unknown>;
      signal?: AbortSignal;
    } | undefined;
    const provider = {
      name: "comfyui",
      capabilities: {
        parameters: {},
        apiKeyRequired: true,
        modelListStyle: "dynamic",
        defaultUrl: "",
        websocketPreviewStreaming: { previews: true, status: true },
      },
      generateStream: (
        _apiKey: string,
        _apiUrl: string,
        request: { parameters: Record<string, unknown>; signal?: AbortSignal },
      ) => (async function* () {
        providerRequest = request;
        yield { step: 1, totalSteps: 2 };
        yield { preview: "data:image/png;base64,cHJldmlldw==", step: 1, totalSteps: 2 };
        return {
          imageDataUrl: "data:image/png;base64,ZmluYWw=",
          model: "test-model",
          provider: "comfyui",
        };
      })(),
    };
    const providerSpy = spyOn(imageRegistry, "getImageProvider").mockReturnValue(provider as never);
    const saveSpy = spyOn(imagesSvc, "saveImageFromDataUrl").mockResolvedValue({ id: "image-1" } as never);
    try {
      await internals.handleImageGenGenerateStream("image-stream-success", {
        prompt: "test",
        connection_id: "image-connection-1",
        parameters: { width: 768 },
        owner_character_id: "character-1",
        owner_chat_id: "chat-1",
        userId: "user-1",
      });

      expect(providerRequest?.parameters).toEqual({ steps: 12, width: 768 });
      expect(providerRequest?.signal?.aborted ?? false).toBe(false);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy.mock.calls[0]?.[2]).toMatch(/^image-gen-comfyui-\d+\.png$/);
      expect(saveSpy.mock.calls[0]?.[3]).toEqual({
        owner_extension_identifier: expect.any(String),
        owner_character_id: "character-1",
        owner_chat_id: "chat-1",
      });

      const streamEvents = messages
        .filter((message) => message.requestId === "image-stream-success")
        .map((message) => message.event);
      expect(streamEvents).toEqual([
        { type: "status", step: 1, totalSteps: 2 },
        { type: "status", step: 1, totalSteps: 2 },
        {
          type: "preview",
          imageDataUrl: "data:image/png;base64,cHJldmlldw==",
          step: 1,
          totalSteps: 2,
        },
        {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
            imageId: "image-1",
            imageUrl: "/api/v1/image-gen/results/image-1",
          },
        },
      ]);
      expect(internals.imageGenerationAbortControllers.size).toBe(0);
    } finally {
      saveSpy.mockRestore();
      providerSpy.mockRestore();
      secretSpy.mockRestore();
      connectionSpy.mockRestore();
      internals.cleanup();
    }
  });

  test("aborts the provider stream and emits one terminal error on consumer cancellation", async () => {
    const { internals, messages } = makeTestHost(false);
    const connectionSpy = spyOn(imageGenConnSvc, "getConnection").mockReturnValue(imageConnection() as never);
    const secretSpy = spyOn(secretsSvc, "getSecret").mockResolvedValue("");
    const started = Promise.withResolvers<void>();
    let providerSignal: AbortSignal | undefined;
    const provider = {
      name: "comfyui",
      capabilities: {
        parameters: {},
        apiKeyRequired: false,
        modelListStyle: "dynamic",
        defaultUrl: "",
        websocketPreviewStreaming: { previews: true, status: true },
      },
      generateStream: (
        _apiKey: string,
        _apiUrl: string,
        request: { signal?: AbortSignal },
      ) => (async function* () {
        providerSignal = request.signal;
        started.resolve();
        yield { step: 1 };
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Aborted", "AbortError");
      })(),
    };
    const providerSpy = spyOn(imageRegistry, "getImageProvider").mockReturnValue(provider as never);
    try {
      const operation = internals.handleImageGenGenerateStream("image-stream-cancel", {
        prompt: "test",
        connection_id: "image-connection-1",
        userId: "user-1",
      });
      await started.promise;
      internals.handleImageGenCancelStream("image-stream-cancel");
      await operation;

      expect(providerSignal?.aborted ?? false).toBe(true);
      expect(internals.imageGenerationAbortControllers.size).toBe(0);
      const terminalEvents = messages.filter(
        (message) => message.requestId === "image-stream-cancel",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.type).toBe("image_gen_stream_error");
      expect(terminalEvents.filter((message) => message.type === "image_gen_stream_error")).toHaveLength(1);
    } finally {
      providerSpy.mockRestore();
      secretSpy.mockRestore();
      connectionSpy.mockRestore();
      internals.cleanup();
    }
  });
  test("rolls back a just-persisted image when cancellation races terminal persistence", async () => {
    const { internals, messages } = makeTestHost(false);
    const connectionSpy = spyOn(imageGenConnSvc, "getConnection").mockReturnValue(imageConnection() as never);
    const secretSpy = spyOn(secretsSvc, "getSecret").mockResolvedValue("");
    const saveStarted = Promise.withResolvers<void>();
    const releaseSave = Promise.withResolvers<void>();
    const provider = {
      name: "comfyui",
      capabilities: {
        parameters: {},
        apiKeyRequired: false,
        modelListStyle: "dynamic",
        defaultUrl: "",
        websocketPreviewStreaming: { previews: true, status: true },
      },
      generateStream: () => (async function* () {
        return {
          imageDataUrl: "data:image/png;base64,ZmluYWw=",
          model: "test-model",
          provider: "comfyui",
        };
      })(),
    };
    const providerSpy = spyOn(imageRegistry, "getImageProvider").mockReturnValue(provider as never);
    const saveSpy = spyOn(imagesSvc, "saveImageFromDataUrl").mockImplementation(async () => {
      saveStarted.resolve();
      await releaseSave.promise;
      return { id: "image-cancelled" } as never;
    });
    const deleteSpy = spyOn(imagesSvc, "deleteImage").mockReturnValue(true);
    try {
      const operation = internals.handleImageGenGenerateStream("image-persist-cancel", {
        prompt: "test",
        connection_id: "image-connection-1",
        userId: "user-1",
      });
      await saveStarted.promise;
      internals.handleImageGenCancelStream("image-persist-cancel");
      releaseSave.resolve();
      await operation;

      expect(deleteSpy).toHaveBeenCalledWith("user-1", "image-cancelled");
      expect(messages.filter(
        (message) => message.requestId === "image-persist-cancel"
          && message.type === "image_gen_stream_chunk"
          && (message.event as { type?: string } | undefined)?.type === "done",
      )).toHaveLength(0);
      expect(messages.filter(
        (message) => message.requestId === "image-persist-cancel"
          && message.type === "image_gen_stream_error",
      )).toHaveLength(1);
    } finally {
      deleteSpy.mockRestore();
      saveSpy.mockRestore();
      providerSpy.mockRestore();
      secretSpy.mockRestore();
      connectionSpy.mockRestore();
      internals.cleanup();
    }
  });
});

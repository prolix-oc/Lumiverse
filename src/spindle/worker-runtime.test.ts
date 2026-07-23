import { describe, expect, test } from "bun:test";

type RuntimeMessage = {
  type?: string;
  requestId?: string;
  registrationId?: string;
  name?: string;
  message?: string;
  error?: string;
  result?: unknown;
  messages?: Array<{ role: string; content: string }>;
  __spindle_private_bound?: Record<string, unknown>;
  input?: unknown;
  event?: unknown;
  token?: string;
  __spindle_private_frontend?: Record<string, unknown>;
};

type Waiter = {
  predicate: (message: RuntimeMessage) => boolean;
  resolve: (message: RuntimeMessage) => void;
  reject: (reason: unknown) => void;
};

const MESSAGE_WAIT_TIMEOUT_MS = 10_000;
const VALID_HOST_DESCRIPTOR = {
  descriptorVersion: 1,
  lumiverseVersion: "0.6.2",
  capabilities: {
    "preset-extension-data-v1": 1,
    "preset-editor-v1": 1,
    "loom-block-editor-v1": 1,
    "loom-block-management-v1": 1,
    "generation-assembly-v1": 1,
    "interceptor-context-v1": 1,
    "interceptor-final-response-v1": 1,
    "connection-dispatch-resolution-v1": 1,
    "unknown-capability-v1": 7,
  },
  extensionInstallationId: "00000000-0000-4000-8000-000000000001",
} as const;

function waitForMessage(
  messages: RuntimeMessage[],
  waiters: Waiter[],
  predicate: (message: RuntimeMessage) => boolean,
): Promise<RuntimeMessage> {
  const existing = messages.find(predicate);
  if (existing) {
    messages.splice(messages.indexOf(existing), 1);
    return Promise.resolve(existing);
  }

  const { promise, resolve, reject } = Promise.withResolvers<RuntimeMessage>();
  let resolveWithTimeout: Waiter["resolve"];
  const timeout = setTimeout(() => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolveWithTimeout);
    if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
    const queued = messages.slice(-8).map(({ type, requestId, message, error }) =>
      JSON.stringify({ type, requestId, message, error }),
    ).join(", ");
    reject(new Error(`Timed out waiting for worker message; queued=[${queued}]`));
  }, MESSAGE_WAIT_TIMEOUT_MS);

  resolveWithTimeout = (message: RuntimeMessage): void => {
    clearTimeout(timeout);
    resolve(message);
  };
  waiters.push({
    predicate,
    resolve: resolveWithTimeout,
    reject: (reason) => {
      clearTimeout(timeout);
      reject(reason);
    },
  });
  return promise;
}

async function startRuntime(
  entrySource: string,
  grantedPermissions: readonly string[] = [
    "interceptor",
    "generation",
    "generation_parameters",
    "final_response",
    "presets",
  ],
): Promise<{ worker: Worker; messages: RuntimeMessage[]; waiters: Waiter[] }> {
  const worker = new Worker(new URL("./worker-runtime.ts", import.meta.url), { type: "module" });
  const messages: RuntimeMessage[] = [];
  const waiters: Waiter[] = [];

  worker.onmessage = (event) => {
    const message = event.data as RuntimeMessage;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      messages.push(message);
      return;
    }
    const waiter = waiters.splice(waiterIndex, 1)[0]!;
    waiter.resolve(message);
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "Worker failed");
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  const entry = `data:text/javascript,${encodeURIComponent(entrySource)}`;
  worker.postMessage({
    type: "init",
    manifest: {
      identifier: `worker-runtime-${crypto.randomUUID()}`,
      name: "Worker runtime test",
      version: "1.0.0",
      entry_backend: entry,
      requested_capabilities: ["interceptor", "generation"],
    },
    host: VALID_HOST_DESCRIPTOR,
    storagePath: "/tmp/worker-runtime-test",
  });

  try {
    const permissionRequest = await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "permissions_get_granted",
    );
    worker.postMessage({
      type: "response",
      requestId: permissionRequest.requestId,
      result: [...grantedPermissions],
    });
    await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "log" && message.message === "__worker_ready__",
    );
    return { worker, messages, waiters };
  } catch (error) {
    worker.terminate();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    throw error;
  }
}

async function runInitUntilStartupFailure(
  entrySource: string,
  host: unknown,
): Promise<{ failure: RuntimeMessage; messages: RuntimeMessage[] }> {
  const worker = new Worker(new URL("./worker-runtime.ts", import.meta.url), { type: "module" });
  const messages: RuntimeMessage[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<RuntimeMessage>();
  const timeout = setTimeout(
    () => reject(new Error("Timed out waiting for startup failure")),
    MESSAGE_WAIT_TIMEOUT_MS,
  );
  worker.onmessage = (event) => {
    const message = event.data as RuntimeMessage;
    if (message.type === "permissions_get_granted" && message.requestId) {
      worker.postMessage({
        type: "response",
        requestId: message.requestId,
        result: [],
      });
    }
    messages.push(message);
    if (message.type === "startup_failure") {
      clearTimeout(timeout);
      resolve(message);
    }
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(new Error(event.message || "Worker failed"));
  };
  const entry = `data:text/javascript,${encodeURIComponent(entrySource)}`;
  worker.postMessage({
    type: "init",
    manifest: {
      identifier: `worker-startup-boundary-${crypto.randomUUID()}`,
      name: "Worker startup boundary test",
      version: "1.0.0",
      entry_backend: entry,
      requested_capabilities: ["interceptor", "generation"],
    },
    host,
    storagePath: "/tmp/worker-startup-boundary-test",
  });
  try {
    return { failure: await promise, messages };
  } finally {
    worker.terminate();
  }
}

async function stopRuntime(runtime: { worker: Worker; messages: RuntimeMessage[]; waiters: Waiter[] }): Promise<void> {
  try {
    runtime.worker.postMessage({ type: "shutdown" });
    await waitForMessage(
      runtime.messages,
      runtime.waiters,
      (message) => message.type === "log" && message.message === "__worker_shutdown_ack__",
    );
  } finally {
    runtime.worker.terminate();
  }
}

function parentBoundEnvelope(requestId: string): Record<string, unknown> {
  return {
    workerId: "worker-1",
    registrationGeneration: "registration-1",
    callbackUserId: "user-1",
    hostGeneration: "host-1",
    requestId,
    token: "token-1",
  };
}

function callbackContext(): Record<string, unknown> {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationId: "generation-1",
    generationType: "normal",
    presetMetadata: null,
  };
}

describe("Worker startup boundary", () => {
  test("exposes a frozen validated descriptor before extension source", async () => {
    const runtime = await startRuntime(`
      const host = spindle.host;
      spindle.log.info(JSON.stringify({
        descriptorFrozen: Object.isFrozen(host),
        capabilitiesFrozen: Object.isFrozen(host.capabilities),
        unknownCapability: host.capabilities["unknown-capability-v1"],
      }));
    `);
    try {
      const log = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("{") === true,
      );
      const result = JSON.parse(log.message!);
      expect(result.descriptorFrozen).toBe(true);
      expect(result.capabilitiesFrozen).toBe(true);
      expect(result.unknownCapability).toBe(7);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

  test("rejects a missing descriptor without importing or registering", async () => {
    const result = await runInitUntilStartupFailure(
      `spindle.registerInterceptor(() => []);`,
      undefined,
    );
    expect(result.failure.type).toBe("startup_failure");
    expect(result.failure.message ?? "").toContain("descriptor");
    expect(result.messages.some((message) => message.type === "register_interceptor")).toBe(false);
  }, { timeout: 30_000 });

  test("rejects an invalid installation descriptor without importing", async () => {
    const malformedHost = {
      ...VALID_HOST_DESCRIPTOR,
      extensionInstallationId: "00000000-0000-0000-8000-000000000001",
    };
    const result = await runInitUntilStartupFailure(
      `spindle.registerInterceptor(() => []);`,
      malformedHost,
    );
    expect(result.failure.type).toBe("startup_failure");
    expect(result.messages.some((message) => message.type === "register_interceptor")).toBe(false);
  }, { timeout: 30_000 });

  test("reports source-load failure instead of resolving ready", async () => {
    const result = await runInitUntilStartupFailure(
      `throw new Error("source-load-failure");`,
      VALID_HOST_DESCRIPTOR,
    );
    expect(result.failure.type).toBe("startup_failure");
    expect(result.failure.message ?? "").toContain("source-load-failure");
    expect(result.messages.some((message) => message.type === "log" && message.message === "__worker_ready__")).toBe(false);
  }, { timeout: 30_000 });
});

describe("Worker nested generation authority", () => {
  test("runs assemble, quietTracked, and dispatch inspection under one parent binding", async () => {
    const runtime = await startRuntime(`
      spindle.registerInterceptor(async (messages) => {
        const dispatch = { source: "main", expectedConnectionDispatchRevision: "revision-1" };
        const assembly = await spindle.generate.assemble({
          blocks: [],
          dispatch,
          deadlineAt: Date.now() + 5_000,
        });
        const quiet = await spindle.generate.quietTracked({
          messages,
          dispatch,
          deadlineAt: Date.now() + 5_000,
        });
        const descriptor = await spindle.connections.resolveDispatch("connection-1");
        spindle.log.info("nested-results:" + JSON.stringify({ assembly, quiet, descriptor }));
        return messages;
      });
    `);

    try {
      const registration = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "register_interceptor",
      );
      const parentRequestId = "parent-request-1";
      runtime.worker.postMessage({
        type: "intercept_request",
        requestId: parentRequestId,
        registrationId: registration.registrationId,
        messages: [{ role: "user", content: "hello" }],
        context: callbackContext(),
        __spindle_private_bound: parentBoundEnvelope(parentRequestId),
      });

      const assemblyRequest = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "generate_assemble",
      );
      const assemblyEnvelope = assemblyRequest.__spindle_private_bound ?? {};
      expect(assemblyRequest.requestId).toEqual(expect.any(String));
      expect(assemblyEnvelope.requestId).toBe(parentRequestId);
      expect(assemblyEnvelope.operationRequestId).toBe(assemblyRequest.requestId);
      runtime.worker.postMessage({
        type: "response",
        requestId: assemblyRequest.requestId,
        result: {
          ok: true,
          result: {
            messages: [{ role: "system", content: "assembled" }],
            breakdown: [],
            resolved: {
              source: "main",
              connectionId: null,
              connectionDispatchRevision: "revision-1",
              dispatchKind: "concrete",
            },
          },
        },
      });

      const quietRequest = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "generate_quiet_tracked",
      );
      const quietEnvelope = quietRequest.__spindle_private_bound ?? {};
      expect(quietEnvelope.requestId).toBe(parentRequestId);
      expect(quietEnvelope.operationRequestId).toBe(quietRequest.requestId);
      runtime.worker.postMessage({
        type: "response",
        requestId: quietRequest.requestId,
        result: {
          ok: true,
          response: { content: "quiet answer", finish_reason: "stop" },
          receipt: {
            providerInvoked: true,
            terminalResponse: true,
            source: "main",
            connectionId: null,
            connectionDispatchRevision: "revision-1",
          },
        },
      });

      const dispatchRequest = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "connections_resolve_dispatch",
      );
      const dispatchEnvelope = dispatchRequest.__spindle_private_bound ?? {};
      expect(dispatchEnvelope.requestId).toBe(parentRequestId);
      expect(dispatchEnvelope.operationRequestId).toBe(dispatchRequest.requestId);
      runtime.worker.postMessage({
        type: "response",
        requestId: dispatchRequest.requestId,
        result: {
          connectionId: "connection-1",
          connectionName: "Test connection",
          provider: "openai-compatible",
          model: "test-model",
          endpointOrigin: "https://example.test",
          dispatchKind: "concrete",
          connectionDispatchRevision: "revision-1",
        },
      });

      const resultLog = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("nested-results:") === true,
      );
      const result = JSON.parse(resultLog.message!.slice("nested-results:".length)) as {
        assembly: { ok: boolean };
        quiet: { ok: boolean };
        descriptor: { connectionId: string };
      };
      expect(result.assembly.ok).toBe(true);
      expect(result.quiet.ok).toBe(true);
      expect(result.descriptor.connectionId).toBe("connection-1");

      const callbackResult = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "intercept_result" && message.requestId === parentRequestId,
      );
      expect(callbackResult.registrationId).toBe(registration.registrationId);
      expect(callbackResult.messages).toEqual([{ role: "user", content: "hello" }]);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });
});

describe("Worker frontend-message dispatch authority", () => {
  test("binds dispatch resolution to the authenticated callback scope and completes it", async () => {
    const runtime = await startRuntime(`
      void spindle.connections.resolveDispatch("connection-1").catch((error) => {
        spindle.log.info("unscoped-error:" + error.message);
      });
      spindle.onFrontendMessage(async (_payload, userId) => {
        const descriptor = await spindle.connections.resolveDispatch("connection-1");
        spindle.log.info("frontend-dispatch:" + JSON.stringify({ userId, descriptor }));
      });
    `);

    try {
      const unscoped = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("unscoped-error:") === true,
      );
      expect(unscoped.message).toContain("CONNECTION_DISPATCH_SCOPE_REQUIRED");

      runtime.worker.postMessage({
        type: "frontend_message",
        payload: { type: "inspect" },
        userId: "user-1",
        __spindle_private_frontend: { token: "frontend-scope-1" },
      });

      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "connections_resolve_dispatch",
      );
      expect(request.__spindle_private_bound).toBeUndefined();
      expect(request.__spindle_private_frontend).toEqual({
        token: "frontend-scope-1",
        operationRequestId: request.requestId,
      });
      runtime.worker.postMessage({
        type: "response",
        requestId: request.requestId,
        result: {
          connectionId: "connection-1",
          connectionName: "Test connection",
          provider: "openai-compatible",
          model: "test-model",
          endpointOrigin: "https://example.test",
          dispatchKind: "concrete",
          connectionDispatchRevision: "revision-1",
        },
      });

      const resultLog = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("frontend-dispatch:") === true,
      );
      expect(JSON.parse(resultLog.message!.slice("frontend-dispatch:".length))).toEqual({
        userId: "user-1",
        descriptor: {
          connectionId: "connection-1",
          connectionName: "Test connection",
          provider: "openai-compatible",
          model: "test-model",
          endpointOrigin: "https://example.test",
          dispatchKind: "concrete",
          connectionDispatchRevision: "revision-1",
        },
      });

      const completed = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "frontend_message_scope_complete",
      );
      expect(completed.token).toBe("frontend-scope-1");
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });
});

describe("Worker interceptor lifecycle", () => {
  test("runs concurrent callbacks for one registration with distinct results", async () => {
    const runtime = await startRuntime(`
      let calls = 0;
      const pending = [];
      spindle.registerInterceptor(async (messages) => {
        const call = ++calls;
        spindle.log.info("callback-start:" + call);
        const { promise, resolve } = Promise.withResolvers();
        pending.push(resolve);
        if (pending.length === 2) {
          for (const release of pending.splice(0)) release();
        }
        await promise;
        return messages.map((message) => ({
          ...message,
          content: message.content + ":" + call,
        }));
      });
    `);

    try {
      const registration = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "register_interceptor",
      );
      expect(registration.registrationId).toMatch(/^[0-9a-f-]{36}$/i);

      const request = {
        type: "intercept_request",
        registrationId: registration.registrationId,
        messages: [{ role: "user", content: "hello" }],
        context: callbackContext(),
      };
      runtime.worker.postMessage({ ...request, requestId: "concurrent-1" });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-start:1",
      );
      runtime.worker.postMessage({ ...request, requestId: "concurrent-2" });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-start:2",
      );

      const [firstResult, secondResult] = await Promise.all([
        waitForMessage(
          runtime.messages,
          runtime.waiters,
          (message) => message.type === "intercept_result" && message.requestId === "concurrent-1",
        ),
        waitForMessage(
          runtime.messages,
          runtime.waiters,
          (message) => message.type === "intercept_result" && message.requestId === "concurrent-2",
        ),
      ]);
      expect(firstResult.registrationId).toBe(registration.registrationId);
      expect(secondResult.registrationId).toBe(registration.registrationId);
      expect(firstResult.messages).toEqual([{ role: "user", content: "hello:1" }]);
      expect(secondResult.messages).toEqual([{ role: "user", content: "hello:2" }]);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

  test("aborts only the targeted concurrent callback for one registration", async () => {
    const runtime = await startRuntime(`
      let calls = 0;
      spindle.registerInterceptor(async (messages, context) => {
        const call = ++calls;
        spindle.log.info("callback-start:" + call);
        if (call === 1) {
          const { promise, resolve } = Promise.withResolvers();
          context.signal.addEventListener("abort", () => {
            spindle.log.info("callback-abort:1");
            resolve();
          }, { once: true });
          await promise;
        }
        spindle.log.info("callback-end:" + call);
        return messages.map((message) => ({
          ...message,
          content: message.content + ":" + call,
        }));
      });
    `);

    try {
      const registration = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "register_interceptor",
      );
      const messages = [{ role: "user", content: "hello" }];
      runtime.worker.postMessage({
        type: "intercept_request",
        requestId: "abort-target",
        registrationId: registration.registrationId,
        messages,
        context: callbackContext(),
      });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-start:1",
      );
      runtime.worker.postMessage({
        type: "intercept_request",
        requestId: "abort-other",
        registrationId: registration.registrationId,
        messages,
        context: callbackContext(),
      });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-start:2",
      );

      runtime.worker.postMessage({
        type: "intercept_abort",
        requestId: "abort-target",
        registrationId: registration.registrationId,
        reason: "targeted timeout",
      });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-abort:1",
      );
      const otherResult = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "intercept_result" && message.requestId === "abort-other",
      );
      expect(otherResult.registrationId).toBe(registration.registrationId);
      expect(otherResult.messages).toEqual([{ role: "user", content: "hello:2" }]);
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "callback-end:1",
      );
      expect(runtime.messages.some(
        (message) => message.type === "intercept_result" && message.requestId === "abort-target",
      )).toBe(false);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });
});

describe("Worker image generation stream projection", () => {
  test("strips AbortSignal, preserves event order, and emits only the first terminal done", async () => {
    const runtime = await startRuntime(
      `
        (async () => {
          const events = [];
          for await (const event of spindle.imageGen.generateStream({
            prompt: "stream test",
            signal: new AbortController().signal,
          })) {
            events.push(event);
          }
          spindle.log.info("image-events:" + JSON.stringify(events));
        })();
      `,
      ["image_gen"],
    );
    try {
      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_generate_stream",
      );
      expect(
        request.input
          && typeof request.input === "object"
          && "signal" in request.input
          ? request.input.signal
          : undefined,
      ).toBeUndefined();
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: { type: "status", step: 1, totalSteps: 3 },
      });
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: { type: "preview", imageDataUrl: "data:image/png;base64,cHJldmlldw==" },
      });
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: { type: "status", nodeId: "decode" },
      });
      const terminal = {
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
          },
        },
      };
      runtime.worker.postMessage(terminal);
      runtime.worker.postMessage(terminal);

      const result = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("image-events:") === true,
      );
      expect(JSON.parse(result.message!.slice("image-events:".length))).toEqual([
        { type: "status", step: 1, totalSteps: 3 },
        { type: "preview", imageDataUrl: "data:image/png;base64,cHJldmlldw==" },
        { type: "status", nodeId: "decode" },
        {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
          },
        },
      ]);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

  test("converts host aborts and cancels upstream exactly once", async () => {
    const runtime = await startRuntime(
      `
        const controller = new AbortController();
        spindle.on("IMAGE_STREAM_TEST_ABORT", () => controller.abort("test abort"));
        (async () => {
          try {
            for await (const _event of spindle.imageGen.generateStream({
              prompt: "abort test",
              signal: controller.signal,
            })) {
              // Host controls the stream in this test.
            }
          } catch (error) {
            spindle.log.info("image-abort:" + error.name);
          }
        })();
      `,
      ["image_gen"],
    );
    try {
      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_generate_stream",
      );
      runtime.worker.postMessage({
        type: "event",
        event: "IMAGE_STREAM_TEST_ABORT",
        payload: {},
      });
      const cancel = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_cancel_stream" && message.requestId === request.requestId,
      );
      expect(cancel.requestId).toBe(request.requestId);
      runtime.worker.postMessage({
        type: "image_gen_stream_error",
        requestId: request.requestId,
        error: "AbortError: Image generation aborted",
      });
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "image-abort:AbortError",
      );
      expect(runtime.messages.some(
        (message) => message.type === "image_gen_cancel_stream" && message.requestId === request.requestId,
      )).toBe(false);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

  test("cancels the host stream when the consumer breaks before done", async () => {
    const runtime = await startRuntime(
      `
        (async () => {
          for await (const _event of spindle.imageGen.generateStream({ prompt: "break test" })) {
            break;
          }
          spindle.log.info("image-break:done");
        })();
      `,
      ["image_gen"],
    );
    try {
      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_generate_stream",
      );
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: { type: "status", step: 1 },
      });
      const cancel = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_cancel_stream" && message.requestId === request.requestId,
      );
      expect(cancel.requestId).toBe(request.requestId);
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "image-break:done",
      );
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });
  test("queues concurrent next calls FIFO and cleans routing after pending terminal delivery", async () => {
    const runtime = await startRuntime(
      `
        (async () => {
          const stream = spindle.imageGen.generateStream({ prompt: "fifo test" });
          const first = stream.next();
          const second = stream.next();
          const values = await Promise.all([first, second]);
          const end = await stream.next();
          spindle.log.info("image-fifo:" + JSON.stringify({ values, end }));
        })();
      `,
      ["image_gen"],
    );
    try {
      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_generate_stream",
      );
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: { type: "status", step: 1 },
      });
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
          },
        },
      });
      const result = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("image-fifo:") === true,
      );
      expect(JSON.parse(result.message!.slice("image-fifo:".length))).toEqual({
        values: [
          { done: false, value: { type: "status", step: 1 } },
          {
            done: false,
            value: {
              type: "done",
              result: {
                imageDataUrl: "data:image/png;base64,ZmluYWw=",
                model: "test-model",
                provider: "comfyui",
              },
            },
          },
        ],
        end: { done: true },
      });
      expect(runtime.messages.some(
        (message) => message.type === "image_gen_cancel_stream" && message.requestId === request.requestId,
      )).toBe(false);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

  test("cleans routing immediately for a queued terminal event", async () => {
    const runtime = await startRuntime(
      `
        (async () => {
          const stream = spindle.imageGen.generateStream({ prompt: "queued done" });
          const release = new Promise<void>((resolve) => {
            spindle.on("IMAGE_QUEUED_RELEASE", () => resolve());
          });
          spindle.log.info("image-queued-ready");
          await release;
          const event = await stream.next();
          spindle.log.info("image-queued:" + JSON.stringify(event));
        })();
      `,
      ["image_gen"],
    );
    try {
      const request = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "image_gen_generate_stream",
      );
      await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message === "image-queued-ready",
      );
      runtime.worker.postMessage({
        type: "image_gen_stream_chunk",
        requestId: request.requestId,
        event: {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
          },
        },
      });
      runtime.worker.postMessage({
        type: "event",
        event: "IMAGE_QUEUED_RELEASE",
        payload: {},
      });
      const result = await waitForMessage(
        runtime.messages,
        runtime.waiters,
        (message) => message.type === "log" && message.message?.startsWith("image-queued:") === true,
      );
      expect(JSON.parse(result.message!.slice("image-queued:".length))).toEqual({
        done: false,
        value: {
          type: "done",
          result: {
            imageDataUrl: "data:image/png;base64,ZmluYWw=",
            model: "test-model",
            provider: "comfyui",
          },
        },
      });
      expect(runtime.messages.some(
        (message) => message.type === "image_gen_cancel_stream" && message.requestId === request.requestId,
      )).toBe(false);
    } finally {
      await stopRuntime(runtime);
    }
  }, { timeout: 30_000 });

});

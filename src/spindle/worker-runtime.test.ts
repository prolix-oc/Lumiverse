import { describe, expect, test } from "bun:test";

type RuntimeMessage = {
  type?: string;
  requestId?: string;
  message?: string;
  definition?: { registrationId?: string; handler?: unknown; name?: string };
  name?: string;
  error?: string;
  result?: string;
};

type Waiter = {
  predicate: (message: RuntimeMessage) => boolean;
  resolve: (message: RuntimeMessage) => void;
  reject: (reason: unknown) => void;
};

const MESSAGE_WAIT_TIMEOUT_MS = 20_000;

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
  let rejectWithTimeout: Waiter["reject"];
  const timeout = setTimeout(() => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolveWithTimeout);
    if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
    reject(new Error("Timed out waiting for worker message"));
  }, MESSAGE_WAIT_TIMEOUT_MS);
  resolveWithTimeout = (message: RuntimeMessage): void => {
    clearTimeout(timeout);
    resolve(message);
  };
  rejectWithTimeout = (reason: unknown): void => {
    clearTimeout(timeout);
    reject(reason);
  };
  waiters.push({
    predicate,
    resolve: resolveWithTimeout,
    reject: rejectWithTimeout,
  });
  return promise;
}

async function startRuntime(
  entrySource: string,
  requestedCapabilities: readonly string[] = [],
): Promise<{
  worker: Worker;
  messages: RuntimeMessage[];
  waiters: Waiter[];
}> {
  const worker = new Worker(new URL("./worker-runtime.ts", import.meta.url), { type: "module" });
  const messages: RuntimeMessage[] = [];
  const waiters: Waiter[] = [];
  worker.onmessage = (event) => {
    const message = event.data as RuntimeMessage;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex !== -1) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  };
  worker.onerror = (event) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(event.message || "Worker failed"));
    }
  };
  const entry = `data:text/javascript,${encodeURIComponent(entrySource)}`;
  worker.postMessage({
    type: "init",
    manifest: {
      identifier: "macro-race-test",
      name: "Macro race test",
      version: "1.0.0",
      entry_backend: entry,
      requested_capabilities: requestedCapabilities,
    },
    storagePath: "/tmp/macro-race-test",
  });
  try {
    const permissionRequest = await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "permissions_get_granted",
    );
    worker.postMessage({ type: "response", requestId: permissionRequest.requestId, result: [] });
    await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "log" && message.message === "__worker_ready__",
    );
    return { worker, messages, waiters };
  } catch (error) {
    worker.terminate();
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
    throw error;

  }
}

describe("worker sandbox dynamic-code capability", () => {
  test("keeps constructors blocked by default and for unrelated capabilities", async () => {
    for (const capabilities of [[], ["base64_decode"]]) {
      const { worker, messages } = await startRuntime(`
        const value = new Function("return 7")();
        spindle.registerMacro({ name: "dynamic", handler: "return '" + value + "';" });
      `, capabilities);
      try {
        expect(
          messages.some(
            (message) =>
              message.type === "log" &&
              message.message?.includes("Failed to load extension") === true &&
              message.message?.includes("Function constructor is disabled in extension context") === true,
          ),
        ).toBe(true);
      } finally {
        worker.terminate();
      }
    }
  }, { timeout: 30_000 });

  test("enables dynamic constructors only for the declared dynamic-code capability", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      const value = new Function("return 7")();
      spindle.registerMacro({ name: "dynamic", handler: "return '" + value + "';" });
    `, ["dynamic_code_execution"]);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "dynamic",
      );
      expect(registration.definition?.handler).toBe("return '7';");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
});

describe("worker macro registration races", () => {
  test("unregistering a pending alias cancels its late acknowledgement", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "weather", aliases: ["forecast"], handler: "return 'stale'" });
      queueMicrotask(() => spindle.unregisterMacro("forecast"));
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro",
      );
      const registrationId = registration.definition?.registrationId;
      expect(typeof registrationId).toBe("string");
      expect(registration.definition?.handler).toBe("return 'stale'");
      const unregister = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "unregister_macro",
      );
      expect(unregister.name).toBe("weather");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "late-alias", name: "forecast", context: {} },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "macro_result",
      );
      expect(result.result).toBe("");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
  test("unregistering a shared pending alias notifies the host for every primary", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "alpha", aliases: ["shared"], handler: () => "a" });
      spindle.registerMacro({ name: "beta", aliases: ["shared"], handler: () => "b" });
      queueMicrotask(() => spindle.unregisterMacro("shared"));
    `);
    try {
      await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const unregisters = [
        await waitForMessage(messages, waiters, (message) => message.type === "unregister_macro"),
        await waitForMessage(messages, waiters, (message) => message.type === "unregister_macro"),
      ];
      expect(unregisters.map((message) => message.name)).toEqual(["alpha", "beta"]);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("unregistering a pending primary also cancels it when an active alias wins lookup", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "weather", aliases: ["forecast"], handler: () => "weather" });
      spindle.on("TEST_UNREGISTER", () => spindle.unregisterMacro("forecast"));
      queueMicrotask(() => spindle.registerMacro({ name: "forecast", handler: () => "stale" }));
    `);
    try {
      const first = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const second = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const firstId = first.definition?.registrationId;
      const secondId = second.definition?.registrationId;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: firstId, accepted: true },
      });
      worker.postMessage({ type: "event", event: "TEST_UNREGISTER", payload: {} });
      const unregisters = [
        await waitForMessage(messages, waiters, (message) => message.type === "unregister_macro"),
        await waitForMessage(messages, waiters, (message) => message.type === "unregister_macro"),
      ];
      expect(unregisters.map((message) => message.name)).toEqual(["forecast", "weather"]);
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: secondId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "cancelled-primary", name: "forecast", context: {} },
      });
      const result = await waitForMessage(messages, waiters, (message) => message.type === "macro_result");
      expect(result.result).toBe("");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("accepting a newer primary clears aliases from its previous token", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "weather", aliases: ["forecast"], handler: () => "old" });
      queueMicrotask(() => spindle.registerMacro({ name: "weather", aliases: ["climate"], handler: () => "new" }));
    `);
    try {
      const first = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const second = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const firstId = first.definition?.registrationId;
      const secondId = second.definition?.registrationId;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: firstId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: secondId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "old-alias", name: "forecast", context: {} },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "new-alias", name: "climate", context: {} },
      });
      const results: RuntimeMessage[] = [];
      results.push(await waitForMessage(messages, waiters, (message) => message.type === "macro_result"));
      results.push(await waitForMessage(messages, waiters, (message) => message.type === "macro_result"));
      expect(results.find((message) => message.requestId === "old-alias")?.result).toBe("");
      expect(results.find((message) => message.requestId === "new-alias")?.result).toBe("new");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("restores the latest accepted handler after an out-of-order rejection", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "weather", handler: "return 'v1'" });
      queueMicrotask(() => spindle.registerMacro({ name: "weather", handler: "return 'v2'" }));
    `);
    try {
      const first = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const second = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const firstId = first.definition?.registrationId;
      const secondId = second.definition?.registrationId;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: secondId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "before-v1", name: "weather", context: {} },
      });
      const before = await waitForMessage(messages, waiters, (message) => message.type === "macro_result");
      expect(before.result).toBe("");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: firstId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "after-v1", name: "weather", context: {} },
      });
      const after = await waitForMessage(messages, waiters, (message) => message.type === "macro_result");
      expect(after.result).toBe("v1");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("moves from an older accepted token to the next accepted token after a newer rejection", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "weather", handler: () => "v1" });
      queueMicrotask(() => {
        spindle.registerMacro({ name: "weather", handler: () => "v2" });
        queueMicrotask(() => spindle.registerMacro({ name: "weather", handler: () => "v3" }));
      });
    `);
    try {
      const first = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const second = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const third = await waitForMessage(messages, waiters, (message) => message.type === "register_macro");
      const firstId = first.definition?.registrationId;
      const secondId = second.definition?.registrationId;
      const thirdId = third.definition?.registrationId;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      expect(typeof thirdId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: firstId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: thirdId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "before-v2", name: "weather", context: {} },
      });
      const before = await waitForMessage(messages, waiters, (message) => message.type === "macro_result");
      expect(before.result).toBe("v1");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: secondId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "after-v2", name: "weather", context: {} },
      });
      const after = await waitForMessage(messages, waiters, (message) => message.type === "macro_result");
      expect(after.result).toBe("v2");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("serializes string bodies, empty sentinels, and executes async bodies", async () => {
    const stringBody =
      "await Promise.resolve(); return 'string:' + ctx.args.value + ':' + ctx.commit;";
    const { worker, messages, waiters } = await startRuntime(`
      Reflect.construct = () => {
        throw new Error("extension replaced Reflect.construct");
      };
      spindle.registerMacro({
        name: "string-macro",
        handler: ${JSON.stringify(stringBody)},
      });
      spindle.registerMacro({
        name: "function-macro",
        handler: (ctx) => "function:" + ctx.args.value,
      });
      spindle.registerMacro({
        name: "empty-macro",
        handler: "   ",
      });
    `);
    try {
      const stringRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "string-macro",
      );
      const functionRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "function-macro",
      );
      const emptyRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "empty-macro",
      );
      expect(stringRegistration.definition?.handler).toBe(stringBody);
      expect(functionRegistration.definition?.handler).toBe("");
      expect(emptyRegistration.definition?.handler).toBe("");
      const registrations = [stringRegistration, functionRegistration, emptyRegistration];
      for (const registration of registrations) {
        const registrationId = registration.definition?.registrationId;
        expect(typeof registrationId).toBe("string");
        worker.postMessage({
          type: "event",
          event: "__macro_registration_result__",
          payload: { registrationId, accepted: true },
        });
      }

      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "string-result",
          name: "string-macro",
          context: { args: { value: "ok" }, commit: false },
        },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "function-result",
          name: "function-macro",
          context: { args: { value: "ok" }, commit: true },
        },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "empty-result",
          name: "empty-macro",
          context: {},
        },
      });
      const results = [
        await waitForMessage(messages, waiters, (message) => message.requestId === "string-result"),
        await waitForMessage(messages, waiters, (message) => message.requestId === "function-result"),
        await waitForMessage(messages, waiters, (message) => message.requestId === "empty-result"),
      ];
      expect(results.find((message) => message.requestId === "string-result")?.result).toBe("string:ok:false");
      expect(results.find((message) => message.requestId === "function-result")?.result).toBe("function:ok");
      expect(results.find((message) => message.requestId === "empty-result")?.result).toBe("");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("accepts a 65,536-character body and rejects 65,537 locally", async () => {
    const acceptedBody = " ".repeat(65_535) + ";";
    const rejectedBody = " ".repeat(65_536) + ";";
    const rejectedWhitespaceBody = " ".repeat(65_537);
    expect(acceptedBody.length).toBe(65_536);
    expect(rejectedBody.length).toBe(65_537);
    expect(rejectedWhitespaceBody.length).toBe(65_537);
    const { worker, messages, waiters } = await startRuntime(`
      const accepted = " ".repeat(65_535) + ";";
      const rejected = " ".repeat(65_536) + ";";
      const rejectedWhitespace = " ".repeat(65_537);
      spindle.registerMacro({ name: "max-body", handler: accepted });
      spindle.registerMacro({ name: "over-limit-body", handler: rejected });
      spindle.registerMacro({ name: "over-limit-whitespace", handler: rejectedWhitespace });
    `);
    try {
      const accepted = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "max-body",
      );
      expect(accepted.definition?.handler).toBe(acceptedBody);
      await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "log" &&
          message.message?.includes('Macro "over-limit-body" was not registered:') === true,
      );
      await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "log" &&
          message.message?.includes('Macro "over-limit-whitespace" was not registered:') === true,
      );
      expect(
        messages.some(
          (message) =>
            message.type === "register_macro" &&
            message.definition?.name === "over-limit-whitespace",
        ),
      ).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "register_macro" &&
            message.definition?.name === "over-limit-body",
        ),
      ).toBe(false);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("keeps a serialized candidate inactive until host acceptance", async () => {
    const body = "return 'accepted';";
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "pending", handler: ${JSON.stringify(body)} });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "pending",
      );
      expect(registration.definition?.handler).toBe(body);
      const registrationId = registration.definition?.registrationId;
      expect(typeof registrationId).toBe("string");

      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "before-acceptance", name: "pending", context: {} },
      });
      const before = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "before-acceptance",
      );
      expect(before.result).toBe("");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "after-acceptance", name: "pending", context: {} },
      });
      const after = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "after-acceptance",
      );
      expect(after.result).toBe("accepted");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("ignores duplicate and late acknowledgements without resurrecting handlers", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "reject-first", handler: "return 'rejected'" });
      spindle.registerMacro({ name: "accept-first", handler: "return 'accepted'" });
    `);
    try {
      const rejectFirst = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "reject-first",
      );
      const acceptFirst = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "accept-first",
      );
      const rejectedId = rejectFirst.definition?.registrationId;
      const acceptedId = acceptFirst.definition?.registrationId;
      expect(typeof rejectedId).toBe("string");
      expect(typeof acceptedId).toBe("string");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: rejectedId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: acceptedId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: rejectedId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: acceptedId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "initial-rejected", name: "reject-first", context: {} },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "initial-accepted", name: "accept-first", context: {} },
      });
      const initial = [
        await waitForMessage(messages, waiters, (message) => message.requestId === "initial-rejected"),
        await waitForMessage(messages, waiters, (message) => message.requestId === "initial-accepted"),
      ];
      expect(initial.find((message) => message.requestId === "initial-rejected")?.result).toBe("");
      expect(initial.find((message) => message.requestId === "initial-accepted")?.result).toBe("accepted");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: rejectedId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: acceptedId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: rejectedId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: acceptedId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "late-rejected", name: "reject-first", context: {} },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "late-accepted", name: "accept-first", context: {} },
      });
      const late = [
        await waitForMessage(messages, waiters, (message) => message.requestId === "late-rejected"),
        await waitForMessage(messages, waiters, (message) => message.requestId === "late-accepted"),
      ];
      expect(late.find((message) => message.requestId === "late-rejected")?.result).toBe("");
      expect(late.find((message) => message.requestId === "late-accepted")?.result).toBe("accepted");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("rejects malformed values but forwards scanner candidates to the host", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "malformed", handler: "return (" });
      spindle.registerMacro({ name: "blocked-import", handler: "return import('node:fs')" });
      spindle.registerMacro({ name: "number-handler", handler: 42 });
      spindle.registerMacro({ name: "object-handler", handler: {} });
      spindle.registerMacro({ name: "missing-handler" });
    `);
    try {
      const blockedImport = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "blocked-import",
      );
      expect(blockedImport.definition?.handler).toBe("return import('node:fs')");
      for (const name of ["malformed", "number-handler", "object-handler", "missing-handler"]) {
        const log = await waitForMessage(
          messages,
          waiters,
          (message) => message.type === "log" && message.message?.includes(`Macro "${name}" was not registered:`) === true,
        );
        expect(log.message).toContain(`Macro "${name}" was not registered:`);
      }
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
  test("does not invoke a module-loader escape candidate after host rejection", async () => {
    const body = `
      const { createRequire } = await import("node:module");
      const alias = createRequire("/tmp/extension.js");
      const fs = alias("node:fs");
      return fs.readFileSync("/etc/passwd", "utf8");
    `;
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "rejected-module-escape", handler: ${JSON.stringify(body)} });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "rejected-module-escape",
      );
      expect(registration.definition?.handler).toBe(body);
      const registrationId = registration.definition?.registrationId;
      expect(typeof registrationId).toBe("string");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: false },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "rejected-module-escape-invocation",
          name: "rejected-module-escape",
          context: {},
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "rejected-module-escape-invocation",
      );
      expect(result.result).toBe("");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });


  test("propagates thrown and rejected macro handler failures", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "throws", handler: "throw new Error('thrown-body')" });
      spindle.registerMacro({
        name: "rejects",
        handler: () => Promise.reject(new Error("rejected-function")),
      });
    `);
    try {
      const throwsRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "throws",
      );
      const rejectsRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "rejects",
      );
      for (const registration of [throwsRegistration, rejectsRegistration]) {
        worker.postMessage({
          type: "event",
          event: "__macro_registration_result__",
          payload: { registrationId: registration.definition?.registrationId, accepted: true },
        });
      }
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "thrown-result", name: "throws", context: {} },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "rejected-result", name: "rejects", context: {} },
      });
      const thrownResult = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "thrown-result",
      );
      const rejectedResult = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "rejected-result",
      );
      expect(thrownResult.error).toBe("thrown-body");
      expect(rejectedResult.error).toBe("rejected-function");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

});
describe("worker serialized macro sandbox bindings", () => {
  test("masks every blocked formal after host acceptance while preserving safe globals and ctx", async () => {
    const blockedNames = [
      "require",
      "module",
      "createRequire",
      "globalThis",
      "self",
      "global",
      "process",
      "Bun",
      "Deno",
      "Function",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "Worker",
      "SharedWorker",
      "BroadcastChannel",
    ] as const;
    const body = `
      return [
        typeof require,
        typeof module,
        typeof createRequire,
        typeof globalThis,
        typeof self,
        typeof global,
        typeof process,
        typeof Bun,
        typeof Deno,
        typeof Function,
        typeof fetch,
        typeof XMLHttpRequest,
        typeof WebSocket,
        typeof Worker,
        typeof SharedWorker,
        typeof BroadcastChannel,
        ctx.args.value,
        Date.UTC(2024, 0, 2),
        Math.max(4, 9),
        JSON.parse('{"ok":true}').ok,
      ].join("|");
    `;
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({
        name: "sandbox-bindings",
        handler: ${JSON.stringify(body)},
      });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "sandbox-bindings",
      );
      const registrationId = registration.definition?.registrationId;
      expect(typeof registrationId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "sandbox-bindings-result",
          name: "sandbox-bindings",
          context: { args: { value: "ctx-survives" } },
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "sandbox-bindings-result",
      );
      expect(result.error).toBeUndefined();
      const values = (result.result ?? "").split("|");
      expect(values.slice(0, blockedNames.length)).toEqual(
        blockedNames.map(() => "undefined"),
      );
      expect(values[blockedNames.length]).toBe("ctx-survives");
      expect(values[blockedNames.length + 1]).toBe(String(Date.UTC(2024, 0, 2)));
      expect(values[blockedNames.length + 2]).toBe("9");
      expect(values[blockedNames.length + 3]).toBe("true");
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("allows handler-local declarations to shadow every blocked formal", async () => {
    const body = `
      const require="r",module="m",createRequire="c",globalThis="gt",self="s",global="g",process="p",Bun="b",Deno="d",Function="f",fetch="fe",XMLHttpRequest="x",WebSocket="w",Worker="wo",SharedWorker="sw",BroadcastChannel="bc";
      return [require,module,createRequire,globalThis,self,global,process,Bun,Deno,Function,fetch,XMLHttpRequest,WebSocket,Worker,SharedWorker,BroadcastChannel].join("|");
    `;
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({
        name: "shadowed-bindings",
        handler: ${JSON.stringify(body)},
      });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "shadowed-bindings",
      );
      const registrationId = registration.definition?.registrationId;
      expect(typeof registrationId).toBe("string");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "shadowed-bindings-result",
          name: "shadowed-bindings",
          context: {},
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "shadowed-bindings-result",
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toBe(
        ["r", "m", "c", "gt", "s", "g", "p", "b", "d", "f", "fe", "x", "w", "wo", "sw", "bc"].join("|"),
      );
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  requestedCapabilities: unknown = [],
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

async function startChildRuntime(
  entrySource: string,
  requestedCapabilities: unknown = [],
) {
  const messages: RuntimeMessage[] = [];
  const waiters: Waiter[] = [];
  const entryDirectory = mkdtempSync(join(tmpdir(), "lumiverse-worker-runtime-"));
  const entry = join(entryDirectory, "entry.mjs");
  writeFileSync(entry, entrySource);
  const cleanupEntry = (): void => {
    rmSync(entryDirectory, { recursive: true, force: true });
  };
  let subprocess = null as ReturnType<typeof Bun.spawn> | null;
  try {
    subprocess = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `import(${JSON.stringify(new URL("./worker-runtime.ts", import.meta.url).href)});`,
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      serialization: "advanced",
      ipc(message) {
        const runtimeMessage = message as RuntimeMessage;
        const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(runtimeMessage));
        if (waiterIndex !== -1) {
          const waiter = waiters.splice(waiterIndex, 1)[0];
          waiter.resolve(runtimeMessage);
        } else {
          messages.push(runtimeMessage);
        }
      },
    });
    subprocess.send({
      type: "init",
      manifest: {
        identifier: "child-process-facade-test",
        name: "Child process facade test",
        version: "1.0.0",
        entry_backend: entry,
        requested_capabilities: requestedCapabilities,
      },
      storagePath: "/tmp/child-process-facade-test",
    });
    const permissionRequest = await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "permissions_get_granted",
    );
    subprocess.send({ type: "response", requestId: permissionRequest.requestId, result: [] });
    await waitForMessage(
      messages,
      waiters,
      (message) => message.type === "log" && message.message === "__worker_ready__",
    );
    return { subprocess, messages, waiters, cleanupEntry };
  } catch (error) {
    if (subprocess) {
      try {
        subprocess.kill();
      } catch {
        // The child may have exited while the startup waiter was pending.
      }
      await subprocess.exited;
    }
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
    cleanupEntry();
    throw error;
  }
}

describe("worker sandbox dynamic-code capability", () => {
  test("keeps constructors blocked by default and for unrelated capabilities", async () => {
    for (const capabilities of [[], ["base64_decode"]]) {
      const { worker, messages, waiters } = await startRuntime(`
        const value = new Function("return 7")();
        spindle.registerMacro({ name: "dynamic", handler: "return '" + value + "';" });
      `, capabilities);
      try {
        const failure = await waitForMessage(
          messages,
          waiters,
          (message) =>
            message.type === "log" &&
            message.message?.includes("Failed to load extension") === true,
        );
        expect(failure.message).toContain("Failed to load extension");
        expect(
          messages.some(
            (message) => message.type === "register_macro" && message.definition?.name === "dynamic",
          ),
        ).toBe(false);
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
  test("does not grant dynamic code or crash for malformed capability declarations", async () => {
    for (const capabilities of [
      "dynamic_code_execution",
      { includes: "dynamic_code_execution" },
    ]) {
      const { worker, messages } = await startRuntime(`
        const value = new Function("return 7")();
        spindle.registerMacro({ name: "malformed-capability", handler: "return '" + value + "';" });
      `, capabilities);
      try {
        expect(
          messages.some(
            (message) =>
              message.type === "log" &&
              message.message?.includes("Failed to load extension") === true,
          ),
        ).toBe(true);
        expect(
          messages.some(
            (message) =>
              message.type === "register_macro" &&
              message.definition?.name === "malformed-capability",
          ),
        ).toBe(false);
      } finally {
        worker.terminate();
      }
    }
  }, { timeout: 30_000 });
});

describe("worker extension entry imports", () => {
  test("does not retry a NameTooLong error thrown after an extension side effect", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({ name: "name-too-long-side-effect", handler: "return 'once';" });
      throw new Error("NameTooLong deliberate extension failure");
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "name-too-long-side-effect",
      );
      expect(registration.definition?.name).toBe("name-too-long-side-effect");
      await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "log" &&
          message.message?.includes("NameTooLong deliberate extension failure") === true,
      );
      expect(
        messages.filter(
          (message) =>
            message.type === "register_macro" &&
            message.definition?.name === "name-too-long-side-effect",
        ),
      ).toHaveLength(0);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("loads a long data entry once", async () => {
    const source = [
      `spindle.registerMacro({ name: "long-data-entry", handler: "return 'loaded';" });`,
      `/*${"x".repeat(2_000)}*/`,
    ].join("\n");
    const { worker, messages, waiters } = await startRuntime(source);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "long-data-entry",
      );
      expect(registration.definition?.name).toBe("long-data-entry");
      expect(
        messages.filter(
          (message) =>
            message.type === "register_macro" &&
            message.definition?.name === "long-data-entry",
        ),
      ).toHaveLength(0);
      expect(
        messages.some(
          (message) =>
            message.type === "log" &&
            message.message?.startsWith("Failed to load extension") === true,
        ),
      ).toBe(false);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
});


describe("worker transport lifecycle", () => {
  test("does not start an unconsumed generation stream", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      spindle.generate.rawStream({ messages: [] });
    `);
    try {
      worker.postMessage({ type: "shutdown" });
      await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "log" && message.message === "__worker_shutdown_ack__",
      );
      expect(messages.some((message) => message.type === "request_generation_stream")).toBe(false);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("rejects every request when structured-clone transport setup throws", async () => {
    const names = [
      "request-transport",
      "generation-transport",
      "assembly-transport",
      "stream-transport",
    ];
    const { worker, messages, waiters } = await startRuntime(`
      const report = (name) => () => spindle.registerMacro({
        name,
        handler: "return " + JSON.stringify(name) + ";",
      });
      const uncloneable = () => {};
      spindle.storage.write("bad", uncloneable).catch(report("request-transport"));
      spindle.generate.raw({ input: uncloneable }).catch(report("generation-transport"));
      spindle.assemble({ blocks: uncloneable, chatId: "bad" }).catch(report("assembly-transport"));
      spindle.generate.rawStream({ input: uncloneable }).next().catch(report("stream-transport"));
    `);
    try {
      for (const name of names) {
        const registration = await waitForMessage(
          messages,
          waiters,
          (message) => message.type === "register_macro" && message.definition?.name === name,
        );
        expect(registration.definition?.handler).toBe(`return "${name}";`);
      }
      expect(messages.filter((message) => message.type === "cancel_generation").length).toBeGreaterThanOrEqual(3);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
  test("cleans tracked signals after synchronous request setup throws", async () => {
    const expectedNames = [
      "request-sync",
      "generation-sync-0",
      "assembly-sync-0",
      "stream-sync-0",
    ];
    const { worker, messages, waiters } = await startRuntime(`
      const t=()=>({aborted:false,listeners:0,addEventListener(){this.listeners++},removeEventListener(){this.listeners--}}),r=(p,s)=>()=>spindle.registerMacro({name:p+"-"+s.listeners,handler:""}),f=()=>{},q=()=>spindle.registerMacro({name:"request-sync",handler:""});
      spindle.storage.write("b",f).catch(q);
      const g=t();spindle.generate.raw({input:f,signal:g}).catch(r("generation-sync",g));
      const a=t();spindle.assemble({blocks:f,chatId:"b",signal:a}).catch(r("assembly-sync",a));
      const s=t();spindle.generate.rawStream({input:f,signal:s}).next().catch(r("stream-sync",s));
    `);
    try {
      for (const name of expectedNames) {
        const registration = await waitForMessage(
          messages,
          waiters,
          (message) => message.type === "register_macro" && message.definition?.name === name,
        );
        expect(registration.definition?.handler).toBe("");
      }
      expect(messages.filter((message) => message.type === "cancel_generation").length).toBe(3);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });

  test("cleans tracked signals when abandoned streams receive done or error", async () => {
    const { worker, messages, waiters } = await startRuntime(`
      const tracked = () => ({
        aborted: false,
        listeners: 0,
        addEventListener() { this.listeners += 1; },
        removeEventListener() { this.listeners -= 1; },
      });
      const doneSignal = tracked();
      const errorSignal = tracked();
      spindle.generate.rawStream({ messages: [], signal: doneSignal }).next()
        .then(() => spindle.registerMacro({ name: "stream-done-" + doneSignal.listeners, handler: "" }));
      spindle.generate.rawStream({ messages: [], signal: errorSignal }).next()
        .catch(() => spindle.registerMacro({ name: "stream-error-" + errorSignal.listeners, handler: "" }));
    `);
    try {
      const first = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "request_generation_stream",
      );
      const second = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "request_generation_stream",
      );
      worker.postMessage({
        type: "generation_stream_chunk",
        requestId: first.requestId,
        chunk: { type: "done" },
      });
      worker.postMessage({
        type: "generation_stream_error",
        requestId: second.requestId,
        error: "terminal stream failure",
      });
      for (const name of ["stream-done-0", "stream-error-0"]) {
        const registration = await waitForMessage(
          messages,
          waiters,
          (message) => message.type === "register_macro" && message.definition?.name === name,
        );
        expect(registration.definition?.handler).toBe("");
      }
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });


  test("rejects pending requests and removes signal listeners on shutdown", async () => {
    const names = ["shutdown-generation", "shutdown-assembly", "shutdown-stream"];
    const { worker, messages, waiters } = await startRuntime(`
      const signal = {
        aborted: false,
        listeners: 0,
        addEventListener() { this.listeners += 1; },
        removeEventListener() { this.listeners -= 1; },
      };
      const report = (name) => () => spindle.registerMacro({
        name,
        handler: "return " + JSON.stringify(String(signal.listeners)) + ";",
      });
      spindle.generate.raw({ messages: [], signal }).catch(report("shutdown-generation"));
      spindle.assemble({ blocks: [], chatId: "pending", signal }).catch(report("shutdown-assembly"));
      spindle.generate.rawStream({ messages: [], signal }).next().catch(report("shutdown-stream"));
    `);
    try {
      await waitForMessage(messages, waiters, (message) => message.type === "request_generation");
      await waitForMessage(messages, waiters, (message) => message.type === "assemble_prompt");
      await waitForMessage(messages, waiters, (message) => message.type === "request_generation_stream");
      worker.postMessage({ type: "shutdown" });
      await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "log" && message.message === "__worker_shutdown_ack__",
      );
      for (const name of names) {
        const registration = await waitForMessage(
          messages,
          waiters,
          (message) => message.type === "register_macro" && message.definition?.name === name,
        );
        expect(registration.definition?.handler).toBe(`return "0";`);
      }
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
  test("keeps direct host controls unavailable for accepted serialized handlers", async () => {
    const guardedBody = `const outcomes=[typeof postMessage,typeof close,typeof setTimeout,typeof setInterval,typeof setImmediate,typeof queueMicrotask],probe=(name,fn)=>{try{fn();outcomes.push(name+"-called")}catch{outcomes.push(name+"-blocked")}};probe("postMessage",()=>postMessage({type:"macro_raw_host_escape"}));probe("close",()=>close());probe("setTimeout",()=>setTimeout(function(){this.close()}));probe("setInterval",()=>setInterval(()=>{},1e6));probe("setImmediate",()=>setImmediate(()=>{}));probe("queueMicrotask",()=>queueMicrotask(()=>{}));probe("cache",()=>spindle.updateMacroValue("guarded","preview-poison"));return JSON.stringify({outcomes,value:ctx.args.value});`;
    const { worker, messages, waiters } = await startRuntime(`
      spindle.registerMacro({
        name: "guarded",
        handler: ${JSON.stringify(guardedBody)},
      });
      spindle.registerMacro({
        name: "ordinary",
        handler: ${JSON.stringify(`return "ordinary:" + ctx.args.value;`)},
      });
    `);
    try {
      const guardedRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "guarded",
      );
      const ordinaryRegistration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "ordinary",
      );
      expect(typeof guardedRegistration.definition?.registrationId).toBe("string");
      expect(typeof ordinaryRegistration.definition?.registrationId).toBe("string");

      for (const registration of [guardedRegistration, ordinaryRegistration]) {
        worker.postMessage({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: registration.definition?.registrationId,
            accepted: true,
          },
        });
      }

      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "guarded-preview",
          name: "guarded",
          context: { commit: false, args: { value: "preview-survives" } },
        },
      });
      const guardedResult = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "guarded-preview",
      );
      expect(guardedResult.error).toBeUndefined();
      expect(JSON.parse(guardedResult.result ?? "")).toEqual({
        outcomes: [
          "undefined",
          "undefined",
          "undefined",
          "undefined",
          "undefined",
          "undefined",
          "postMessage-blocked",
          "close-blocked",
          "setTimeout-blocked",
          "setInterval-blocked",
          "setImmediate-blocked",
          "queueMicrotask-blocked",
          "cache-blocked",
        ],
        value: "preview-survives",
      });

      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "ordinary-result",
          name: "ordinary",
          context: { args: { value: "ctx-survives" } },
        },
      });
      const ordinaryResult = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "ordinary-result",
      );
      expect(ordinaryResult.error).toBeUndefined();
      expect(ordinaryResult.result).toBe("ordinary:ctx-survives");

      expect(
        messages.filter(
          (message) =>
            message.type === "macro_raw_host_escape" ||
            message.type === "update_macro_value",
        ),
      ).toEqual([]);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
  test("isolates recovered worker controls while captured bridge transport stays responsive", async () => {
    const expectedBridgeResult =
      "onmessage:blocked|onmessageerror:blocked|onerror:blocked|listener:blocked|removeListener:blocked|postMessage:blocked|managed-process:blocked|dispatchEvent:blocked|close:blocked";
    const expectedBridgeState = { setup: expectedBridgeResult, listener: false };
    const { worker, messages, waiters } = await startRuntime(
      `
        const g=new Function("return globalThis")(),l=()=>{g.__forged_listener_called=true},o=[],p=(n,f)=>{try{f();o.push(n+":called")}catch{o.push(n+":blocked")}};p("onmessage",()=>g.onmessage=l);p("onmessageerror",()=>g.onmessageerror=l);p("onerror",()=>g.onerror=l);p("listener",()=>g.addEventListener("message",l));p("removeListener",()=>g.removeEventListener("message",l));p("postMessage",()=>g.postMessage({type:"register_macro"}));p("managed-process",()=>g.postMessage({type:"backend_process_spawn"}));p("dispatchEvent",()=>g.dispatchEvent(new Event("message")));p("close",()=>g.close());g.__forged_setup=o.join("|");spindle.registerMacro({name:"bridge-alive",handler:()=>JSON.stringify({setup:g.__forged_setup,listener:g.__forged_listener_called===true})});
      `,
      ["dynamic_code_execution"],
    );
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) => message.type === "register_macro" && message.definition?.name === "bridge-alive",
      );
      expect(registration.definition?.handler).toBe("");

      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: registration.definition?.registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "bridge-alive-result",
          name: "bridge-alive",
          context: {},
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "bridge-alive-result",
      );
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result ?? "")).toEqual(expectedBridgeState);
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "bridge-alive-barrier",
          name: "bridge-alive",
          context: {},
        },
      });
      const barrier = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "bridge-alive-barrier",
      );
      expect(barrier.error).toBeUndefined();
      expect(JSON.parse(barrier.result ?? "")).toEqual(expectedBridgeState);
      await Promise.resolve();

      expect(
        messages.some((message) => message.type === "register_macro"),
      ).toBe(false);
      expect(messages.some((message) => message.type === "backend_process_spawn")).toBe(false);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
  test("keeps ordinary EventTarget and AbortSignal usable while global controls reject", async () => {
    const expected = {
      ordinaryHits: 1,
      signalHits: 1,
      outcomes: [
        "direct-add:blocked",
        "direct-remove:blocked",
        "direct-dispatch:blocked",
        "prototype-add:blocked",
        "prototype-remove:blocked",
        "prototype-dispatch:blocked",
      ],
    };
    const { worker, messages, waiters } = await startRuntime(`
      const g=globalThis,o=new EventTarget(),c=new AbortController();let a=0,b=0,x=()=>a++,y=()=>b++;o.addEventListener("o",x);c.signal.addEventListener("abort",y);o.dispatchEvent(new Event("o"));o.removeEventListener("o",x);o.dispatchEvent(new Event("o"));c.abort();c.signal.removeEventListener("abort",y);const z=[],p=(n,f)=>{try{f();z.push(n+":called")}catch{z.push(n+":blocked")}},t=EventTarget.prototype;p("direct-add",()=>g.addEventListener("message",()=>{}));p("direct-remove",()=>g.removeEventListener("message",()=>{}));p("direct-dispatch",()=>g.dispatchEvent(new Event("message")));p("prototype-add",()=>t.addEventListener.call(g,"message",()=>{}));p("prototype-remove",()=>t.removeEventListener.call(g,"message",()=>{}));p("prototype-dispatch",()=>t.dispatchEvent.call(g,new Event("message")));spindle.registerMacro({name:"event-target-receiver",handler:()=>JSON.stringify({ordinaryHits:a,signalHits:b,outcomes:z})});
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "event-target-receiver",
      );
      expect(registration.definition?.handler).toBe("");
      worker.postMessage({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId: registration.definition?.registrationId, accepted: true },
      });
      worker.postMessage({
        type: "event",
        event: "__macro_invoke__",
        payload: { requestId: "event-target-receiver-result", name: "event-target-receiver", context: {} },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "event-target-receiver-result",
      );
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result ?? "")).toEqual(expected);
    } finally {
      worker.terminate();
    }
  }, { timeout: 30_000 });
});

describe("child process runtime transport", () => {
  test("blocks raw process IPC controls while preserving the host bridge", async () => {
    const expectedControls = [
      "send:blocked",
      "on:blocked",
      "addListener:blocked",
      "once:blocked",
      "prependListener:blocked",
      "prependOnceListener:blocked",
      "removeListener:blocked",
      "off:blocked",
      "removeAllListeners:blocked",
      "emit:blocked",
      "disconnect:blocked",
      "channel:blocked",
    ];
    const { subprocess, messages, waiters, cleanupEntry } = await startChildRuntime(`
      const outcomes = [];
      const probe = (name, action) => {
        try {
          action();
          outcomes.push(name + ":called");
        } catch {
          outcomes.push(name + ":blocked");
        }
      };
      const listener = () => {};
      probe("send", () => process.send({ type: "raw_process_escape" }));
      probe("on", () => process.on("message", listener));
      probe("addListener", () => process.addListener("message", listener));
      probe("once", () => process.once("message", listener));
      probe("prependListener", () => process.prependListener("message", listener));
      probe("prependOnceListener", () => process.prependOnceListener("message", listener));
      probe("removeListener", () => process.removeListener("message", listener));
      probe("off", () => process.off("message", listener));
      probe("removeAllListeners", () => process.removeAllListeners("message"));
      probe("emit", () => process.emit("message", { type: "raw_process_escape" }));
      probe("disconnect", () => process.disconnect());
      probe("channel", () => {
        const channel = process.channel;
        if (!channel || typeof channel.ref !== "function") throw new Error("channel unavailable");
        channel.ref();
      });
      spindle.registerMacro({
        name: "child-process-facade",
        handler: "return " + JSON.stringify(JSON.stringify(outcomes)) + ";",
      });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "child-process-facade",
      );
      expect(typeof registration.definition?.registrationId).toBe("string");
      expect(messages.some((message) => message.type === "raw_process_escape")).toBe(false);

      subprocess.send({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: registration.definition?.registrationId,
          accepted: true,
        },
      });
      subprocess.send({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "child-process-facade-result",
          name: "child-process-facade",
          context: {},
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "child-process-facade-result",
      );
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result ?? "")).toEqual(expectedControls);
      expect(messages.some((message) => message.type === "raw_process_escape")).toBe(false);
    } finally {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("Child runtime test cleanup"));
      }
      subprocess.kill();
      await subprocess.exited;
      cleanupEntry();
    }
  }, { timeout: 30_000 });
  test("blocks WorkerGlobalScope controls in a hybrid process transport", async () => {
    const expectedControls = [
      "postMessage:blocked",
      "close:blocked",
      "addEventListener:blocked",
      "removeEventListener:blocked",
      "dispatchEvent:blocked",
    ];
    const { subprocess, messages, waiters, cleanupEntry } = await startChildRuntime(`
      const workerGlobal = globalThis.self;
      const outcomes = [];
      const probe = (name, action) => {
        try {
          action();
          outcomes.push(name + ":called");
        } catch {
          outcomes.push(name + ":blocked");
        }
      };
      probe("postMessage", () => workerGlobal.postMessage({ type: "raw_worker_escape" }));
      probe("close", () => workerGlobal.close());
      probe("addEventListener", () => workerGlobal.addEventListener("message", () => {}));
      probe("removeEventListener", () => workerGlobal.removeEventListener("message", () => {}));
      probe("dispatchEvent", () => workerGlobal.dispatchEvent(new Event("message")));
      spindle.registerMacro({
        name: "hybrid-worker-controls",
        handler: "return " + JSON.stringify(JSON.stringify(outcomes)) + ";",
      });
    `);
    try {
      const registration = await waitForMessage(
        messages,
        waiters,
        (message) =>
          message.type === "register_macro" &&
          message.definition?.name === "hybrid-worker-controls",
      );
      expect(typeof registration.definition?.registrationId).toBe("string");
      expect(messages.some((message) => message.type === "raw_worker_escape")).toBe(false);

      subprocess.send({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: registration.definition?.registrationId,
          accepted: true,
        },
      });
      subprocess.send({
        type: "event",
        event: "__macro_invoke__",
        payload: {
          requestId: "hybrid-worker-controls-result",
          name: "hybrid-worker-controls",
          context: {},
        },
      });
      const result = await waitForMessage(
        messages,
        waiters,
        (message) => message.requestId === "hybrid-worker-controls-result",
      );
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result ?? "")).toEqual(expectedControls);
    } finally {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("Child runtime test cleanup"));
      }
      subprocess.kill();
      await subprocess.exited;
      cleanupEntry();
    }
  }, { timeout: 30_000 });
});

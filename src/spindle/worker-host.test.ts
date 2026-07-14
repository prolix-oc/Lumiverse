import { describe, expect, test } from "bun:test";
import { WorkerHost } from "./worker-host";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { registry as macroRegistry, type MacroOwner } from "../macros/MacroRegistry";

function invokeHandleMessageInScope(host: WorkerHost, message: unknown): void {
  const handleMessageInScope = (WorkerHost.prototype as unknown as {
    handleMessageInScope: (message: unknown) => void
  }).handleMessageInScope
  handleMessageInScope.call(host, message)
}

type MacroRegistrationHostStub = {
  runtime: unknown;
  runtimeStopping: boolean;
  extensionId: string;
  manifest: { identifier: string; requested_capabilities?: readonly string[] };
  macroOwner: MacroOwner;
  installScope: "operator";
  installedByUserId: null;
  registeredMacroNames: Set<string>;
  macroValueCache: Map<string, string>;
  postToWorker: (message: unknown) => void;
  pendingRequests: Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >;
  getScopedUserId: () => string | null;
  rejectMacroRegistration: (
    registrationId: string,
    _macroName: string,
    _reason: string,
  ) => void;
  clearMacroRegistrations: () => void;
  rejectPendingRequests: () => void;
};

type WorkerStopHostStub = {
  runtime: unknown;
  runtimeStopping: boolean;
  onWorkerShutdownAck: (() => void) | null;
};

type MacroStopHostStub = MacroRegistrationHostStub & {
  runtimeExitPromise: Promise<void> | null;
  onWorkerReady: ((error?: Error) => void) | null;
  onWorkerShutdownAck: (() => void) | null;
  onRuntimeExit: (() => void) | null;
  stopRuntimeStatsSampling: () => void;
  stopAllFrontendProcesses: (...args: unknown[]) => void;
  stopAllBackendProcesses: (...args: unknown[]) => void;
  emitRuntimeStats: (...args: unknown[]) => Promise<void>;
  cleanup: () => void;
};

type WorkerHostCleanupMethods = {
  clearMacroRegistrations: () => void;
};

const workerHostCleanupMethods =
  WorkerHost.prototype as unknown as WorkerHostCleanupMethods;
type WorkerHostStopMethods = WorkerHostCleanupMethods & {
  rejectPendingRequests: () => void;
};

const workerHostStopMethods =
  WorkerHost.prototype as unknown as WorkerHostStopMethods;

type WorkerHostMacroMethods = {
  handleRegisterMacro: (definition: unknown) => void;
};

const workerHostMacroMethods =
  WorkerHost.prototype as unknown as WorkerHostMacroMethods;

function invokeHandleRegisterMacro(host: WorkerHost, definition: unknown): void {
  workerHostMacroMethods.handleRegisterMacro.call(host, definition);
}
type WorkerHostMacroValueMethods = {
  handleUpdateMacroValue: (name: string, value: string) => void;
};

const workerHostMacroValueMethods =
  WorkerHost.prototype as unknown as WorkerHostMacroValueMethods;

function invokeHandleUpdateMacroValue(
  host: WorkerHost,
  name: string,
  value: string,
): void {
  workerHostMacroValueMethods.handleUpdateMacroValue.call(host, name, value);
}
type WorkerHostRequestMethods = {
  resolveRequest: (requestId: string, value: unknown) => void;
};

const workerHostRequestMethods =
  WorkerHost.prototype as unknown as WorkerHostRequestMethods;

function invokeResolveRequest(
  host: WorkerHost,
  requestId: string,
  value: unknown,
): void {
  workerHostRequestMethods.resolveRequest.call(host, requestId, value);
}

function createMacroRegistrationHost(
  capabilities: readonly string[] = [],
): { host: WorkerHost; owner: MacroOwner; messages: unknown[]; rejectionReasons: string[] } {
  const owner: MacroOwner = {
    extensionId: `macro-handshake-${crypto.randomUUID()}`,
    generation: "test-generation",
  };
  const messages: unknown[] = [];
  const rejectionReasons: string[] = [];
  macroRegistry.activateExtensionGeneration(owner);
  const stub: MacroRegistrationHostStub = {
    runtime: {},
    runtimeStopping: false,
    pendingRequests: new Map(),
    extensionId: owner.extensionId,
    manifest: {
      identifier: owner.extensionId,
      requested_capabilities: capabilities,
    },
    macroOwner: owner,
    installScope: "operator",
    installedByUserId: null,
    registeredMacroNames: new Set<string>(),
    macroValueCache: new Map<string, string>(),
    postToWorker: (message) => messages.push(message),
    getScopedUserId: () => null,
    rejectMacroRegistration: (registrationId, _macroName, reason) => {
      if (!registrationId) return;
      rejectionReasons.push(reason);
      messages.push({
        type: "event",
        event: "__macro_registration_result__",
        payload: { registrationId, accepted: false },
      });
    },
    clearMacroRegistrations: () => {
      workerHostStopMethods.clearMacroRegistrations.call(stub as unknown as WorkerHost);
    },
    rejectPendingRequests: () => {
      workerHostStopMethods.rejectPendingRequests.call(stub as unknown as WorkerHost);
    },
  };
  return { host: stub as unknown as WorkerHost, owner, messages, rejectionReasons };
}
function macroRegistrationState(host: WorkerHost): MacroRegistrationHostStub {
  return host as unknown as MacroRegistrationHostStub;
}

function manyIgnoredSpanHandler(): string {
  const ignored = Array.from({ length: 4_096 }, (_, index) => `/*ignored-${index}*/`).join("");
  const handler = `${ignored}return globalThis.require("node:fs");`;
  if (new TextEncoder().encode(handler).byteLength > 65_536) {
    throw new Error("many-ignored-span fixture exceeded the serialized handler limit");
  }
  return handler;
}

describe("WorkerHost macro catalog bridge", () => {
  test("does not call trim on a malformed user id", () => {
    let emitted = false;
    const originalEmit = eventBus.emit;
    eventBus.emit = ((event: EventType, _payload: unknown, _userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true;
    }) as typeof eventBus.emit;
    try {
      const host = {
        runtime: {},
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        macroOwner: { extensionId: "extension-owner", generation: "g1" },
        installScope: "operator",
        installedByUserId: null,
      } as unknown as WorkerHost;
      WorkerHost.prototype.sendFrontendMessage.call(
        host,
        { type: "__loom_macro_catalog_request", requestId: "request-1" },
        null as unknown as string,
      );
      expect(emitted).toBe(false);
    } finally {
      eventBus.emit = originalEmit;
    }
  });

  test("drops frontend messages while the worker host is tearing down", () => {
    let emitted = false
    const originalEmit = eventBus.emit
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true
    }) as typeof eventBus.emit
    try {
      const host = {
        runtime: {},
        runtimeStopping: true,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        installScope: "operator",
      } as unknown as WorkerHost
      invokeHandleMessageInScope(host, {
        type: "frontend_message",
        payload: { stale: true },
      } as never)
      expect(emitted).toBe(false)
    } finally {
      eventBus.emit = originalEmit
    }
  })

  test("drops generic frontend messages with a blank operator recipient", () => {
    let emitted = false
    const originalEmit = eventBus.emit
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true
    }) as typeof eventBus.emit
    try {
      const host = {
        runtime: {},
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        installScope: "operator",
        installedByUserId: null,
      } as unknown as WorkerHost
      invokeHandleMessageInScope(host, {
        type: "frontend_message",
        payload: { shouldDrop: true },
        userId: "   ",
      } as never)
      expect(emitted).toBe(false)
    } finally {
      eventBus.emit = originalEmit
    }
  })

  test("drops generic frontend messages when a user-scoped owner is missing", () => {
    let emitted = false
    const originalEmit = eventBus.emit
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true
    }) as typeof eventBus.emit
    try {
      const host = {
        runtime: {},
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        installScope: "user",
        installedByUserId: null,
      } as unknown as WorkerHost
      invokeHandleMessageInScope(host, {
        type: "frontend_message",
        payload: { shouldDrop: true },
        userId: "attacker",
      } as never)
      expect(emitted).toBe(false)
    } finally {
      eventBus.emit = originalEmit
    }
  })

  test("drops catalog requests while the worker host is tearing down", () => {
    let emitted = false
    const originalEmit = eventBus.emit
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true
    }) as typeof eventBus.emit
    try {
      const host = {
        runtime: {},
        runtimeStopping: true,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        macroOwner: { extensionId: "extension-owner", generation: "g1" },
        installScope: "operator",
        installedByUserId: null,
      } as unknown as WorkerHost
      WorkerHost.prototype.sendFrontendMessage.call(
        host,
        { type: "__loom_macro_catalog_request", requestId: "request-stopping" },
        "user-1",
      )
      expect(emitted).toBe(false)
    } finally {
      eventBus.emit = originalEmit
    }
  })

  test("drops catalog when user-scoped owner is missing", () => {
    let emitted = false;
    const originalEmit = eventBus.emit;
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true;
    }) as typeof eventBus.emit;
    try {
      const host = {
        runtime: {},
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        macroOwner: { extensionId: "extension-owner", generation: "g1" },
        installScope: "user",
        installedByUserId: null,
      } as unknown as WorkerHost;
      WorkerHost.prototype.sendFrontendMessage.call(
        host,
        { type: "__loom_macro_catalog_request", requestId: "request-2" },
        "user-1",
      );
      expect(emitted).toBe(false);
    } finally {
      eventBus.emit = originalEmit;
    }
  });
});

describe("WorkerHost serialized macro handshake", () => {
  test("rejects unsafe bodies before exposing them to the macro registry", () => {
    const cases = [
      ["dynamic-import", "return import(ctx.args.module);"],
      ["dynamic-require", "return require(ctx.args.module);"],
      ["bun-file", "return Bun.file(ctx.args.path);"],
      ["process-env", "return process.env.SECRET;"],
    ] as const;

    for (const [label, handler] of cases) {
      const { host, owner, messages } = createMacroRegistrationHost();
      const name = `${label}-${owner.generation}`;
      try {
        invokeHandleRegisterMacro(host, {
          registrationId: `${name}-registration`,
          name,
          handler,
        });
        expect(messages).toContainEqual({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: `${name}-registration`,
            accepted: false,
          },
        });
        expect(macroRegistry.getMacro(name)).toBeNull();
      } finally {
        macroRegistry.unregisterOwner(owner);
        macroRegistry.deactivateExtensionGeneration(owner);
      }
    }
  });

  test("rejects module-loader acquisition forms and never exposes the escape macro", () => {
    const blockedBodies: Array<{ label: string; body: string }> = [
      {
        label: "async-module-loader-escape",
        body: `
          const { createRequire } = await import("node:module");
          const alias = createRequire("/tmp/extension.js");
          const fs = alias("node:fs");
          return fs.readFileSync("/etc/passwd", "utf8");
        `,
      },
      {
        label: "standalone-createRequire",
        body: `const load = createRequire("/tmp/extension.js"); return load("node:fs");`,
      },
      {
        label: "module-createRequire",
        body: `const load = module.createRequire("/tmp/extension.js"); return load("node:fs");`,
      },
      {
        label: "global-module-createRequire",
        body: `const load = globalThis.module.createRequire("/tmp/extension.js"); return load("node:fs");`,
      },
      { label: "static-module", body: `import * as loaded from "node:module"; return loaded;` },
      { label: "dynamic-module", body: `return import("node:module");` },
      { label: "require-module", body: `return require("node:module");` },
      { label: "static-installed-package-import", body: `import * as loaded from "hono"; return loaded;` },
      { label: "static-data-url-import", body: `import loaded from "data:text/javascript,export default 1"; return loaded;` },
      { label: "static-file-url-import", body: `import loaded from "file:///tmp/extension.js"; return loaded;` },
      { label: "static-https-url-import", body: `import loaded from "https://example.test/extension.js"; return loaded;` },
      { label: "installed-package-require", body: `return require("hono");` },
      { label: "data-url-require", body: `return require("data:text/javascript,export default 1");` },
      { label: "file-url-require", body: `return require("file:///tmp/extension.js");` },
      { label: "https-url-require", body: `return require("https://example.test/extension.js");` },
      {
        label: "unrelated-receiver-require",
        body: `const object = { require(value) { return value; } }; return object.require(value);`,
      },
      {
        label: "globalThis-receiver-require",
        body: `return globalThis.require(value);`,
      },
      { label: "installed-package-import", body: `return import("hono");` },
      {
        label: "data-url-nested-import",
        body: `return import("data:text/javascript,export default await import('hono')");`,
      },
      { label: "file-url-import", body: `return import("file:///tmp/extension.js");` },
      { label: "https-url-import", body: `return import("https://example.test/extension.js");` },
      { label: "process-getBuiltinModule", body: `return process.getBuiltinModule("fs");` },
      {
        label: "destructured-getBuiltinModule",
        body: `const { getBuiltinModule } = process; return getBuiltinModule("fs");`,
      },
      {
        label: "aliased-getBuiltinModule",
        body: `const loader = process.getBuiltinModule; return loader("fs");`,
      },
      { label: "process-binding", body: `return process.binding(variable);` },
      { label: "process-linked-binding", body: `return process._linkedBinding(variable);` },
      {
        label: "destructured-process-binding",
        body: `const { binding } = process; return binding(variable);`,
      },
      {
        label: "destructured-process-linked-binding",
        body: `const { _linkedBinding: loader } = process; return loader(variable);`,
      },
      {
        label: "aliased-process-binding",
        body: `const loader = process.binding; return loader(variable);`,
      },
      {
        label: "aliased-process-linked-binding",
        body: `const loader = process._linkedBinding; return loader(variable);`,
      },
      { label: "module-require", body: `return module.require(variable);` },
      { label: "computed-module-require", body: `return module["require"](variable);` },
      { label: "aliased-module-require", body: `const loader = module.require; return loader(variable);` },
      {
        label: "bound-module-require",
        body: `const loader = module.require.bind(module); return loader(variable);`,
      },
      {
        label: "destructured-module-require",
        body: `const { require: loader } = module; return loader(variable);`,
      },
      { label: "main-module-require", body: `return require.main.require(variable);` },
      { label: "cached-module-require", body: `return require.cache[id].require(variable);` },
    ];
    for (const specifier of [
      "module",
      "node:module",
      "vm",
      "node:vm",
      "process",
      "node:process",
      "bun",
      "bun:ffi",
      "node:ffi",
      "bun:jsc",
    ]) {
      blockedBodies.push(
        { label: `static-${specifier}`, body: `import * as loaded from "${specifier}"; return loaded;` },
        { label: `dynamic-${specifier}`, body: `return import("${specifier}");` },
        { label: `require-${specifier}`, body: `return require("${specifier}");` },
      );
    }
    blockedBodies.push(
      { label: "static-bun:jsc-side-effect", body: `import "bun:jsc";` },
      { label: "static-bun:jsc-default", body: `import jsc from "bun:jsc"; return jsc;` },
      { label: "static-bun:jsc-named", body: `import { compile } from "bun:jsc"; return compile;` },
    );


    for (const { label, body } of blockedBodies) {
      const expectedReason =
        /(?:getBuiltinModule|binding)/.test(label)
          ? "blocked capabilities: dangerous process API usage"
          : label === "destructured-module-require"
            ? "blocked capabilities: dynamic module access"
            : "blocked capabilities: module loading";
      const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost([
        "dynamic_code_execution",
        "base64_decode",
      ]);
      const name = `${label}-${owner.generation}`;
      try {
        invokeHandleRegisterMacro(host, {
          registrationId: `${name}-registration`,
          name,
          handler: body,
        });
        expect(messages).toContainEqual({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: `${name}-registration`,
            accepted: false,
          },
        });
        expect(rejectionReasons, `${label}: ${body}`).toEqual([expectedReason]);
        expect(macroRegistry.getMacro(name)).toBeNull();
      } finally {
        macroRegistry.unregisterOwner(owner);
        macroRegistry.deactivateExtensionGeneration(owner);
      }
    }
  });
  test("accepts comments, strings, and standalone URL parsing without module access", () => {
    const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost([
      "dynamic_code_execution",
      "base64_decode",
    ]);
    const name = `safe-handler-${owner.generation}`;
    const handler = String.raw`
      // import('node:module'); require('hono'); object.require(value);
      const prose = "require.cache[id].require(variable) import('hono')";
      const parsed = new URL("https://example.test/extension.js");
      return parsed.protocol + ":" + prose.length;
    `;
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-registration`,
        name,
        handler,
      });
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${name}-registration`,
          accepted: true,
        },
      });
      expect(rejectionReasons).toEqual([]);
      expect(macroRegistry.getMacro(name)).not.toBeNull();
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });


  test("rejects non-string and over-limit handlers independently", () => {
    const cases: Array<{ label: string; handler?: unknown }> = [
      { label: "number", handler: 42 },
      { label: "object", handler: {} },
      { label: "missing" },
      { label: "oversized", handler: "x".repeat(65_537) },
    ];

    for (const item of cases) {
      const { host, owner, messages } = createMacroRegistrationHost();
      const name = `${item.label}-${owner.generation}`;
      try {
        const definition: Record<string, unknown> = {
          registrationId: `${name}-registration`,
          name,
        };
        if ("handler" in item) definition.handler = item.handler;
        invokeHandleRegisterMacro(host, definition);
        expect(messages).toContainEqual({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: `${name}-registration`,
            accepted: false,
          },
        });
        expect(macroRegistry.getMacro(name)).toBeNull();
      } finally {
        macroRegistry.unregisterOwner(owner);
        macroRegistry.deactivateExtensionGeneration(owner);
      }
    }
  });

  test("accepts the exact 65,536-character boundary at the registry boundary", () => {
    const body = "x".repeat(65_536);
    expect(body.length).toBe(65_536);
    const { host, owner, messages } = createMacroRegistrationHost();
    const name = `max-body-${owner.generation}`;
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-registration`,
        name,
        handler: body,
      });
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${name}-registration`,
          accepted: true,
        },
      });
      expect(macroRegistry.getMacro(name)).not.toBeNull();
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });

  test("matches declared dynamic-code and base64 capability opt-ins", () => {
    const cases = [
      {
        label: "dynamic-code",
        handler: "return eval('1 + 1');",
        capability: "dynamic_code_execution",
      },
      {
        label: "base64",
        handler: "return Buffer.from('Zm9v', 'base64').toString();",
        capability: "base64_decode",
      },
    ] as const;

    for (const item of cases) {
      for (const capabilities of [[], [item.capability]]) {
        const { host, owner, messages } = createMacroRegistrationHost(capabilities);
        const name = `${item.label}-${capabilities.length === 0 ? "blocked" : "allowed"}-${owner.generation}`;
        try {
          invokeHandleRegisterMacro(host, {
            registrationId: `${name}-registration`,
            name,
            handler: item.handler,
          });
          const accepted = capabilities.length === 1;
          expect(messages).toContainEqual({
            type: "event",
            event: "__macro_registration_result__",
            payload: {
              registrationId: `${name}-registration`,
              accepted,
            },
          });
          expect(macroRegistry.getMacro(name) !== null).toBe(accepted);
        } finally {
          macroRegistry.unregisterOwner(owner);
          macroRegistry.deactivateExtensionGeneration(owner);
        }
      }
    }
  });

  test("ignores harmless http and fs mentions in literals and comments", () => {
    const { host, owner, messages } = createMacroRegistrationHost();
    const name = `harmless-${owner.generation}`;
    const handler = `
      // import('node:fs'); require(dynamicName); Bun.file(path); process.env.SECRET;
      return "http://example.test/fs";
    `;
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-registration`,
        name,
        handler,
      });
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${name}-registration`,
          accepted: true,
        },
      });
      expect(macroRegistry.getMacro(name)).not.toBeNull();
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });
  test("rejects a near-limit serialized handler with thousands of ignored spans within the normal timeout", () => {
    const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost();
    const name = `many-ignored-spans-${owner.generation}`;
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-registration`,
        name,
        handler: manyIgnoredSpanHandler(),
      });
      expect(rejectionReasons).toEqual(["blocked capabilities: module loading"]);
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${name}-registration`,
          accepted: false,
        },
      });
      expect(macroRegistry.getMacro(name)).toBeNull();
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  }, { timeout: 5_000 });

});

describe("WorkerHost stop lifecycle", () => {
  test("answers catalog requests for frontend-only extensions without runtime", () => {
    let emitted = false;
    const originalEmit = eventBus.emit;
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true;
    }) as typeof eventBus.emit;
    try {
      const host = {
        runtime: null,
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        macroOwner: { extensionId: "extension-owner", generation: "g1" },
        installScope: "operator",
        installedByUserId: null,
      } as unknown as WorkerHost;
      WorkerHost.prototype.sendFrontendMessage.call(
        host,
        { type: "__loom_macro_catalog_request", requestId: "request-fe" },
        "user-1",
      );
      expect(emitted).toBe(true);
    } finally {
      eventBus.emit = originalEmit;
    }
  });

  test("drops catalog requests after stop() on frontend-only extensions", async () => {
    let emitted = false;
    const originalEmit = eventBus.emit;
    eventBus.emit = ((event: EventType) => {
      if (event === EventType.SPINDLE_FRONTEND_MSG) emitted = true;
    }) as typeof eventBus.emit;
    try {
      const host = {
        runtime: null,
        runtimeStopping: false,
        extensionId: "extension-db-id",
        manifest: { identifier: "extension-owner" },
        macroOwner: { extensionId: "extension-owner", generation: "g1" },
        installScope: "operator",
        installedByUserId: null,
        clearMacroRegistrations() {},
        rejectPendingRequests() {},
      } as unknown as WorkerHost;

      await WorkerHost.prototype.stop.call(host);
      expect((host as unknown as { runtimeStopping: boolean }).runtimeStopping).toBe(true);

      WorkerHost.prototype.sendFrontendMessage.call(
        host,
        { type: "__loom_macro_catalog_request", requestId: "request-stopped" },
        "user-1",
      );
      expect(emitted).toBe(false);
    } finally {
      eventBus.emit = originalEmit;
    }
  });

  test("deactivates cached and pull macros at stop start and settles pending pulls without the fallback timer", async () => {
    const { host, owner } = createMacroRegistrationHost();
    const state = host as unknown as MacroStopHostStub;
    const cachedName = `stop-cached-${owner.generation}`;
    const pullName = `stop-pull-${owner.generation}`;
    let observedStopping = false;
    let observedCached: Promise<unknown> | undefined;
    let observedPull: Promise<unknown> | undefined;
    let releaseShutdownAck: (() => void) | null = null;
    try {
      state.runtime = { mode: "worker", terminate() {} };
      state.runtimeExitPromise = null;
      state.onWorkerShutdownAck = null;
      state.onWorkerReady = null;
      state.onRuntimeExit = null;
      state.stopRuntimeStatsSampling = () => {};
      state.stopAllFrontendProcesses = () => {};
      state.stopAllBackendProcesses = () => {};
      state.emitRuntimeStats = async () => {};
      state.cleanup = () => workerHostCleanupMethods.clearMacroRegistrations.call(host);

      invokeHandleRegisterMacro(host, {
        registrationId: `${cachedName}-registration`,
        name: cachedName,
        handler: "return 'cached';",
      });
      invokeHandleRegisterMacro(host, {
        registrationId: `${pullName}-registration`,
        name: pullName,
        handler: "return 'pull';",
      });
      invokeHandleUpdateMacroValue(host, cachedName, "cached-value");

      const cachedMacro = macroRegistry.getMacro(cachedName);
      const pullMacro = macroRegistry.getMacro(pullName);
      if (!cachedMacro || !pullMacro) throw new Error("stop-race macros were not registered");
      const context = {
        env: {
          chat: { id: "" },
          variables: { local: new Map(), global: new Map(), chat: new Map() },
          dynamicMacros: {},
          extra: {},
        },
      } as Parameters<typeof cachedMacro.handler>[0];
      expect(await cachedMacro.handler(context)).toBe("cached-value");
      const pendingPull = Promise.resolve(pullMacro.handler(context));
      expect(state.pendingRequests.size).toBe(1);

      state.postToWorker = (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "shutdown"
        ) {
          observedStopping = state.runtimeStopping;
          observedCached = Promise.resolve(cachedMacro.handler(context));
          observedPull = Promise.resolve(pullMacro.handler(context));
          releaseShutdownAck = state.onWorkerShutdownAck;
        }
      };

      let pendingResult: string | undefined;
      void pendingPull.then((value) => {
        pendingResult = value;
      });
      const stopPromise = WorkerHost.prototype.stop.call(host);
      try {
        expect(observedStopping).toBe(true);
        expect(releaseShutdownAck).not.toBeNull();
        expect(await observedCached).toBe("");
        expect(await observedPull).toBe("");
        await Promise.resolve();
        expect(pendingResult).toBe("");
        expect(state.pendingRequests.size).toBe(0);
        expect(macroRegistry.getMacro(cachedName)).toBeNull();
        expect(macroRegistry.getMacro(pullName)).toBeNull();
      } finally {
        (releaseShutdownAck as (() => void) | null)?.();
        await stopPromise;
        for (const pending of state.pendingRequests.values()) {
          pending.reject(new Error("stop-race test cleanup"));
        }
      }
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  }, { timeout: 2_000 });

  test("cleans up on process path when runtimeExitPromise is null", async () => {
    let cleanupCount = 0;
    const host = {
      runtime: { mode: "process", terminate() {} },
      runtimeExitPromise: null,
      runtimeStopping: false,
      macroOwner: { extensionId: "test-ext", generation: "g1" },
      onWorkerShutdownAck: null as (() => void) | null,
      onWorkerReady: null,
      onRuntimeExit: null,
      stopRuntimeStatsSampling() {},
      stopAllFrontendProcesses() {},
      stopAllBackendProcesses() {},
      postToWorker() {
        const ack = (host as unknown as { onWorkerShutdownAck: (() => void) | null }).onWorkerShutdownAck;
        if (ack) ack();
      },
      cleanup() { cleanupCount++; },
      clearMacroRegistrations() {},
      rejectPendingRequests() {},
      manifest: { identifier: "test-ext" },
      extensionId: "test-ext",
    } as unknown as WorkerHost;

    await WorkerHost.prototype.stop.call(host);
    expect(cleanupCount).toBe(1);
  });
  test.serial("ACKed worker shutdown terminates the captured runtime once and cleans up promptly", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timerState = {
      callback: null as (() => void) | null,
      timer: null as unknown,
      delay: undefined as number | undefined,
      cleared: false,
    };
    const controlledSetTimeout = ((callback: () => void, delay: number) => {
      timerState.callback = callback;
      timerState.delay = delay;
      timerState.timer = {};
      return timerState.timer;
    }) as unknown as typeof globalThis.setTimeout;
    const controlledClearTimeout = ((timer: unknown) => {
      if (timer === timerState.timer) timerState.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;

    try {
      globalThis.setTimeout = controlledSetTimeout;
      globalThis.clearTimeout = controlledClearTimeout;
      let terminateCount = 0;
      let cleanupCount = 0;
      let shutdownPosted = false;
      const runtime = {
        mode: "worker" as const,
        terminate() {
          terminateCount += 1;
        },
      };
      let stopState: WorkerStopHostStub;
      const host = {
        runtime,
        runtimeExitPromise: null,
        runtimeStopping: false,
        macroOwner: { extensionId: "test-ext", generation: "g1" },
        onWorkerShutdownAck: null as (() => void) | null,
        onWorkerReady: null,
        onRuntimeExit: null,
        stopRuntimeStatsSampling() {},
        emitRuntimeStats() {
          return Promise.resolve();
        },
        stopAllFrontendProcesses() {},
        stopAllBackendProcesses() {},
        postToWorker(message: unknown) {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "shutdown"
          ) {
            shutdownPosted = true;
            const ack = stopState.onWorkerShutdownAck;
            ack?.();
            stopState.runtime = null;
          }
        },
        cleanup() {
          cleanupCount += 1;
        },
        clearMacroRegistrations() {},
        rejectPendingRequests() {},
        manifest: { identifier: "test-ext" },
        extensionId: "test-ext",
      } as unknown as WorkerHost;
      stopState = host as unknown as WorkerStopHostStub;

      await WorkerHost.prototype.stop.call(host);

      expect(shutdownPosted).toBe(true);
      expect(timerState.delay).toBe(5_000);
      expect(timerState.callback).not.toBeNull();
      expect(timerState.cleared).toBe(true);
      expect(stopState.onWorkerShutdownAck).toBeNull();
      expect(stopState.runtimeStopping).toBe(true);
      expect(terminateCount).toBe(1);
      expect(cleanupCount).toBe(1);

      timerState.callback?.();
      expect(terminateCount).toBe(1);
    } finally {
      try {
        globalThis.setTimeout = originalSetTimeout;
      } finally {
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });
});
describe("WorkerHost macro registration byte and retention bounds", () => {
  function utf8Exactly(bytes: number): string {
    if (bytes % 4 !== 0) throw new Error("test helper expects a four-byte boundary");
    return "🙂".repeat(bytes / 4);
  }

  test("enforces UTF-8 byte bounds atomically across serialized registration fields", () => {
    const cases: Array<{
      label: string;
      maxBytes: number;
      build: (value: string, name: string) => Record<string, unknown>;
      reason: string;
    }> = [
      {
        label: "name",
        maxBytes: 128,
        build: (value) => ({ name: value }),
        reason: "name exceeds 128 UTF-8 bytes",
      },
      {
        label: "category",
        maxBytes: 256,
        build: (value, name) => ({ name, category: value }),
        reason: "category exceeds 256 UTF-8 bytes",
      },
      {
        label: "description",
        maxBytes: 4_096,
        build: (value, name) => ({ name, description: value }),
        reason: "description exceeds 4096 UTF-8 bytes",
      },
      {
        label: "returns",
        maxBytes: 1_024,
        build: (value, name) => ({ name, returns: value }),
        reason: "returns exceeds 1024 UTF-8 bytes",
      },
      {
        label: "alias",
        maxBytes: 128,
        build: (value, name) => ({ name, aliases: [value] }),
        reason: "alias exceeds 128 UTF-8 bytes",
      },
      {
        label: "argument-name",
        maxBytes: 128,
        build: (value, name) => ({ name, args: [{ name: value }] }),
        reason: "argument name exceeds 128 UTF-8 bytes",
      },
      {
        label: "argument-description",
        maxBytes: 1_024,
        build: (value, name) => ({
          name,
          args: [{ name: "arg", description: value }],
        }),
        reason: "argument description exceeds 1024 UTF-8 bytes",
      },
      {
        label: "handler",
        maxBytes: 65_536,
        build: (value, name) => ({ name, handler: value }),
        reason: "handler body exceeds 65536 UTF-8 bytes",
      },
    ];

    for (const item of cases) {
      const exactValue =
        item.label === "handler"
          ? `/*${"🙂".repeat(16_383)}*/`
          : utf8Exactly(item.maxBytes);
      const overValue =
        item.label === "handler"
          ? `/*${"🙂".repeat(16_384)}*/`
          : utf8Exactly(item.maxBytes + 4);

      const accepted = createMacroRegistrationHost();
      const acceptedName = `utf8-${item.label}-accepted-${accepted.owner.generation}`;
      try {
        const acceptedDefinition = item.build(exactValue, acceptedName);
        if (!("handler" in acceptedDefinition)) {
          acceptedDefinition.handler = "return 'ok';";
        }
        acceptedDefinition.registrationId = `${acceptedName}-registration`;
        if (item.label === "name") {
          acceptedDefinition.registrationId = "utf8-name-accepted-registration";
        }
        invokeHandleRegisterMacro(accepted.host, acceptedDefinition);
        expect(accepted.rejectionReasons).toEqual([]);
        const acceptedMacroName =
          item.label === "name" ? exactValue : acceptedName;
        expect(macroRegistry.getMacro(acceptedMacroName)).not.toBeNull();
      } finally {
        macroRegistry.unregisterOwner(accepted.owner);
        macroRegistry.deactivateExtensionGeneration(accepted.owner);
      }

      const rejected = createMacroRegistrationHost();
      const rejectedName = `utf8-${item.label}-rejected-${rejected.owner.generation}`;
      try {
        const rejectedDefinition = item.build(overValue, rejectedName);
        rejectedDefinition.registrationId = `${rejectedName}-registration`;
        if (!("handler" in rejectedDefinition)) {
          rejectedDefinition.handler = "return 'over';";
        }
        invokeHandleRegisterMacro(rejected.host, rejectedDefinition);
        expect(rejected.rejectionReasons).toEqual([item.reason]);
        expect(macroRegistrationState(rejected.host).registeredMacroNames.size).toBe(0);
        expect(macroRegistrationState(rejected.host).macroValueCache.size).toBe(0);
        expect(macroRegistry.getMacro(rejectedName)).toBeNull();
        expect(rejected.messages).toContainEqual({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: `${rejectedName}-registration`,
            accepted: false,
          },
        });
      } finally {
        macroRegistry.unregisterOwner(rejected.owner);
        macroRegistry.deactivateExtensionGeneration(rejected.owner);
      }
    }
  });

  test("accepts 128 macros but rejects the 129th without partial registry state", () => {
    const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost();
    const acceptedNames: string[] = [];
    try {
      for (let index = 0; index < 128; index++) {
        const name = `count-${index}-${owner.generation}`;
        acceptedNames.push(name);
        invokeHandleRegisterMacro(host, {
          registrationId: `${name}-registration`,
          name,
          handler: "return 'ok';",
        });
      }
      expect(macroRegistrationState(host).registeredMacroNames.size).toBe(128);
      expect(acceptedNames.every((name) => macroRegistry.getMacro(name) !== null)).toBe(true);

      const overflowName = `count-overflow-${owner.generation}`;
      invokeHandleRegisterMacro(host, {
        registrationId: `${overflowName}-registration`,
        name: overflowName,
        handler: "return 'overflow';",
      });
      expect(rejectionReasons).toEqual([
        "macro registration limit reached (128)",
      ]);
      expect(macroRegistrationState(host).registeredMacroNames.size).toBe(128);
      expect(macroRegistrationState(host).macroValueCache.size).toBe(0);
      expect(macroRegistry.getMacro(overflowName)).toBeNull();
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${overflowName}-registration`,
          accepted: false,
        },
      });
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });

  test("rejects over-limit aliases and args atomically while accepting each exact boundary", () => {
    const cases = [
      {
        label: "aliases",
        exact: { aliases: Array.from({ length: 32 }, (_, index) => `alias-${index}`) },
        over: { aliases: Array.from({ length: 33 }, (_, index) => `alias-over-${index}`) },
        reason: "aliases exceed 32 entries",
      },
      {
        label: "args",
        exact: { args: Array.from({ length: 64 }, (_, index) => ({ name: `arg-${index}` })) },
        over: { args: Array.from({ length: 65 }, (_, index) => ({ name: `arg-over-${index}` })) },
        reason: "args exceed 64 entries",
      },
    ] as const;

    for (const item of cases) {
      const accepted = createMacroRegistrationHost();
      const acceptedName = `exact-${item.label}-${accepted.owner.generation}`;
      try {
        invokeHandleRegisterMacro(accepted.host, {
          registrationId: `${acceptedName}-registration`,
          name: acceptedName,
          handler: "return 'exact';",
          ...item.exact,
        });
        expect(accepted.rejectionReasons).toEqual([]);
        expect(macroRegistrationState(accepted.host).registeredMacroNames.size).toBe(1);
        expect(macroRegistry.getMacro(acceptedName)).not.toBeNull();
      } finally {
        macroRegistry.unregisterOwner(accepted.owner);
        macroRegistry.deactivateExtensionGeneration(accepted.owner);
      }

      const rejected = createMacroRegistrationHost();
      const rejectedName = `over-${item.label}-${rejected.owner.generation}`;
      try {
        invokeHandleRegisterMacro(rejected.host, {
          registrationId: `${rejectedName}-registration`,
          name: rejectedName,
          handler: "return 'over';",
          ...item.over,
        });
        expect(rejected.rejectionReasons).toEqual([item.reason]);
        expect(macroRegistrationState(rejected.host).registeredMacroNames.size).toBe(0);
        expect(macroRegistrationState(rejected.host).macroValueCache.size).toBe(0);
        expect(macroRegistry.getMacro(rejectedName)).toBeNull();
      } finally {
        macroRegistry.unregisterOwner(rejected.owner);
        macroRegistry.deactivateExtensionGeneration(rejected.owner);
      }
    }
  });

  test("preserves an accepted macro and cache when an over-limit replacement is rejected", async () => {
    const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost();
    const name = `atomic-replacement-${owner.generation}`;
    const oversizedHandler = " ".repeat(65_536) + ";";
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-initial-registration`,
        name,
        handler: "return 'original';",
      });
      invokeHandleUpdateMacroValue(host, name, "retained");
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-replacement-registration`,
        name: name.toUpperCase(),
        handler: oversizedHandler,
      });

      expect(rejectionReasons).toEqual([
        "handler body exceeds 65536 UTF-8 bytes",
      ]);
      expect(macroRegistrationState(host).registeredMacroNames).toEqual(new Set([name]));
      expect(macroRegistrationState(host).macroValueCache.get(name)).toBe("retained");
      expect(macroRegistry.getMacro(name)).not.toBeNull();
      expect(messages).toContainEqual({
        type: "event",
        event: "__macro_registration_result__",
        payload: {
          registrationId: `${name}-replacement-registration`,
          accepted: false,
        },
      });

      const macro = macroRegistry.getMacro(name);
      if (!macro) throw new Error("initial macro was not retained");
      const context = {
        env: {
          chat: { id: "" },
          variables: { local: new Map(), global: new Map(), chat: new Map() },
          dynamicMacros: {},
          extra: {},
        },
      } as Parameters<typeof macro.handler>[0];
      expect(await macro.handler(context)).toBe("retained");
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });

  test("retains only bounded cached values and bounded pull responses", async () => {
    const { host, owner, messages } = createMacroRegistrationHost();
    const cachedName = `cached-retention-${owner.generation}`;
    const pullName = `pull-retention-${owner.generation}`;
    const oversized = "🙂".repeat(65_537);
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${cachedName}-registration`,
        name: cachedName,
        handler: "return 'pull';",
      });
      invokeHandleRegisterMacro(host, {
        registrationId: `${pullName}-registration`,
        name: pullName,
        handler: "return 'pull';",
      });
      invokeHandleUpdateMacroValue(host, cachedName, "retained");
      expect(macroRegistrationState(host).macroValueCache.get(cachedName)).toBe("retained");
      invokeHandleUpdateMacroValue(host, cachedName, oversized);
      expect(macroRegistrationState(host).macroValueCache.get(cachedName)).toBe("retained");

      const cachedMacro = macroRegistry.getMacro(cachedName);
      if (!cachedMacro) throw new Error("cached macro was not registered");
      const cachedContext = {
        env: {
          chat: { id: "" },
          variables: { local: new Map(), global: new Map(), chat: new Map() },
          dynamicMacros: {},
          extra: {},
        },
      } as Parameters<typeof cachedMacro.handler>[0];
      expect(await cachedMacro.handler(cachedContext)).toBe("retained");

      const pullMacro = macroRegistry.getMacro(pullName);
      if (!pullMacro) throw new Error("pull macro was not registered");
      messages.length = 0;
      const pullContext = {
        env: {
          chat: { id: "" },
          variables: { local: new Map(), global: new Map(), chat: new Map() },
          dynamicMacros: {},
          extra: {},
        },
      } as Parameters<typeof pullMacro.handler>[0];
      const pullResult = pullMacro.handler(pullContext);
      const invocation = messages.find(
        (message): message is { type: string; payload: unknown } =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "event" &&
          "payload" in message,
      );
      if (!invocation || !invocation.payload || typeof invocation.payload !== "object") {
        throw new Error("pull invocation was not posted");
      }
      if (!("requestId" in invocation.payload) || typeof invocation.payload.requestId !== "string") {
        throw new Error("pull invocation did not include a request id");
      }
      invokeResolveRequest(host, invocation.payload.requestId, oversized);
      expect(await pullResult).toBe("");
    } finally {
      macroRegistry.unregisterOwner(owner);
      macroRegistry.deactivateExtensionGeneration(owner);
    }
  });
});

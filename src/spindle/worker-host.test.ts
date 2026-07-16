import { describe, expect, spyOn, test } from "bun:test";
import {
  WorkerHost,
  MANAGED_PROCESS_MAX_KIND_BYTES,
  MANAGED_PROCESS_MAX_KEY_BYTES,
  MANAGED_PROCESS_MAX_ENTRY_BYTES,
  MANAGED_PROCESS_MAX_PROCESS_ID_BYTES,
  MANAGED_PROCESS_MAX_REASON_BYTES,
  MANAGED_PROCESS_MAX_ERROR_BYTES,
} from "./worker-host";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { registry as macroRegistry, type MacroOwner } from "../macros/MacroRegistry";
import * as managerSvc from "./manager.service";
import * as runtimeTransportSvc from "./runtime-transport";
import { env } from "../env";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import type { MacroDefinition } from "../macros/types";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function invokeHandleMessageInScope(host: WorkerHost, message: unknown): void {
  const handleMessageInScope = (WorkerHost.prototype as unknown as {
    handleMessageInScope: (message: unknown) => void
  }).handleMessageInScope
  handleMessageInScope.call(host, message)
}
type WorkerHostFrontendProcessMethods = {
  sendFrontendProcessEvent: (
    userId: string,
    payload: Record<string, unknown>,
  ) => void;
};

const workerHostFrontendProcessMethods =
  WorkerHost.prototype as unknown as WorkerHostFrontendProcessMethods;

function invokeSendFrontendProcessEvent(
  host: WorkerHost,
  userId: string,
  payload: Record<string, unknown>,
): void {
  workerHostFrontendProcessMethods.sendFrontendProcessEvent.call(
    host,
    userId,
    payload,
  );
}


type BackendProcessSpawnOptions = {
  entry: string;
  kind?: string;
  key?: string;
  payload?: unknown;
  metadata?: unknown;
  userId?: string;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  replaceExisting?: boolean;
};

type WorkerHostBackendProcessMethods = {
  handleBackendProcessSpawn: (
    requestId: string,
    options: BackendProcessSpawnOptions,
  ) => Promise<void>;
};

const workerHostBackendProcessMethods =
  WorkerHost.prototype as unknown as WorkerHostBackendProcessMethods;

function invokeHandleBackendProcessSpawn(
  host: WorkerHost,
  requestId: string,
  options: BackendProcessSpawnOptions,
): Promise<void> {
  return workerHostBackendProcessMethods.handleBackendProcessSpawn.call(
    host,
    requestId,
    options,
  );
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
type WorkerHostStartLifecycleState = {
  stopRequested: boolean;
  runtime: unknown;
  runtimeReplacement: unknown;
  startPromise: unknown;
  cleanup: () => void;
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
type WorkerHostRejectMethods = {
  rejectMacroRegistration: (
    registrationId: string,
    macroName: string,
    reason: string,
  ) => void;
};

const workerHostRejectMethods =
  WorkerHost.prototype as unknown as WorkerHostRejectMethods;

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
  if (!macroRegistry.beginExtensionGeneration(owner)) throw new Error("generation activation failed");
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
      workerHostRejectMethods.rejectMacroRegistration.call(
        stub as unknown as WorkerHost,
        registrationId,
        _macroName,
        reason,
      );
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

function createStartFixture(generation: string): {
  extensionId: string;
  manifest: SpindleManifest;
  extensionInfo: ExtensionInfo;
  host: WorkerHost;
} {
  const extensionId = `worker-host-start-${crypto.randomUUID()}`;
  const manifest = {
    version: "1.0.0",
    name: "Worker Host Start",
    identifier: extensionId,
    author: "Lumiverse",
    github: "https://example.test/worker-host-start",
    homepage: "https://example.test/worker-host-start",
    permissions: [],
    entry_backend: "dist/backend.js",
  } satisfies SpindleManifest;
  const extensionInfo = {
    id: `db-${extensionId}`,
    identifier: extensionId,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: "",
    github: manifest.github,
    homepage: manifest.homepage,
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: false,
    has_backend: true,
    status: "running",
    metadata: {},
  } satisfies ExtensionInfo;
  return {
    extensionId,
    manifest,
    extensionInfo,
    host: new WorkerHost(extensionInfo.id, manifest, extensionInfo, generation),
  };
}

type FakeRuntimeTransportOptions = {
  onMessage: (message: unknown) => void;
  onError: (message: string) => void;
  onExit: (exitCode: number | null, signalCode: number | null, error?: Error) => void;
};

function createFakeRuntimeTransport(
  options: FakeRuntimeTransportOptions,
): runtimeTransportSvc.RuntimeTransport {
  return {
    mode: "worker",
    pid: null,
    postMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "init"
      ) {
        options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
      }
    },
    terminate() {},
  };
}

describe("WorkerHost start rollback", () => {
  test.serial("restores the incumbent macro owner when process transport construction fails", async () => {
    const extensionId = `worker-host-start-rollback-${crypto.randomUUID()}`;
    const incumbentOwner: MacroOwner = { extensionId, generation: "incumbent" };
    const failedOwner: MacroOwner = { extensionId, generation: "failed" };
    const incumbentMacro: MacroDefinition = {
      name: "incumbent_macro",
      category: `extension:${extensionId}`,
      description: "incumbent macro",
      returnType: "string",
      handler: () => "incumbent",
    };
    expect(macroRegistry.beginExtensionGeneration(incumbentOwner)).not.toBeNull();
    expect(macroRegistry.registerExtensionMacro(incumbentMacro, incumbentOwner)).toBe(true);

    const manifest = {
      version: "1.0.0",
      name: "Worker Host Start Rollback",
      identifier: extensionId,
      author: "Lumiverse",
      github: "https://example.test/worker-host-start-rollback",
      homepage: "https://example.test/worker-host-start-rollback",
      permissions: [],
      entry_backend: "dist/backend.js",
    } satisfies SpindleManifest;
    const extensionInfo = {
      id: `db-${extensionId}`,
      identifier: extensionId,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: "",
      github: manifest.github,
      homepage: manifest.homepage,
      permissions: [],
      granted_permissions: [],
      enabled: true,
      installed_at: 0,
      updated_at: 0,
      has_frontend: false,
      has_backend: true,
      status: "running",
      metadata: {},
    } satisfies ExtensionInfo;
    const host = new WorkerHost(extensionInfo.id, manifest, extensionInfo, failedOwner.generation);
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("start rollback test could not capture Bun.spawn");
    const runtimeModeKey = "LUMIVERSE_SPINDLE_RUNTIME_MODE";
    const previousRuntimeModeDescriptor = Object.getOwnPropertyDescriptor(process.env, runtimeModeKey);
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockResolvedValue("dist/backend.js");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/start-rollback-repo");
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/start-rollback-storage");
    Object.defineProperty(process.env, runtimeModeKey, {
      ...(previousRuntimeModeDescriptor ?? {
        configurable: true,
        enumerable: true,
        writable: true,
      }),
      value: "process",
    });
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: () => {
        throw new Error("managed process transport construction failure");
      },
    });

    try {
      await expect(host.start()).rejects.toThrow("managed process transport construction failure");
      expect(macroRegistry.isActiveOwner(incumbentOwner)).toBe(true);
      expect(macroRegistry.isActiveOwner(failedOwner)).toBe(false);
      expect(macroRegistry.getMacro("incumbent_macro")?.handler({} as never)).toBe("incumbent");
    } finally {
      try {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
        if (previousRuntimeModeDescriptor) {
          Object.defineProperty(process.env, runtimeModeKey, previousRuntimeModeDescriptor);
        } else {
          delete process.env[runtimeModeKey];
        }
        expect(Object.getOwnPropertyDescriptor(process.env, runtimeModeKey)).toEqual(
          previousRuntimeModeDescriptor,
        );
      } finally {
        entryPathSpy.mockRestore();
        repoPathSpy.mockRestore();
        storagePathSpy.mockRestore();
        macroRegistry.unregisterOwner(incumbentOwner);
        macroRegistry.deactivateExtensionGeneration(incumbentOwner);
      }
    }
  });
  test.serial("rolls back the generation when storage setup throws", async () => {
    const generation = `storage-failure-${crypto.randomUUID()}`;
    const { host, extensionId } = createStartFixture(generation);
    const incumbentOwner: MacroOwner = { extensionId, generation: "incumbent" };
    const incumbentMacro: MacroDefinition = {
      name: "storage_incumbent",
      category: `extension:${extensionId}`,
      description: "incumbent macro",
      returnType: "string",
      handler: () => "incumbent",
    };
    expect(macroRegistry.beginExtensionGeneration(incumbentOwner)).not.toBeNull();
    expect(macroRegistry.registerExtensionMacro(incumbentMacro, incumbentOwner)).toBe(true);

    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockResolvedValue("dist/backend.js");
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockImplementation(() => {
      throw new Error("storage setup failure");
    });
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport");
    try {
      await expect(host.start()).rejects.toThrow("storage setup failure");
      expect(transportSpy).not.toHaveBeenCalled();
      expect(macroRegistry.isActiveOwner(incumbentOwner)).toBe(true);
      expect(macroRegistry.getMacro("storage_incumbent")?.handler({} as never)).toBe("incumbent");
      expect(macroRegistry.isActiveOwner({ extensionId, generation })).toBe(false);
    } finally {
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      transportSpy.mockRestore();
      macroRegistry.unregisterOwner(incumbentOwner);
      macroRegistry.deactivateExtensionGeneration(incumbentOwner);
    }
  });

  test.serial("rejects a transport that exits before generation binding", async () => {
    const generation = `fast-exit-${crypto.randomUUID()}`;
    const { host, extensionId } = createStartFixture(generation);
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockResolvedValue("dist/backend.js");
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/fast-exit-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/fast-exit-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      options.onExit(1, null, new Error("fast exit before binding"));
      return createFakeRuntimeTransport(options);
    });
    try {
      await expect(host.start()).rejects.toThrow("fast exit before binding");
      expect(macroRegistry.isActiveOwner({ extensionId, generation })).toBe(false);
    } finally {
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      macroRegistry.unregisterOwner({ extensionId, generation });
      macroRegistry.deactivateExtensionGeneration({ extensionId, generation });
    }
  });

  test.serial("blocks delayed incumbent callbacks while replacement setup is pending", async () => {
    const generation = `delayed-incumbent-${crypto.randomUUID()}`;
    const { host, extensionId } = createStartFixture(generation);
    const transports: FakeRuntimeTransportOptions[] = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/delayed-incumbent-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/delayed-incumbent-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      const callbacks = {
        onMessage: options.onMessage,
        onError: options.onError,
        onExit: options.onExit,
      };
      transports.push(callbacks);
      return createFakeRuntimeTransport(options);
    });
    try {
      await host.start();
      transports[0]?.onMessage({
        type: "register_macro",
        definition: {
          registrationId: "incumbent-registration",
          name: "delayed_incumbent",
          category: `extension:${extensionId}`,
          description: "incumbent macro",
          returnType: "string",
          handler: "return 'incumbent';",
        },
      });
      expect(macroRegistry.hasMacro("delayed_incumbent")).toBe(true);

      const replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();
      transports[0]?.onMessage({ type: "unregister_macro", name: "delayed_incumbent" });
      expect(macroRegistry.hasMacro("delayed_incumbent")).toBe(true);

      releaseEntry?.("dist/backend.js");
      await replacement;
      expect(macroRegistry.hasMacro("delayed_incumbent")).toBe(false);
      expect(transports).toHaveLength(2);
    } finally {
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      macroRegistry.unregisterOwner({ extensionId, generation });
      macroRegistry.deactivateExtensionGeneration({ extensionId, generation });
    }
  });

  test.serial("replays delayed incumbent callbacks when replacement setup fails", async () => {
    const generation = `delayed-incumbent-rollback-${crypto.randomUUID()}`;
    const { host, extensionId } = createStartFixture(generation);
    const transports: FakeRuntimeTransportOptions[] = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath")
      .mockReturnValueOnce("/tmp/delayed-incumbent-rollback-storage")
      .mockImplementationOnce(() => {
        throw new Error("replacement storage setup failure");
      });
    const repoPathSpy = spyOn(managerSvc, "getRepoPath")
      .mockReturnValue("/tmp/delayed-incumbent-rollback-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport")
      .mockImplementation((options) => {
        transports.push({
          onMessage: options.onMessage,
          onError: options.onError,
          onExit: options.onExit,
        });
        return createFakeRuntimeTransport(options);
      });
    try {
      await host.start();
      transports[0]?.onMessage({
        type: "register_macro",
        definition: {
          registrationId: "rollback-incumbent-registration",
          name: "rollback_delayed_incumbent",
          category: `extension:${extensionId}`,
          description: "rollback incumbent macro",
          returnType: "string",
          handler: "return 'incumbent';",
        },
      });
      expect(macroRegistry.hasMacro("rollback_delayed_incumbent")).toBe(true);

      const replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();
      transports[0]?.onExit(1, null, new Error("incumbent exited"));
      transports[0]?.onMessage({
        type: "unregister_macro",
        name: "rollback_delayed_incumbent",
      });
      expect(macroRegistry.hasMacro("rollback_delayed_incumbent")).toBe(true);

      releaseEntry?.("dist/backend.js");
      await expect(replacement).rejects.toThrow("replacement storage setup failure");
      expect(macroRegistry.hasMacro("rollback_delayed_incumbent")).toBe(false);
      expect(macroRegistry.isActiveOwner({ extensionId, generation })).toBe(false);
      expect(transports).toHaveLength(1);
    } finally {
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      macroRegistry.unregisterOwner({ extensionId, generation });
      macroRegistry.deactivateExtensionGeneration({ extensionId, generation });
    }
  });
  test.serial("routes incumbent shutdown ACK and exit while replacement is pending", async () => {
    const generation = `stop-during-replacement-${crypto.randomUUID()}`;
    const { host, extensionId } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & {
      messages: unknown[];
      terminated: number;
    }> = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath")
      .mockReturnValue("/tmp/stop-during-replacement-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath")
      .mockReturnValue("/tmp/stop-during-replacement-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport")
      .mockImplementation((options) => {
        const callbacks = {
          onMessage: options.onMessage,
          onError: options.onError,
          onExit: options.onExit,
          messages: [] as unknown[],
          terminated: 0,
        };
        transports.push(callbacks);
        return {
          mode: "process" as const,
          pid: 123,
          postMessage(message: unknown) {
            callbacks.messages.push(message);
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "init"
            ) {
              options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
            }
          },
          terminate() {
            callbacks.terminated += 1;
          },
        };
      });
    let stopPromise: Promise<void> | undefined;
    let replacement: Promise<void> | undefined;
    try {
      await host.start();
      replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();

      stopPromise = host.stop();
      transports[0]?.onMessage({
        type: "log",
        level: "info",
        message: "__worker_shutdown_ack__",
      });
      transports[0]?.onExit(0, null);
      releaseEntry?.("dist/backend.js");

      await stopPromise;
      stopPromise = undefined;
      await expect(replacement).rejects.toThrow("Extension worker start cancelled");
      replacement = undefined;
      expect(transports[0]?.messages).toContainEqual({ type: "shutdown" });
      expect(transports[0]?.terminated).toBe(0);
      expect(macroRegistry.isActiveOwner({ extensionId, generation })).toBe(false);
    } finally {
      releaseEntry?.("dist/backend.js");
      transports[0]?.onMessage({
        type: "log",
        level: "info",
        message: "__worker_shutdown_ack__",
      });
      transports[0]?.onExit(0, null);
      if (stopPromise) await stopPromise.catch(() => {});
      if (replacement) await replacement.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
      macroRegistry.unregisterOwner({ extensionId, generation });
      macroRegistry.deactivateExtensionGeneration({ extensionId, generation });
    }
  }, { timeout: 2_000 });

  test.serial("replays permission changes to the successful replacement", async () => {
    const generation = `permission-replacement-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & { messages: unknown[] }> = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath")
      .mockReturnValue("/tmp/permission-replacement-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath")
      .mockReturnValue("/tmp/permission-replacement-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport")
      .mockImplementation((options) => {
        const callbacks = {
          onMessage: options.onMessage,
          onError: options.onError,
          onExit: options.onExit,
          messages: [] as unknown[],
        };
        transports.push(callbacks);
        return {
          mode: "worker" as const,
          pid: null,
          postMessage(message: unknown) {
            callbacks.messages.push(message);
            if (typeof message !== "object" || message === null || !("type" in message)) return;
            if (message.type === "init") {
              options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
            } else if (message.type === "shutdown") {
              options.onMessage({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
            }
          },
          terminate() {},
        };
      });
    let replacement: Promise<void> | undefined;
    try {
      await host.start();
      replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();

      host.notifyPermissionChanged("dynamic_code_execution", true, ["dynamic_code_execution"]);
      expect(transports[0]?.messages).not.toContainEqual({
        type: "permission_changed",
        extensionId: host.manifest.identifier,
        permission: "dynamic_code_execution",
        granted: true,
        allGranted: ["dynamic_code_execution"],
      });

      releaseEntry?.("dist/backend.js");
      await replacement;
      replacement = undefined;
      expect(transports[1]?.messages).toContainEqual({
        type: "permission_changed",
        extensionId: host.manifest.identifier,
        permission: "dynamic_code_execution",
        granted: true,
        allGranted: ["dynamic_code_execution"],
      });
      await host.stop();
    } finally {
      releaseEntry?.("dist/backend.js");
      if (replacement) await replacement.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
    }
  }, { timeout: 2_000 });

  test.serial("waits for an in-flight stop before starting a replacement", async () => {
    const generation = `start-during-stop-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & {
      messages: unknown[];
      terminated: number;
    }> = [];
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockResolvedValue("dist/backend.js");
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/start-during-stop-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/start-during-stop-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      const callbacks = {
        onMessage: options.onMessage,
        onError: options.onError,
        onExit: options.onExit,
        messages: [] as unknown[],
        terminated: 0,
      };
      transports.push(callbacks);
      return {
        mode: "worker" as const,
        pid: null,
        postMessage(message: unknown) {
          callbacks.messages.push(message);
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (message.type === "init") {
            options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
          } else if (message.type === "shutdown") {
            options.onMessage({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
          }
        },
        terminate() {
          callbacks.terminated += 1;
        },
      };
    });
    let restart: Promise<void> | undefined;
    try {
      await host.start();
      const stop = host.stop();
      restart = host.start();
      await stop;
      await restart;
      expect(transports).toHaveLength(2);
      expect(transports[0]?.terminated).toBe(1);
      expect(transports[1]?.terminated).toBe(0);
      await host.stop();
    } finally {
      if (restart) await restart.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
    }
  }, { timeout: 2_000 });

  test.serial("keeps stop state while validation rollback is pending", async () => {
    const generation = `stop-validation-rollback-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & {
      messages: unknown[];
      terminated: number;
    }> = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/stop-validation-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/stop-validation-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      const callbacks = {
        onMessage: options.onMessage,
        onError: options.onError,
        onExit: options.onExit,
        messages: [] as unknown[],
        terminated: 0,
      };
      transports.push(callbacks);
      return {
        mode: "worker" as const,
        pid: null,
        postMessage(message: unknown) {
          callbacks.messages.push(message);
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "init"
          ) {
            options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
          }
        },
        terminate() {
          callbacks.terminated += 1;
        },
      };
    });
    let replacement: Promise<void> | undefined;
    let stop: Promise<void> | undefined;
    try {
      await host.start();
      replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();
      stop = host.stop();
      expect((host as unknown as { runtimeStopping: boolean }).runtimeStopping).toBe(true);
      releaseEntry?.("dist/backend.js");
      await expect(replacement).rejects.toThrow("Extension worker start cancelled");
      replacement = undefined;
      expect((host as unknown as { runtimeStopping: boolean }).runtimeStopping).toBe(true);
      expect(transports).toHaveLength(1);
      transports[0]?.onMessage({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
      await stop;
      stop = undefined;
    } finally {
      releaseEntry?.("dist/backend.js");
      if (stop) await stop.catch(() => {});
      if (replacement) await replacement.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
    }
  }, { timeout: 2_000 });
  test.serial("settles stop promptly while a backend entry lookup is delayed", async () => {
    const generation = `stop-delayed-entry-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseEntry = resolve;
        }),
    );
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation(() => {
      throw new Error("late transport creation");
    });
    const start = host.start();
    let stop: Promise<void> | undefined;
    const state = host as unknown as WorkerHostStartLifecycleState;
    try {
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();

      const stopPromise = host.stop();
      stop = stopPromise;
      await stopPromise;
      expect(state.stopRequested).toBe(true);

      releaseEntry?.("dist/backend.js");
      await expect(start).rejects.toThrow("Extension worker start cancelled");

      expect(state.runtime).toBeNull();
      expect(state.runtimeReplacement).toBeNull();
      expect(state.startPromise).toBeNull();
      expect(state.stopRequested).toBe(true);
      expect(transportSpy).not.toHaveBeenCalled();
    } finally {
      releaseEntry?.("dist/backend.js");
      if (stop) await stop.catch(() => {});
      await start.catch(() => {});
      entryPathSpy.mockRestore();
      transportSpy.mockRestore();
      state.cleanup();
    }
  }, { timeout: 2_000 });
  test.serial("cancels a never-settling lookup before a later start", async () => {
    const generation = `stop-never-settling-entry-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    let lookupCount = 0;
    let releaseFirst: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockImplementation(() => {
      lookupCount += 1;
      if (lookupCount === 1) {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve("dist/backend.js");
    });
    const storagePathSpy = spyOn(managerSvc, "getStoragePath")
      .mockReturnValue("/tmp/stop-never-settling-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath")
      .mockReturnValue("/tmp/stop-never-settling-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport")
      .mockImplementation((options) => ({
        mode: "worker" as const,
        pid: null,
        postMessage(message: unknown) {
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (message.type === "init") {
            options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
          } else if (message.type === "shutdown") {
            options.onMessage({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
          }
        },
        terminate() {},
      }));
    const first = host.start();
    let second: Promise<void> | undefined;
    const state = host as unknown as WorkerHostStartLifecycleState;
    try {
      await Promise.resolve();
      expect(lookupCount).toBe(1);

      await host.stop();
      await expect(first).rejects.toThrow("Extension worker start cancelled");
      expect(state.startPromise).toBeNull();
      expect(state.runtimeReplacement).toBeNull();

      releaseFirst?.("dist/backend.js");
      second = host.start();
      await second;
      expect(lookupCount).toBe(2);
      expect(transportSpy).toHaveBeenCalledTimes(1);
      expect(state.runtime).not.toBeNull();

      await host.stop();
      expect(state.stopRequested).toBe(true);
      expect(state.runtime).toBeNull();
    } finally {
      releaseFirst?.("dist/backend.js");
      await first.catch(() => {});
      if (second) await second.catch(() => {});
      await host.stop().catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      state.cleanup();
    }
  }, { timeout: 2_000 });

  test.serial("aborts replacement and discards an over-limit incumbent callback buffer", async () => {
    const generation = `incumbent-buffer-overrun-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & { terminated: number }> = [];
    let releaseEntry: ((entryPath: string) => void) | undefined;
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath")
      .mockResolvedValueOnce("dist/backend.js")
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        releaseEntry = resolve;
      }));
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/incumbent-buffer-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/incumbent-buffer-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      const callbacks = {
        onMessage: options.onMessage,
        onError: options.onError,
        onExit: options.onExit,
        terminated: 0,
      };
      transports.push(callbacks);
      return {
        mode: "worker" as const,
        pid: null,
        postMessage(message: unknown) {
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (message.type === "init") {
            options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
          }
        },
        terminate() {
          callbacks.terminated += 1;
        },
      };
    });
    let replacement: Promise<void> | undefined;
    try {
      await host.start();
      replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(releaseEntry).toBeDefined();
      for (let index = 0; index < 257; index += 1) {
        transports[0]?.onMessage({
          type: "log",
          level: "info",
          message: `buffer-${index}`,
        });
      }
      const state = host as unknown as {
        runtimeReplacement: {
          incumbentMessages: unknown[];
          incumbentMessageBytes: number;
          incumbentBufferOverflow: Error | null;
        } | null;
      };
      expect(state.runtimeReplacement?.incumbentMessages).toHaveLength(0);
      expect(state.runtimeReplacement?.incumbentMessageBytes).toBe(0);
      expect(state.runtimeReplacement?.incumbentBufferOverflow).toBeInstanceOf(Error);
      releaseEntry?.("dist/backend.js");
      await expect(replacement).rejects.toThrow("callback buffer exceeded");
      replacement = undefined;
      expect(transports).toHaveLength(1);
      expect(transports[0]?.terminated).toBe(1);
    } finally {
      releaseEntry?.("dist/backend.js");
      if (replacement) await replacement.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
    }
  }, { timeout: 2_000 });

  test.serial("holds permission changes until a delayed replacement becomes ready", async () => {
    const generation = `permission-before-ready-${crypto.randomUUID()}`;
    const { host } = createStartFixture(generation);
    const transports: Array<FakeRuntimeTransportOptions & { messages: unknown[] }> = [];
    const entryPathSpy = spyOn(managerSvc, "getBackendEntryPath").mockResolvedValue("dist/backend.js");
    const storagePathSpy = spyOn(managerSvc, "getStoragePath").mockReturnValue("/tmp/permission-before-ready-storage");
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue("/tmp/permission-before-ready-repo");
    const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport").mockImplementation((options) => {
      const callbacks = {
        onMessage: options.onMessage,
        onError: options.onError,
        onExit: options.onExit,
        messages: [] as unknown[],
      };
      transports.push(callbacks);
      return {
        mode: "worker" as const,
        pid: null,
        postMessage(message: unknown) {
          callbacks.messages.push(message);
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (message.type === "init" && transports.length === 1) {
            options.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
          } else if (message.type === "shutdown") {
            options.onMessage({ type: "log", level: "info", message: "__worker_shutdown_ack__" });
          }
        },
        terminate() {},
      };
    });
    let replacement: Promise<void> | undefined;
    try {
      await host.start();
      replacement = host.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(transports).toHaveLength(2);
      host.notifyPermissionChanged("dynamic_code_execution", true, ["dynamic_code_execution"]);
      expect(transports[1]?.messages).not.toContainEqual({
        type: "permission_changed",
        extensionId: host.manifest.identifier,
        permission: "dynamic_code_execution",
        granted: true,
        allGranted: ["dynamic_code_execution"],
      });
      transports[1]?.onMessage({ type: "log", level: "info", message: "__worker_ready__" });
      await Promise.resolve();
      expect((host as unknown as { onWorkerReady: unknown }).onWorkerReady).toBeNull();
      await replacement;
      replacement = undefined;
      expect(transports[1]?.messages).toContainEqual({
        type: "permission_changed",
        extensionId: host.manifest.identifier,
        permission: "dynamic_code_execution",
        granted: true,
        allGranted: ["dynamic_code_execution"],
      });
      await host.stop();
    } finally {
      if (replacement) await replacement.catch(() => {});
      entryPathSpy.mockRestore();
      storagePathSpy.mockRestore();
      repoPathSpy.mockRestore();
      transportSpy.mockRestore();
      (host as unknown as { cleanup: () => void }).cleanup();
    }
  }, { timeout: 2_000 });

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
      const expectedReason = /(?:getBuiltinModule|binding)/.test(label)
        ? "blocked capabilities: dangerous process API usage"
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
  test("rejects every serialized dynamic-code execution form despite the declared capability", () => {
    const blockedBodies = [
      ["eval", `return eval("1 + 1");`],
      ["function-constructor", `return Function("return 1")();`],
      ["async-function-constructor", `return Object.getPrototypeOf(async function () {}).constructor("return 1")();`],
      ["generator-constructor", `return Object.getPrototypeOf(function* () {}).constructor("yield 1")();`],
      ["function-call", `return Function.call(null, "return 1")();`],
      ["function-apply", `return Function.apply(null, ["return 1"])();`],
      ["function-bind", `return Function.bind(null)("return 1")();`],
      ["function-computed-call", `return Function["call"](null, "return 1")();`],
      ["async-function-apply", `return Object.getPrototypeOf(async function () {}).constructor.apply(null, ["return 1"])();`],
      ["async-function-computed-call", `return Object.getPrototypeOf(async function () {}).constructor["call"](null, "return 1")();`],
      ["generator-function-bind", `return Object.getPrototypeOf(function* () {}).constructor.bind(null)("yield 1")();`],
      ["generator-function-computed-call", `return Object.getPrototypeOf(function* () {}).constructor["call"](null, "yield 1")();`],
      ["globalThis-function-constructor", `return globalThis["Function"]("return 1")();`],
      ["globalThis-function-computed-call", `return globalThis["Function"]["call"](null, "return 1")();`],
      ["globalThis-function-computed-bind", `return globalThis["Function"]["bind"](null)("return 1")();`],
      ["function-prototype-computed-constructor", `return Function.prototype["constructor"]("return 1")();`],
      ["async-function-bind", `return Object.getPrototypeOf(async function () {}).constructor.bind(null)("return 1")();`],
      ["generator-function-apply", `return Object.getPrototypeOf(function* () {}).constructor.apply(null, ["yield 1"])();`],
      ["eval-call", `return eval.call(null, "1 + 1");`],
      ["eval-apply", `return eval.apply(null, ["1 + 1"]);`],
      ["eval-bind", `return eval.bind(null)("1 + 1");`],
      ["computed-eval-call", `return eval["call"](null, "1 + 1");`],
    ] as const;

    for (const [label, handler] of blockedBodies) {
      const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost([
        "dynamic_code_execution",
      ]);
      const name = `dynamic-code-${label}-${owner.generation}`;
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
        expect(rejectionReasons, `${label}: ${handler}`).toEqual([
          "blocked capabilities: dynamic code execution",
        ]);
        expect(macroRegistry.getMacro(name)).toBeNull();
      } finally {
        macroRegistry.unregisterOwner(owner);
        macroRegistry.deactivateExtensionGeneration(owner);
      }
    }

    const { host, owner, messages, rejectionReasons } = createMacroRegistrationHost([
      "dynamic_code_execution",
    ]);
    const name = `dynamic-code-safe-${owner.generation}`;
    try {
      invokeHandleRegisterMacro(host, {
        registrationId: `${name}-registration`,
        name,
        handler: `return "not dynamic code";`,
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
  }, { timeout: 15_000 });

  test("keeps dynamic code blocked while honoring the base64 capability opt-in", () => {
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
          const accepted = item.capability === "base64_decode" && capabilities.length === 1;
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
  test.serial("rejects a deferred backend process spawn after runtime stop begins", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const originalForceBunWorkers = process.env.LUMIVERSE_FORCE_BUN_WORKERS;
    const timeoutDelays: number[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const postedMessages: unknown[] = [];
    const backendWorkerMessages: unknown[] = [];
    let backendWorkerCreated = 0;
    let backendWorkerTerminated = 0;
    let releaseEntry: ((entryPath: string) => void) | undefined;
    let entryResolutionStarted = false;
    let releaseShutdownAck: (() => void) | undefined;
    let stopPromise: Promise<void> | undefined;

    const controlledSetTimeout = ((callback: () => void, delay: number) => {
      timeoutDelays.push(delay);
      timeoutCallbacks.push(callback);
      return { callback, delay };
    }) as unknown as typeof globalThis.setTimeout;
    const controlledClearTimeout = ((_timer: unknown) => {
      // The test never advances the fallback timer; stop is released by ACK.
    }) as unknown as typeof globalThis.clearTimeout;

    class FakeBackendWorker {
      onmessage: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;

      constructor(_url: string, _options: unknown) {
        backendWorkerCreated += 1;
      }

      postMessage(message: unknown): void {
        backendWorkerMessages.push(message);
      }

      terminate(): void {
        backendWorkerTerminated += 1;
      }
    }

    const manifest = {
      version: "1.0.0",
      name: "Deferred Spawn Test",
      identifier: "deferred_spawn_test",
      author: "Lumiverse",
      github: "https://example.test/deferred-spawn",
      homepage: "https://example.test/deferred-spawn",
      permissions: [],
    } satisfies SpindleManifest;
    const extensionInfo = {
      id: "extension-db-id",
      identifier: manifest.identifier,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: "",
      github: manifest.github,
      homepage: manifest.homepage,
      permissions: [],
      granted_permissions: [],
      enabled: true,
      installed_at: 0,
      updated_at: 0,
      has_frontend: false,
      has_backend: true,
      status: "running",
      metadata: {},
    } satisfies ExtensionInfo;
    const host = new WorkerHost(
      extensionInfo.id,
      manifest,
      extensionInfo,
      "deferred-spawn-test-generation",
    );
    type DeferredSpawnHostState = {
      runtime: {
        mode: "worker";
        pid: null;
        terminate: (force?: boolean) => void;
      } | null;
      runtimeStopping: boolean;
      runtimeTransportToken: { epoch: number } | null;
      onWorkerShutdownAck: (() => void) | null;
      backendProcesses: Map<string, unknown>;
      backendProcessKeyIndex: Map<string, string>;
    };
    const state = host as unknown as DeferredSpawnHostState;
    const hostMethods = host as unknown as {
      postToWorker: (message: unknown) => void;
      resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
      getBackendProcessRuntimeMode: () => "worker";
      getStorageRootPath: () => string;
    };
    const entryResolution = new Promise<string>((resolve) => {
      releaseEntry = resolve;
    });

    try {
      process.env.LUMIVERSE_FORCE_BUN_WORKERS = "1";
      globalThis.setTimeout = controlledSetTimeout;
      globalThis.clearTimeout = controlledClearTimeout;
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        enumerable: originalWorkerDescriptor?.enumerable ?? true,
        writable: true,
        value: FakeBackendWorker,
      });

      state.runtime = {
        mode: "worker",
        pid: null,
        terminate() {},
      };
      state.runtimeStopping = false;
      state.runtimeTransportToken = { epoch: 1 };
      hostMethods.getBackendProcessRuntimeMode = () => "worker";
      hostMethods.getStorageRootPath = () => "/tmp/deferred-spawn-test-storage";
      hostMethods.resolveBackendProcessEntryPath = async () => {
        entryResolutionStarted = true;
        return entryResolution;
      };
      hostMethods.postToWorker = (message) => {
        postedMessages.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "shutdown"
        ) {
          releaseShutdownAck = state.onWorkerShutdownAck ?? undefined;
        }
      };

      const requestId = "deferred-backend-process-request";
      const spawnPromise = invokeHandleBackendProcessSpawn(host, requestId, {
        entry: "dist/deferred-backend.js",
        kind: "deferred-backend",
        key: "deferred-key",
        userId: "user-1",
      });
      await Promise.resolve();
      expect(entryResolutionStarted).toBe(true);

      stopPromise = WorkerHost.prototype.stop.call(host);
      expect(state.runtimeStopping).toBe(true);
      expect(releaseShutdownAck).not.toBeUndefined();

      releaseEntry?.("/tmp/deferred-backend.js");
      await spawnPromise;

      const messageType = (message: unknown): string | undefined => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          typeof message.type !== "string"
        ) {
          return undefined;
        }
        return message.type;
      };
      expect(postedMessages).toContainEqual({
        type: "response",
        requestId,
        error: "Extension worker runtime changed while resolving backend process entry",
      });
      expect(backendWorkerCreated).toBe(0);
      expect(backendWorkerTerminated).toBe(0);
      expect(backendWorkerMessages).toEqual([]);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(timeoutDelays).toEqual([5_000]);
      expect(postedMessages.filter((message) => messageType(message) === "backend_process_lifecycle")).toEqual([]);
      expect(backendWorkerMessages.filter((message) => messageType(message) === "init")).toEqual([]);

      releaseShutdownAck?.();
      await stopPromise;
      stopPromise = undefined;
      expect(state.runtime).toBeNull();
    } finally {
      releaseShutdownAck?.();
      timeoutCallbacks[0]?.();
      try {
        if (stopPromise) await stopPromise;
      } finally {
        if (originalWorkerDescriptor) {
          Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "Worker");
        }
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        if (originalForceBunWorkers === undefined) {
          delete process.env.LUMIVERSE_FORCE_BUN_WORKERS;
        } else {
          process.env.LUMIVERSE_FORCE_BUN_WORKERS = originalForceBunWorkers;
        }
      }
    }
  }, { timeout: 2_000 });
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
        exact: { args: Array.from({ length: 32 }, (_, index) => ({ name: `arg-${index}` })) },
        over: { args: Array.from({ length: 33 }, (_, index) => ({ name: `arg-over-${index}` })) },
        reason: "args exceed 32 entries",
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
        if (item.label === "args") {
          const catalogEntry = macroRegistry
            .getPublicCatalog(accepted.owner)
            .categories
            .flatMap((category) => category.macros)
            .find((macro) => macro.name === acceptedName);
          expect(catalogEntry?.args).toHaveLength(32);
        }
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
        expect(rejected.messages).toContainEqual({
          type: "event",
          event: "__macro_registration_result__",
          payload: {
            registrationId: `${rejectedName}-registration`,
            accepted: false,
          },
        });
        if (item.label === "args") {
          const leaked = macroRegistry
            .getPublicCatalog(rejected.owner)
            .categories
            .flatMap((category) => category.macros)
            .some((macro) => macro.name === rejectedName);
          expect(leaked).toBe(false);
        }
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
describe("WorkerHost process response direction", () => {
  type ProcessHostState = {
    runtime: {
      mode: "worker";
      pid: null;
      postMessage: (message: unknown) => void;
      terminate: () => void;
    } | null;
    runtimeStopping: boolean;
    runtimeTransportToken: { epoch: number } | null;
  };

  function createProcessHost(): { host: WorkerHost; messages: unknown[] } {
    const manifest = {
      version: "1.0.0",
      name: "Process Response Test",
      identifier: "process_response_test",
      author: "Lumiverse",
      github: "https://example.test/process-response",
      homepage: "https://example.test/process-response",
      permissions: [],
    } satisfies SpindleManifest;
    const extensionInfo = {
      id: "extension-process-response-test",
      identifier: manifest.identifier,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: "",
      github: manifest.github,
      homepage: manifest.homepage,
      permissions: [],
      granted_permissions: [],
      enabled: true,
      installed_at: 0,
      updated_at: 0,
      has_frontend: true,
      has_backend: true,
      status: "running",
      metadata: {},
    } satisfies ExtensionInfo;
    const host = new WorkerHost(
      extensionInfo.id,
      manifest,
      extensionInfo,
      "process-response-test-generation",
    );
    const messages: unknown[] = [];
    const state = host as unknown as ProcessHostState;
    state.runtime = {
      mode: "worker",
      pid: null,
      postMessage: (message) => messages.push(message),
      terminate: () => {},
    };
    state.runtimeStopping = false;
    state.runtimeTransportToken = { epoch: 1 };
    return { host, messages };
  }
  function responseFor(messages: unknown[], requestId: string): unknown {
    return messages.find((message) => {
      if (typeof message !== "object" || message === null) return false;
      if (!("type" in message) || message.type !== "response") return false;
      return "requestId" in message && message.requestId === requestId;
    });
  }

  test.serial("fails closed for malformed requested capabilities on backend process spawn", async () => {
    const malformedCapabilities: unknown[] = [
      "dynamic_code_execution",
      { includes: () => true },
    ];
    for (const malformed of malformedCapabilities) {
      const { host, messages } = createProcessHost();
      const manifest = (host as unknown as {
        manifest: { requested_capabilities?: unknown };
      }).manifest;
      manifest.requested_capabilities = malformed;
      const hostMethods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "worker";
      };
      hostMethods.resolveBackendProcessEntryPath = async () => "/tmp/malformed-capability.js";
      hostMethods.getStorageRootPath = () => "/tmp/malformed-capability-storage";
      hostMethods.getBackendProcessRuntimeMode = () => "worker";
      let initMessage: unknown;
      const transportSpy = spyOn(runtimeTransportSvc, "createRuntimeTransport")
        .mockImplementation((options) => ({
          mode: "worker" as const,
          pid: null,
          postMessage(message: unknown) {
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "init"
            ) {
              initMessage = message;
              options.onMessage({ type: "ready" });
            }
          },
          terminate() {},
        }));
      try {
        await invokeHandleBackendProcessSpawn(host, `malformed-capability-${crypto.randomUUID()}`, {
          entry: "dist/backend.js",
          kind: "malformed-capability",
          userId: "user-1",
        });
        if (
          typeof initMessage !== "object" ||
          initMessage === null ||
          !("process" in initMessage) ||
          typeof initMessage.process !== "object" ||
          initMessage.process === null ||
          !("allowDynamicCode" in initMessage.process)
        ) {
          throw new Error("backend process init payload was not captured");
        }
        expect(initMessage.process.allowDynamicCode).toBe(false);
      } finally {
        transportSpy.mockRestore();
        (host as unknown as { stopAllBackendProcesses: (reason: string) => void })
          .stopAllBackendProcesses("backend_unloaded");
        expect(messages.filter((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response",
        )).toHaveLength(1);
      }
    }
  });

  test.serial("rejects backend entries whose file or ancestor symlink escapes the extension repo", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worker-host-symlink-"));
    const previousDataDir = env.dataDir;
    const { host } = createProcessHost();
    const identifier = host.manifest.identifier;
    const repoPath = join(dataDir, "extensions", identifier, "repo");
    const outsideRoot = join(dataDir, "outside");
    const resolveEntry = (entry: string): Promise<string> =>
      (host as unknown as {
        resolveBackendProcessEntryPath: (value: string) => Promise<string>;
      }).resolveBackendProcessEntryPath.call(host, entry);
    const repoPathSpy = spyOn(managerSvc, "getRepoPath").mockReturnValue(repoPath);
    try {
      env.dataDir = dataDir;
      for (const kind of ["entry", "ancestor"] as const) {
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
        mkdirSync(join(repoPath, "dist"), { recursive: true });
        mkdirSync(outsideRoot, { recursive: true });

        if (kind === "entry") {
          const outsideEntry = join(outsideRoot, "backend.js");
          writeFileSync(outsideEntry, "export default 1;");
          symlinkSync(outsideEntry, join(repoPath, "dist", "backend.js"));
        } else {
          const outsideDist = join(outsideRoot, "dist");
          mkdirSync(outsideDist, { recursive: true });
          writeFileSync(join(outsideDist, "backend.js"), "export default 1;");
          rmSync(join(repoPath, "dist"), { recursive: true, force: true });
          symlinkSync(outsideDist, join(repoPath, "dist"));
        }

        const expectedError = kind === "ancestor"
          ? /Path traversal detected in entry_backend/i
          : /(?:Symlink escapes extension root|Path traversal detected) in entry_backend/i;
        await expect(resolveEntry("dist/backend.js")).rejects.toThrow(expectedError);
      }
    } finally {
      repoPathSpy.mockRestore();
      env.dataDir = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const MAX_MANAGED_PROCESS_BYTES = 262_144;
  const supportsResizableArrayBuffer = (() => {
    try {
      const buffer = new ArrayBuffer(1, { maxByteLength: MAX_MANAGED_PROCESS_BYTES + 1 });
      return buffer.resizable === true && buffer.maxByteLength === MAX_MANAGED_PROCESS_BYTES + 1;
    } catch {
      return false;
    }
  })();
  const supportsGrowableSharedArrayBuffer = (() => {
    try {
      const buffer = new SharedArrayBuffer(1, { maxByteLength: MAX_MANAGED_PROCESS_BYTES + 1 });
      return buffer.growable === true && buffer.maxByteLength === MAX_MANAGED_PROCESS_BYTES + 1;
    } catch {
      return false;
    }
  })();

  test.serial.skipIf(!supportsResizableArrayBuffer && !supportsGrowableSharedArrayBuffer)(
    "rejects tiny views whose resizable or growable backing maxByteLength exceeds the envelope before side effects",
    () => {
      const values: Array<{ name: string; value: unknown }> = [];
      if (supportsResizableArrayBuffer) {
        const backing = new ArrayBuffer(1, { maxByteLength: MAX_MANAGED_PROCESS_BYTES + 1 });
        values.push({ name: "resizable-typed-view", value: new Uint8Array(backing, 0, 1) });
      }
      if (supportsGrowableSharedArrayBuffer) {
        const backing = new SharedArrayBuffer(1, { maxByteLength: MAX_MANAGED_PROCESS_BYTES + 1 });
        values.push({ name: "growable-dataview", value: new DataView(backing, 0, 1) });
      }
      expect(values.length).toBeGreaterThan(0);

      for (const current of values) {
        const { host, messages } = createProcessHost();
        const state = host as unknown as {
          frontendProcesses: Map<string, unknown>;
          frontendProcessKeyIndex: Map<string, string>;
        };
        const originalEmit = eventBus.emit;
        const frontendEvents: unknown[] = [];
        eventBus.emit = ((event: EventType, payload: unknown) => {
          if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
        }) as typeof eventBus.emit;
        const requestId = `frontend-resizable-${current.name}`;
        try {
          invokeHandleMessageInScope(host, {
            type: "frontend_process_spawn",
            requestId,
            options: {
              kind: "resizable",
              key: current.name,
              userId: "user-1",
              payload: current.value,
            },
          });
          const response = responseFor(messages, requestId);
          if (typeof response !== "object" || response === null || !("error" in response)) {
            throw new Error(`${current.name} was not rejected`);
          }
          expect(response.error).toMatch(/spawn payload.*(bytes|binary|unsupported|plain object)/i);
          expect(frontendEvents).toHaveLength(0);
          expect(state.frontendProcesses.size).toBe(0);
          expect(state.frontendProcessKeyIndex.size).toBe(0);
        } finally {
          try {
            (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
              .stopAllFrontendProcesses("backend_unloaded");
            expect(state.frontendProcesses.size).toBe(0);
            expect(state.frontendProcessKeyIndex.size).toBe(0);
          } finally {
            eventBus.emit = originalEmit;
          }
        }
      }
    },
  );

  test.serial("rejects RegExp values without invoking hostile overrides", () => {
    const value = /needle/gim;
    let accessorCalls = 0;
    for (const key of [
      "source",
      "flags",
      "dotAll",
      "global",
      "hasIndices",
      "ignoreCase",
      "multiline",
      "sticky",
      "unicode",
      "unicodeSets",
    ] as const) {
      if (!Object.getOwnPropertyDescriptor(RegExp.prototype, key)) continue;
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: false,
        get: () => {
          accessorCalls += 1;
          throw new Error(`RegExp ${key} override must not run`);
        },
      });
    }
    const { host, messages } = createProcessHost();
    const state = host as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
    };
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-regexp-intrinsic",
        options: {
          kind: "regexp",
          key: "intrinsic",
          userId: "user-1",
          payload: value,
        },
      });
      const response = responseFor(messages, "frontend-regexp-intrinsic");
      if (typeof response !== "object" || response === null || !("error" in response)) {
        throw new Error("RegExp payload was not rejected");
      }
      expect(response.error).toMatch(/spawn payload.*(unsupported|clone|binary)/i);
      expect(accessorCalls).toBe(0);
      expect(frontendEvents).toHaveLength(0);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
    } finally {
      try {
        (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });

  test.serial("rejects AggregateError values before process admission", () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 31; depth += 1) deep = { next: deep };
    const cases: Array<{ name: string; value: unknown; reason: RegExp }> = [
      {
        name: "oversized-intrinsic-errors",
        value: new AggregateError(["e".repeat(MAX_MANAGED_PROCESS_BYTES + 1)], "outer"),
        reason: /spawn payload.*(bytes|depth|unsupported|plain object)/i,
      },
      {
        name: "deep-intrinsic-errors",
        value: new AggregateError([deep], "outer"),
        reason: /spawn payload.*(bytes|depth|unsupported|plain object)/i,
      },
      {
        name: "nested-intrinsic-errors",
        value: new AggregateError([new Error("inner"), { reason: "nested" }], "outer"),
        reason: /spawn payload.*(bytes|depth|unsupported|plain object)/i,
      },
    ];

    for (const current of cases) {
      const { host, messages } = createProcessHost();
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, unknown>;
      };
      const originalEmit = eventBus.emit;
      const frontendEvents: unknown[] = [];
      eventBus.emit = ((event: EventType, payload: unknown) => {
        if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
      }) as typeof eventBus.emit;
      const requestId = `frontend-aggregate-${current.name}`;
      try {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId,
          options: {
            kind: "aggregate",
            key: current.name,
            userId: "user-1",
            payload: current.value,
          },
        });
        const response = responseFor(messages, requestId);
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`${current.name} was not rejected`);
        }
        expect(response.error).toMatch(current.reason);
        expect(frontendEvents).toHaveLength(0);
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        try {
          (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
          expect(state.frontendProcesses.size).toBe(0);
          expect(state.frontendProcessKeyIndex.size).toBe(0);
        } finally {
          eventBus.emit = originalEmit;
        }
      }
    }
  });

  test.serial("checks depth before accepting a repeated object identity", () => {
    const shared = { value: "shared" };
    let tooDeep: unknown = shared;
    for (let depth = 0; depth < 32; depth += 1) tooDeep = { next: tooDeep };
    const payload = { shallow: shared, deep: tooDeep };
    const { host, messages } = createProcessHost();
    const state = host as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
    };
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, emittedPayload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(emittedPayload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-seen-depth",
        options: {
          kind: "seen-depth",
          key: "seen-depth",
          userId: "user-1",
          payload,
        },
      });
      const response = responseFor(messages, "frontend-seen-depth");
      if (typeof response !== "object" || response === null || !("error" in response)) {
        throw new Error("deep repeated identity was not rejected");
      }
      expect(response.error).toMatch(/spawn payload.*depth/i);
      expect(frontendEvents).toHaveLength(0);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
    } finally {
      try {
        (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });

  test.serial("rejects symbol-keyed properties before invoking accessors", () => {
    const payload: Record<string, unknown> = { visible: "ok" };
    let accessorCalls = 0;
    Object.defineProperty(payload, Symbol("hidden-symbol"), {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        throw new Error("symbol accessor must not run");
      },
    });
    Object.defineProperty(payload, "hidden-bytes", {
      enumerable: false,
      value: "h".repeat(MAX_MANAGED_PROCESS_BYTES + 1),
    });
    Object.defineProperty(payload, "hidden-accessor", {
      enumerable: false,
      get: () => {
        accessorCalls += 1;
        throw new Error("non-enumerable accessor must not run");
      },
    });
    const inheritedGetterKey = `__managedProcessInheritedGetter_${crypto.randomUUID()}`;
    const inheritedBytesKey = `__managedProcessInheritedBytes_${crypto.randomUUID()}`;
    const originalInheritedGetter = Object.getOwnPropertyDescriptor(Object.prototype, inheritedGetterKey);
    const originalInheritedBytes = Object.getOwnPropertyDescriptor(Object.prototype, inheritedBytesKey);
    let inheritedGetterInstalled = false;
    let inheritedBytesInstalled = false;
    try {
      Object.defineProperty(Object.prototype, inheritedGetterKey, {
        configurable: true,
        enumerable: true,
        get: () => {
          accessorCalls += 1;
          throw new Error("inherited enumerable accessor must not run");
        },
      });
      inheritedGetterInstalled = true;
      Object.defineProperty(Object.prototype, inheritedBytesKey, {
        configurable: true,
        enumerable: true,
        value: "p".repeat(MAX_MANAGED_PROCESS_BYTES + 1),
      });
      inheritedBytesInstalled = true;
      const { host, messages } = createProcessHost();
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      const originalEmit = eventBus.emit;
      const frontendEvents: unknown[] = [];
      eventBus.emit = ((event: EventType, emittedPayload: unknown) => {
        if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(emittedPayload);
      }) as typeof eventBus.emit;
      try {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: "frontend-hidden-properties",
          options: {
            kind: "hidden-properties",
            key: "hidden-properties",
            userId: "user-1",
            payload,
          },
        });
        const response = responseFor(messages, "frontend-hidden-properties");
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error("symbol-keyed payload was not rejected");
        }
        expect(response.error).toMatch(/symbol-keyed/i);
        expect(accessorCalls).toBe(0);
        expect(frontendEvents).toHaveLength(0);
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        try {
          (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
          expect(state.frontendProcesses.size).toBe(0);
          expect(state.frontendProcessKeyIndex.size).toBe(0);
        } finally {
          eventBus.emit = originalEmit;
        }
      }
    } finally {
      if (inheritedGetterInstalled) {
        if (originalInheritedGetter) {
          Object.defineProperty(Object.prototype, inheritedGetterKey, originalInheritedGetter);
        } else {
          Reflect.deleteProperty(Object.prototype, inheritedGetterKey);
        }
      }
      if (inheritedBytesInstalled) {
        if (originalInheritedBytes) {
          Object.defineProperty(Object.prototype, inheritedBytesKey, originalInheritedBytes);
        } else {
          Reflect.deleteProperty(Object.prototype, inheritedBytesKey);
        }
      }
    }
  });

  test("settles a pre-ready backend failure exactly once on the worker response channel", async () => {
    const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const { host, messages } = createProcessHost();
    const hostMethods = host as unknown as {
      resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
      getStorageRootPath: () => string;
      getBackendProcessRuntimeMode: () => "worker";
    };
    const state = host as unknown as {
      backendProcesses: Map<string, { startupTimer: unknown; heartbeatTimer: unknown; stopTimer: unknown }>;
      backendProcessKeyIndex: Map<string, string>;
    };

    class FailingBackendWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;

      constructor(_url: string, _options: unknown) {}

      postMessage(message: unknown): void {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== "init"
        ) {
          return;
        }
        const failure = { type: "fail", error: "backend failed before ready" };
        this.onmessage?.({ data: failure });
        this.onmessage?.({ data: failure });
      }

      terminate(): void {}
    }

    try {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        enumerable: originalWorkerDescriptor?.enumerable ?? true,
        writable: true,
        value: FailingBackendWorker,
      });
      hostMethods.resolveBackendProcessEntryPath = async () => "/tmp/backend-response-test.js";
      hostMethods.getStorageRootPath = () => "/tmp/process-response-test-storage";
      hostMethods.getBackendProcessRuntimeMode = () => "worker";

      const requestId = "backend-pre-ready-failure";
      await invokeHandleBackendProcessSpawn(host, requestId, {
        entry: "dist/backend.js",
        kind: "backend-response-test",
        userId: "user-1",
      });

      expect(
        messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "response",
        ),
      ).toEqual([
        {
          type: "response",
          requestId,
          error: "backend failed before ready",
        },
      ]);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
    } finally {
      try {
        (host as unknown as { stopAllBackendProcesses: (reason: string) => void })
          .stopAllBackendProcesses("backend_unloaded");
        expect(state.backendProcesses.size).toBe(0);
        expect(state.backendProcessKeyIndex.size).toBe(0);
      } finally {
        if (originalWorkerDescriptor) {
          Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "Worker");
        }
      }
    }
  });

  test.serial("force cleanup emits one terminal transition and ignores late frontend events", () => {
    const { host, messages } = createProcessHost();
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-force-cleanup",
        options: { kind: "frontend-force-cleanup", userId: "user-1" },
      });
      const spawnPayload = frontendEvents.find(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          payload.action === "spawn",
      );
      if (
        typeof spawnPayload !== "object" ||
        spawnPayload === null ||
        !("processId" in spawnPayload) ||
        typeof spawnPayload.processId !== "string"
      ) {
        throw new Error("force cleanup spawn did not include a process id");
      }
      const processId = spawnPayload.processId;
      const stopAllFrontendProcesses = (
        host as unknown as { stopAllFrontendProcesses: (reason: "backend_unloaded") => void }
      ).stopAllFrontendProcesses;
      stopAllFrontendProcesses.call(host, "backend_unloaded");
      stopAllFrontendProcesses.call(host, "backend_unloaded");
      host.handleFrontendProcessEvent(processId, "user-1", "ready");
      host.handleFrontendProcessEvent(processId, "user-1", "frontend_unloaded");

      const terminalTransitions = messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "frontend_process_lifecycle" &&
          "event" in message &&
          typeof message.event === "object" &&
          message.event !== null &&
          "processId" in message.event &&
          message.event.processId === processId &&
          "state" in message.event &&
          message.event.state === "stopped",
      );
      expect(terminalTransitions).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "response" &&
            "requestId" in message &&
            message.requestId === "frontend-force-cleanup",
        ),
      ).toHaveLength(1);
      expect(
        frontendEvents.filter(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            "action" in payload &&
            payload.action === "stop",
        ),
      ).toHaveLength(1);
    } finally {
      eventBus.emit = originalEmit;
    }
  });

  test("settles a pre-ready frontend failure exactly once on the worker response channel", async () => {
    const { host, messages } = createProcessHost();
    const state = host as unknown as {
      frontendProcesses: Map<string, { startupTimer: unknown; heartbeatTimer: unknown; stopTimer: unknown }>;
      frontendProcessKeyIndex: Map<string, string>;
    };
    let unsubscribe = () => {};
    const spawnEvent = new Promise<{ processId: string }>((resolve) => {
      unsubscribe = eventBus.on(EventType.SPINDLE_FRONTEND_PROCESS, (message) => {
        const payload = message.payload;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          payload.action === "spawn" &&
          "processId" in payload &&
          typeof payload.processId === "string"
        ) {
          resolve({ processId: payload.processId });
        }
      });
    });

    try {
      const requestId = "frontend-pre-ready-failure";
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId,
        options: {
          kind: "frontend-response-test",
          userId: "user-1",
        },
      });
      const { processId } = await spawnEvent;
      const failure = "frontend failed before ready";
      host.handleFrontendProcessEvent(processId, "user-1", "fail", failure);
      host.handleFrontendProcessEvent(processId, "user-1", "fail", failure);
      host.handleFrontendProcessEvent(processId, "user-1", "ready");

      expect(
        messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "response",
        ),
      ).toEqual([
        {
          type: "response",
          requestId,
          error: failure,
        },
      ]);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
    } finally {
      try {
        (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        unsubscribe();
      }
    }
  });
  test.serial("force-stops a starting frontend process when the browser never acknowledges stop", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalEmit = eventBus.emit;
    const timers: Array<{
      callback: () => void;
      delay: number;
      cleared: boolean;
    }> = [];
    const controlledSetTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    const controlledClearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];

    globalThis.setTimeout = controlledSetTimeout;
    globalThis.clearTimeout = controlledClearTimeout;
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) {
        frontendEvents.push({ payload, userId });
      }
    }) as typeof eventBus.emit;

    try {
      const { host, messages } = createProcessHost();
      const state = host as unknown as {
        frontendProcesses: Map<string, { state: string }>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      const spawnRequestId = "frontend-stop-watchdog-spawn";
      const key = "frontend-stop-watchdog-key";

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: spawnRequestId,
        options: {
          kind: "frontend-stop-watchdog",
          key,
          userId: "user-1",
          startupTimeoutMs: 15_000,
        },
      });

      const spawnEvent = frontendEvents.find(
        ({ payload }) =>
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          payload.action === "spawn",
      );
      const processId =
        typeof spawnEvent?.payload === "object" &&
        spawnEvent.payload !== null &&
        "processId" in spawnEvent.payload &&
        typeof spawnEvent.payload.processId === "string"
          ? spawnEvent.payload.processId
          : undefined;
      expect(processId).toBeString();
      if (!processId) throw new Error("frontend spawn event did not include a process id");
      expect(state.frontendProcesses.get(processId)?.state).toBe("starting");
      expect(state.frontendProcessKeyIndex.get("user-1:frontend-stop-watchdog:frontend-stop-watchdog-key")).toBe(processId);

      const stopRequestId = "frontend-stop-watchdog-stop";
      invokeHandleMessageInScope(host, {
        type: "frontend_process_stop",
        requestId: stopRequestId,
        processId,
        options: { userId: "user-1", reason: "test-stop" },
      });

      const stopEvent = frontendEvents.find(
        ({ payload }) =>
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          payload.action === "stop",
      );
      expect(stopEvent?.payload).toEqual({
        extensionId: "extension-process-response-test",
        identifier: "process_response_test",
        action: "stop",
        processId,
        reason: "test-stop",
      });
      expect(messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === stopRequestId,
      )).toEqual([
        { type: "response", requestId: stopRequestId, result: undefined },
      ]);
      expect(messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === spawnRequestId,
      )).toEqual([]);
      expect(state.frontendProcesses.get(processId)?.state).toBe("stopping");

      const stopTimers = timers.filter((timer) => timer.delay === 5_000);
      expect(stopTimers).toHaveLength(1);
      expect(stopTimers[0]?.cleared).toBe(false);
      const timerCountBeforeLateHeartbeat = timers.length;
      host.handleFrontendProcessEvent(processId, "user-1", "heartbeat");
      expect(timers).toHaveLength(timerCountBeforeLateHeartbeat);
      const activeTimers = timers.filter((timer) => !timer.cleared);
      expect(activeTimers).toHaveLength(1);
      expect(activeTimers[0]).toBe(stopTimers[0]);
      expect(state.frontendProcesses.get(processId)?.state).toBe("stopping");
      stopTimers[0]?.callback();
      expect(stopTimers[0]?.cleared).toBe(true);
      stopTimers[0]?.callback();
      expect(frontendEvents.filter(
        ({ payload }) =>
          typeof payload === "object" &&
          payload !== null &&
          "action" in payload &&
          payload.action === "stop",
      ).map(({ payload, userId }) => ({ payload, userId }))).toEqual([
        {
          payload: {
            extensionId: "extension-process-response-test",
            identifier: "process_response_test",
            action: "stop",
            processId,
            reason: "test-stop",
          },
          userId: "user-1",
        },
        {
          payload: {
            extensionId: "extension-process-response-test",
            identifier: "process_response_test",
            action: "stop",
            processId,
            reason: "Frontend process force-stopped after stop timeout",
            force: true,
          },
          userId: "user-1",
        },
      ]);

      const terminalLifecycleEvents = () =>
        messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "frontend_process_lifecycle" &&
            "event" in message &&
            typeof message.event === "object" &&
            message.event !== null &&
            "processId" in message.event &&
            message.event.processId === processId &&
            "state" in message.event &&
            message.event.state === "stopped",
        );
      expect(terminalLifecycleEvents()).toEqual([
        expect.objectContaining({
          type: "frontend_process_lifecycle",
          event: expect.objectContaining({
            processId,
            state: "stopped",
            previousState: "stopping",
            exitReason: "stopped",
            error: "Frontend process force-stopped after stop timeout",
          }),
        }),
      ]);

      const spawnResponses = () =>
        messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "response" &&
            "requestId" in message &&
            message.requestId === spawnRequestId,
        );
      expect(spawnResponses()).toEqual([
        {
          type: "response",
          requestId: spawnRequestId,
          error: "Frontend process force-stopped after stop timeout",
        },
      ]);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
      expect(state.frontendProcesses.get(processId)).toBeUndefined();

      host.handleFrontendProcessEvent(processId, "user-1", "ready");
      host.handleFrontendProcessEvent(processId, "user-1", "frontend_unloaded");
      expect(spawnResponses()).toHaveLength(1);
      expect(messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === stopRequestId,
      )).toEqual([
        { type: "response", requestId: stopRequestId, result: undefined },
      ]);
    } finally {
      try {
        expect(timers.every((timer) => timer.cleared)).toBe(true);
      } finally {
        eventBus.emit = originalEmit;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });
  test.serial("force-evicts a frontend process on startup timeout without orphaning its response", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalEmit = eventBus.emit;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const state = host as unknown as {
        frontendProcesses: Map<string, { state: string }>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      const requestId = "frontend-startup-timeout";
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId,
        options: {
          kind: "startup-timeout",
          key: "timeout-key",
          userId: "user-1",
          startupTimeoutMs: 1_000,
        },
      });
      const spawnPayload = frontendEvents.find(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )?.payload;
      if (typeof spawnPayload !== "object" || spawnPayload === null || !("processId" in spawnPayload)) {
        throw new Error("frontend startup timeout spawn event did not include a process id");
      }
      const processId = spawnPayload.processId;
      if (typeof processId !== "string") throw new Error("frontend startup timeout process id was not a string");
      const startupTimer = timers.find((timer) => timer.delay === 1_000);
      expect(startupTimer?.cleared).toBe(false);
      expect(startupTimer).toBeDefined();
      startupTimer?.callback();
      expect(startupTimer?.cleared).toBe(true);

      const stopEvents = frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "stop",
      );
      expect(stopEvents).toEqual([{
        payload: {
          extensionId: "extension-process-response-test",
          identifier: "process_response_test",
          action: "stop",
          processId,
          reason: "timed_out",
          force: true,
        },
        userId: "user-1",
      }]);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === requestId,
      )).toEqual([{
        type: "response",
        requestId,
        error: "Frontend process startup timed out",
      }]);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);

      host.handleFrontendProcessEvent(processId, "user-1", "ready");
      host.handleFrontendProcessEvent(processId, "user-1", "frontend_unloaded");
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === requestId,
      )).toHaveLength(1);
    } finally {
      try {
        if (cleanupHost) {
          (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
        }
        expect(timers.every((timer) => timer.cleared)).toBe(true);
      } finally {
        eventBus.emit = originalEmit;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("re-arms frontend and backend startup watchdogs across a long replacement", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    try {
      const { host } = createProcessHost();
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        backendProcesses: Map<string, unknown>;
        runtimeReplacement: unknown;
        runtimeTransportToken: unknown;
      };
      const token = { epoch: 2 };
      state.runtimeTransportToken = token;
      state.runtimeReplacement = {
        provisionalToken: token,
        provisionalRuntime: null,
        incumbentToken: { epoch: 1 },
        incumbentExit: null,
        incumbentError: null,
        incumbentBufferOverflow: null,
        incumbentShutdownAck: false,
        incumbentMessages: [],
        incumbentMessageBytes: 0,
      };
      const frontendRecord = {
        requestId: "watchdog-frontend",
        spawnResponseSettled: false,
        processId: "watchdog-frontend-process",
        kind: "watchdog-frontend",
        state: "starting" as const,
        userId: "user-1",
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        stopTimer: null,
        startupTimeoutMs: 1_000,
        heartbeatTimeoutMs: 0,
      };
      const backendRecord = {
        requestId: "watchdog-backend",
        spawnResponseSettled: false,
        processId: "watchdog-backend-process",
        entry: "dist/backend.js",
        kind: "watchdog-backend",
        state: "starting" as const,
        userId: "user-1",
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        stopTimer: null,
        startupTimeoutMs: 1_000,
        heartbeatTimeoutMs: 0,
        runtime: {
          mode: "worker" as const,
          pid: null,
          postMessage() {},
          terminate() {},
        },
      };
      state.frontendProcesses.set(frontendRecord.processId, frontendRecord);
      state.backendProcesses.set(backendRecord.processId, backendRecord);
      const methods = host as unknown as {
        armFrontendStartupTimer: (record: typeof frontendRecord) => void;
        armBackendStartupTimer: (record: typeof backendRecord) => void;
      };
      methods.armFrontendStartupTimer(frontendRecord);
      methods.armBackendStartupTimer(backendRecord);
      expect(timers).toHaveLength(2);
      timers[0]?.callback();
      timers[1]?.callback();
      expect(timers).toHaveLength(4);
      expect(timers[0]?.cleared).toBe(true);
      expect(timers[1]?.cleared).toBe(true);
      state.runtimeReplacement = null;
      timers[2]?.callback();
      timers[3]?.callback();
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.backendProcesses.size).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test.serial("force-evicts the old keyed frontend process before admitting its replacement", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalEmit = eventBus.emit;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const state = host as unknown as {
        frontendProcesses: Map<string, { state: string }>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      const spawn = (requestId: string, replaceExisting = false) => {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId,
          options: {
            kind: "keyed-replacement",
            key: "shared-key",
            userId: "user-1",
            replaceExisting,
          },
        });
      };
      spawn("frontend-keyed-first");
      const firstStartupTimer = timers[0];
      expect(firstStartupTimer?.cleared).toBe(false);
      const firstSpawn = frontendEvents.find(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )?.payload;
      if (typeof firstSpawn !== "object" || firstSpawn === null || !("processId" in firstSpawn)) {
        throw new Error("first keyed frontend spawn event did not include a process id");
      }
      const firstProcessId = firstSpawn.processId;
      if (typeof firstProcessId !== "string") throw new Error("first keyed process id was not a string");

      spawn("frontend-keyed-replacement", true);
      const spawnEvents = frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      const replacementPayload = spawnEvents[1]?.payload;
      if (typeof replacementPayload !== "object" || replacementPayload === null || !("processId" in replacementPayload)) {
        throw new Error("replacement frontend spawn event did not include a process id");
      }
      expect(firstStartupTimer?.cleared).toBe(true);
      const replacementProcessId = replacementPayload.processId;
      if (typeof replacementProcessId !== "string") throw new Error("replacement process id was not a string");

      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "stop",
      )).toEqual([{
        payload: {
          extensionId: "extension-process-response-test",
          identifier: "process_response_test",
          action: "stop",
          processId: firstProcessId,
          reason: "replaced",
          force: true,
        },
        userId: "user-1",
      }]);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-keyed-first",
      )).toEqual([{
        type: "response",
        requestId: "frontend-keyed-first",
        error: "Frontend process was replaced before it became ready",
      }]);
      expect(state.frontendProcessKeyIndex.get("user-1:keyed-replacement:shared-key")).toBe(replacementProcessId);
      expect(state.frontendProcesses.get(firstProcessId)).toBeUndefined();
      expect(state.frontendProcesses.get(replacementProcessId)?.state).toBe("starting");

      host.handleFrontendProcessEvent(firstProcessId, "user-1", "ready");
      host.handleFrontendProcessEvent(firstProcessId, "user-1", "frontend_unloaded");
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-keyed-first",
      )).toHaveLength(1);
      if (cleanupHost) {
        (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
      }
    } finally {
      try {
        if (cleanupHost) {
          (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
        }
        expect(timers.every((timer) => timer.cleared)).toBe(true);
      } finally {
        eventBus.emit = originalEmit;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("force-cleans all frontend processes without orphaning startup responses", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalEmit = eventBus.emit;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;
    let cleanupHost: WorkerHost | null = null;
    let cleanupState: {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
    } | null = null;

    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      cleanupState = state;
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-cleanup",
        options: { kind: "cleanup", key: "cleanup-key", userId: "user-1" },
      });
      const spawnPayload = frontendEvents.find(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )?.payload;
      if (typeof spawnPayload !== "object" || spawnPayload === null || !("processId" in spawnPayload)) {
        throw new Error("cleanup spawn event did not include a process id");
      }
      const processId = spawnPayload.processId;
      if (typeof processId !== "string") throw new Error("cleanup process id was not a string");

      const stopAll = (host as unknown as {
        stopAllFrontendProcesses: (reason: string) => void;
      }).stopAllFrontendProcesses;
      stopAll.call(host, "backend_unloaded");

      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "stop",
      )).toEqual([{
        payload: {
          extensionId: "extension-process-response-test",
          identifier: "process_response_test",
          action: "stop",
          processId,
          reason: "backend_unloaded",
          force: true,
        },
        userId: "user-1",
      }]);
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-cleanup",
      )).toEqual([{
        type: "response",
        requestId: "frontend-cleanup",
        error: "Frontend process stopped because the extension worker backend unloaded before it became ready",
      }]);
      host.handleFrontendProcessEvent(processId, "user-1", "ready");
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-cleanup",
      )).toHaveLength(1);
    } finally {
      try {
        if (cleanupHost) {
          (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
        }
        expect(cleanupState?.frontendProcesses.size ?? 0).toBe(0);
        expect(cleanupState?.frontendProcessKeyIndex.size ?? 0).toBe(0);
        expect(timers).toHaveLength(1);
        expect(timers.every((timer) => timer.cleared)).toBe(true);
      } finally {
        eventBus.emit = originalEmit;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("admits sixteen frontend processes, rejects the seventeenth, and replaces at capacity", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalEmit = eventBus.emit;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      for (let index = 0; index < 16; index += 1) {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-cap-${index}`,
          options: {
            kind: "capacity",
            key: `capacity-${index}`,
            userId: "user-1",
          },
        });
      }
      expect(state.frontendProcesses.size).toBe(16);
      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )).toHaveLength(16);
      const firstStartupTimer = timers[0];
      expect(firstStartupTimer?.cleared).toBe(false);
      const timerCountAtCapacity = timers.length;
      const eventCountAtCapacity = frontendEvents.length;

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-cap-overflow",
        options: { kind: "capacity-overflow", userId: "user-1" },
      });
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-cap-overflow",
      )).toEqual([{
        type: "response",
        requestId: "frontend-cap-overflow",
        error: "Frontend process limit reached (16)",
      }]);
      expect(state.frontendProcesses.size).toBe(16);
      expect(timers).toHaveLength(timerCountAtCapacity);
      expect(frontendEvents).toHaveLength(eventCountAtCapacity);

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-cap-replacement",
        options: {
          kind: "capacity",
          key: "capacity-0",
          userId: "user-1",
          replaceExisting: true,
        },
      });
      expect(state.frontendProcesses.size).toBe(16);
      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )).toHaveLength(17);
      expect(firstStartupTimer?.cleared).toBe(true);
      expect(frontendEvents).toHaveLength(18);
      expect(state.frontendProcessKeyIndex.size).toBe(16);
      const replacementId = state.frontendProcessKeyIndex.get("user-1:capacity:capacity-0");
      expect(replacementId).toBeString();
      if (typeof replacementId !== "string") throw new Error("capacity replacement key did not resolve");
      expect(state.frontendProcesses.has(replacementId)).toBe(true);
      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "stop",
      )).toHaveLength(1);
      expect(frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "stop",
      )[0]?.payload).toEqual(expect.objectContaining({
        reason: "replaced",
        force: true,
      }));
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-cap-0",
      )).toHaveLength(1);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(2);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-cap-replacement",
      )).toHaveLength(0);
      if (cleanupHost) {
        (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
      }
    } finally {
      try {
        if (cleanupHost) {
          (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
        }
        expect(timers.every((timer) => timer.cleared)).toBe(true);
      } finally {
        eventBus.emit = originalEmit;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("admits sixteen backend processes, rejects a distinct seventeenth, and replaces at capacity", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend capacity test could not capture Bun.spawn");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    let terminateCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill(_signal?: unknown) {
        terminateCalls += 1;
      },
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const methods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        stopAllBackendProcesses: (reason: string) => void;
      };
      methods.resolveBackendProcessEntryPath = async () => "/tmp/backend-capacity.js";
      methods.getStorageRootPath = () => "/tmp/backend-capacity-storage";
      methods.getBackendProcessRuntimeMode = () => "process";
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      for (let index = 0; index < 16; index += 1) {
        await invokeHandleBackendProcessSpawn(host, `backend-cap-${index}`, {
          entry: "dist/backend.js",
          kind: "capacity",
          key: `capacity-${index}`,
          userId: "user-1",
        });
      }
      expect(state.backendProcesses.size).toBe(16);
      expect(state.backendProcessKeyIndex.size).toBe(16);
      expect(spawnCalls).toBe(16);
      expect(sentToRuntime).toHaveLength(16);
      expect(timers).toHaveLength(16);
      const firstProcessId = state.backendProcessKeyIndex.get("user-1:capacity:capacity-0");
      expect(firstProcessId).toBeString();
      const timerCountAtCapacity = timers.length;
      const lifecycleCountAtCapacity = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      ).length;

      await invokeHandleBackendProcessSpawn(host, "backend-cap-overflow", {
        entry: "dist/backend.js",
        kind: "overflow",
        userId: "user-1",
      });
      expect(responseFor(messages, "backend-cap-overflow")).toEqual({
        type: "response",
        requestId: "backend-cap-overflow",
        error: "Backend process limit reached (16)",
      });
      expect(state.backendProcesses.size).toBe(16);
      expect(state.backendProcessKeyIndex.size).toBe(16);
      expect(spawnCalls).toBe(16);
      expect(sentToRuntime).toHaveLength(16);
      expect(timers).toHaveLength(timerCountAtCapacity);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      )).toHaveLength(lifecycleCountAtCapacity);

      await invokeHandleBackendProcessSpawn(host, "backend-cap-replacement", {
        entry: "dist/backend.js",
        kind: "capacity",
        key: "capacity-0",
        userId: "user-1",
        replaceExisting: true,
      });
      const replacementId = state.backendProcessKeyIndex.get("user-1:capacity:capacity-0");
      expect(replacementId).toBeString();
      expect(replacementId).not.toBe(firstProcessId);
      expect(state.backendProcesses.size).toBe(16);
      expect(state.backendProcessKeyIndex.size).toBe(16);
      expect(spawnCalls).toBe(17);
      expect(sentToRuntime).toHaveLength(17);
      expect(terminateCalls).toBe(1);
      expect(timers).toHaveLength(17);
      expect(timers[0]?.cleared).toBe(true);
      expect(timers.filter((timer) => !timer.cleared)).toHaveLength(16);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      )).toHaveLength(lifecycleCountAtCapacity + 2);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "backend-cap-0",
      )).toHaveLength(1);
      expect(responseFor(messages, "backend-cap-replacement")).toBeUndefined();
    } finally {
      try {
        (cleanupHost as unknown as { stopAllBackendProcesses: (reason: string) => void } | null)
          ?.stopAllBackendProcesses("backend_unloaded");
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("force-terminates a backend child that ignores stop, finalizes once, and reclaims its slot", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend watchdog test could not capture Bun.spawn");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const sentToRuntime: unknown[] = [];
    const killSignals: unknown[] = [];
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill(signal?: unknown) {
        killSignals.push(signal);
      },
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => fakeRuntime,
    });
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const methods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        handleBackendProcessStop: (
          requestId: string,
          processId: string,
          options?: { userId?: string; reason?: string },
        ) => void;
        handleBackendProcessRuntimeMessage: (processId: string, message: unknown) => void;
        stopAllBackendProcesses: (reason: string) => void;
      };
      methods.resolveBackendProcessEntryPath = async () => "/tmp/backend-watchdog.js";
      methods.getStorageRootPath = () => "/tmp/backend-watchdog-storage";
      methods.getBackendProcessRuntimeMode = () => "process";
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };

      await invokeHandleBackendProcessSpawn(host, "backend-watchdog-spawn", {
        entry: "dist/backend.js",
        kind: "watchdog",
        key: "watchdog",
        userId: "user-1",
      });
      const processId = Array.from(state.backendProcesses.keys())[0];
      if (typeof processId !== "string") throw new Error("watchdog process id was not created");
      methods.handleBackendProcessStop("backend-watchdog-stop", processId, {
        userId: "user-1",
        reason: "test watchdog",
      });
      const stopTimer = timers.find((timer) => timer.delay === 5_000);
      expect(stopTimer).toBeDefined();
      expect(state.backendProcesses.get(processId)).toEqual(expect.objectContaining({ state: "stopping" }));
      expect(sentToRuntime.at(-1)).toEqual({ type: "stop", reason: "test watchdog" });
      stopTimer?.callback();
      expect(stopTimer?.cleared).toBe(true);
      expect(killSignals).toEqual(["SIGKILL"]);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(responseFor(messages, "backend-watchdog-stop")).toEqual({
        type: "response",
        requestId: "backend-watchdog-stop",
        result: undefined,
      });
      expect(responseFor(messages, "backend-watchdog-spawn")).toEqual({
        type: "response",
        requestId: "backend-watchdog-spawn",
        error: "Backend process force-stopped after stop timeout",
      });
      const lifecycleAfterWatchdog = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      );
      expect(lifecycleAfterWatchdog).toHaveLength(3);
      expect(lifecycleAfterWatchdog.at(-1)).toEqual(expect.objectContaining({
        type: "backend_process_lifecycle",
        event: expect.objectContaining({
          state: "stopped",
          previousState: "stopping",
          exitReason: "stopped",
          error: "Backend process force-stopped after stop timeout",
        }),
      }));
      stopTimer?.callback();
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      )).toHaveLength(3);

      await invokeHandleBackendProcessSpawn(host, "backend-watchdog-reclaimed", {
        entry: "dist/backend.js",
        kind: "reclaimed",
        key: "reclaimed",
        userId: "user-1",
      });
      expect(state.backendProcesses.size).toBe(1);
      expect(state.backendProcessKeyIndex.size).toBe(1);
      const replacementProcessId = Array.from(state.backendProcesses.keys())[0];
      if (typeof replacementProcessId !== "string") throw new Error("reclaimed process id was not created");
      methods.handleBackendProcessStop("backend-normal-stop", replacementProcessId, {
        userId: "user-1",
      });
      const normalStopTimer = timers.find((timer) => timer.delay === 5_000 && !timer.cleared);
      expect(normalStopTimer).toBeDefined();
      methods.handleBackendProcessRuntimeMessage(replacementProcessId, { type: "stopped" });
      expect(normalStopTimer?.cleared).toBe(true);
      expect(state.backendProcesses.size).toBe(0);
      expect(killSignals).toEqual(["SIGKILL"]);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      )).toHaveLength(6);
      normalStopTimer?.callback();
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      )).toHaveLength(6);
      expect(responseFor(messages, "backend-normal-stop")).toEqual({
        type: "response",
        requestId: "backend-normal-stop",
        result: undefined,
      });
    } finally {
      try {
        (cleanupHost as unknown as { stopAllBackendProcesses: (reason: string) => void } | null)
          ?.stopAllBackendProcesses("backend_unloaded");
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("finalizes a backend process fail-closed when the stop transport rejects", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend stop failure test could not capture Bun.spawn");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const sentToRuntime: unknown[] = [];
    const killSignals: unknown[] = [];
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "stop"
        ) {
          throw new Error("stop channel closed");
        }
      },
      kill(signal?: unknown) {
        killSignals.push(signal);
      },
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => fakeRuntime,
    });
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const entry = timers.find((candidate) => candidate === timer);
      if (entry) entry.cleared = true;
    }) as unknown as typeof globalThis.clearTimeout;

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const methods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        handleBackendProcessStop: (
          requestId: string,
          processId: string,
          options?: { userId?: string; reason?: string },
        ) => void;
        stopAllBackendProcesses: (reason: string) => void;
      };
      methods.resolveBackendProcessEntryPath = async () => "/tmp/backend-stop-failure.js";
      methods.getStorageRootPath = () => "/tmp/backend-stop-failure-storage";
      methods.getBackendProcessRuntimeMode = () => "process";
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      await invokeHandleBackendProcessSpawn(host, "backend-stop-failure-spawn", {
        entry: "dist/backend.js",
        kind: "stop-failure",
        key: "stop-failure",
        userId: "user-1",
      });
      const processId = Array.from(state.backendProcesses.keys())[0];
      if (typeof processId !== "string") throw new Error("stop failure process id was not created");
      methods.handleBackendProcessStop("backend-stop-failure", processId, { userId: "user-1" });
      expect(responseFor(messages, "backend-stop-failure")).toEqual({
        type: "response",
        requestId: "backend-stop-failure",
        error: "stop channel closed",
      });
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(killSignals).toEqual(["SIGKILL"]);
      expect(timers.filter((timer) => !timer.cleared)).toHaveLength(0);
      const lifecycleEvents = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "backend_process_lifecycle",
      );
      expect(lifecycleEvents).toHaveLength(3);
      expect(lifecycleEvents.at(-1)).toEqual(expect.objectContaining({
        type: "backend_process_lifecycle",
        event: expect.objectContaining({
          state: "failed",
          previousState: "stopping",
          exitReason: "failed",
          error: "stop channel closed",
        }),
      }));
      expect(messages.at(-1)).toEqual(expect.objectContaining({
        type: "response",
        requestId: "backend-stop-failure",
        error: "stop channel closed",
      }));
      expect(sentToRuntime.at(-1)).toEqual({ type: "stop" });
    } finally {
      try {
        (cleanupHost as unknown as { stopAllBackendProcesses: (reason: string) => void } | null)
          ?.stopAllBackendProcesses("backend_unloaded");
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }
  });

  test.serial("rejects managed-process envelope budgets before frontend state or forwarding side effects", () => {
    const MAX_BYTES = 262_144;
    const atLimitBytes = "a".repeat(MAX_BYTES);
    const overLimitBytes = "a".repeat(MAX_BYTES + 1);
    const atLimitCollection = Array.from({ length: 1_000 }, () => null);
    const overLimitCollection = Array.from({ length: 1_001 }, () => null);
    const makeNodeBudget = (extra: number) => {
      const parts = Array.from({ length: 10 }, (_, index) =>
        Array.from({ length: index === 9 ? 998 + extra : 999 }, () => null),
      );
      return Object.fromEntries(parts.map((value, index) => [`part${index}`, value]));
    };
    const makeDepthBudget = (extra: number) => {
      let value: unknown = null;
      for (let depth = 0; depth < 32 + extra; depth += 1) value = { next: value };
      return value;
    };
    const cases: Array<{ name: string; payload: unknown; dimension: string }> = [
      { name: "bytes", payload: overLimitBytes, dimension: "bytes" },
      { name: "nodes", payload: makeNodeBudget(1), dimension: "nodes" },
      { name: "depth", payload: makeDepthBudget(1), dimension: "depth" },
      { name: "collection", payload: overLimitCollection, dimension: "collection" },
    ];

    for (const current of cases) {
      const { host, messages } = createProcessHost();
      const originalEmit = eventBus.emit;
      const frontendEvents: unknown[] = [];
      eventBus.emit = ((event: EventType, payload: unknown) => {
        if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
      }) as typeof eventBus.emit;
      try {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-budget-${current.name}`,
          options: { kind: "budget", userId: "user-1", payload: current.payload },
        });
        const response = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === `frontend-budget-${current.name}`,
        );
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`frontend ${current.name} budget was not rejected`);
        }
        expect(response.error).toMatch(/spawn payload.*(bytes|visited values|max depth|max collection|collection entries)/i);
        const state = host as unknown as { frontendProcesses: Map<string, unknown> };
        expect(state.frontendProcesses.size).toBe(0);
        expect(frontendEvents).toHaveLength(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }

    const metadataCases: Array<{ name: string; metadata: unknown; dimension: string }> = [
      { name: "bytes", metadata: { value: overLimitBytes }, dimension: "bytes" },
      { name: "nodes", metadata: makeNodeBudget(1), dimension: "nodes" },
      { name: "depth", metadata: makeDepthBudget(1), dimension: "depth" },
      { name: "collection", metadata: overLimitCollection, dimension: "collection" },
    ];
    for (const current of metadataCases) {
      const { host, messages } = createProcessHost();
      const originalEmit = eventBus.emit;
      const frontendEvents: unknown[] = [];
      eventBus.emit = ((event: EventType, payload: unknown) => {
        if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
      }) as typeof eventBus.emit;
      try {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-metadata-budget-${current.name}`,
          options: {
            kind: "metadata-budget",
            userId: "user-1",
            metadata: current.metadata,
          },
        });
        const response = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === `frontend-metadata-budget-${current.name}`,
        );
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`frontend metadata ${current.name} budget was not rejected`);
        }
        expect(response.error).toMatch(/spawn metadata.*(bytes|visited values|max depth|max collection|collection entries|plain object)/i);
        const state = host as unknown as { frontendProcesses: Map<string, unknown> };
        expect(state.frontendProcesses.size).toBe(0);
        expect(frontendEvents).toHaveLength(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }

    let cleanupHost: WorkerHost | null = null;
    const { host, messages } = createProcessHost();
    cleanupHost = host;
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-budget-at-limit",
        options: {
          kind: "budget",
          key: "at-limit",
          userId: "user-1",
          payload: atLimitBytes,
        },
      });
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      expect(state.frontendProcesses.size).toBe(1);
      expect(state.frontendProcessKeyIndex.size).toBe(1);
      expect(frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )).toHaveLength(1);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(0);
      const metadataAtLimitShapes: Array<{ name: string; metadata: unknown }> = [
        { name: "bytes", metadata: { value: "a".repeat(MAX_BYTES - Buffer.byteLength("value", "utf8")) } },
        { name: "nodes", metadata: makeNodeBudget(-1) },
        { name: "depth", metadata: makeDepthBudget(0) },
        { name: "collection", metadata: { entries: atLimitCollection } },
      ];
      for (const [index, current] of metadataAtLimitShapes.entries()) {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-metadata-at-limit-${current.name}`,
          options: {
            kind: "metadata-at-limit",
            key: `metadata-${current.name}`,
            userId: "user-1",
            metadata: current.metadata,
          },
        });
        expect(state.frontendProcesses.size).toBe(index + 2);
        expect(state.frontendProcessKeyIndex.size).toBe(index + 2);
      }
      const frontendAtLimitShapes: Array<{ name: string; payload: unknown }> = [
        { name: "nodes", payload: makeNodeBudget(-1) },
        { name: "depth", payload: makeDepthBudget(0) },
        { name: "collection", payload: atLimitCollection },
      ];
      for (const [index, current] of frontendAtLimitShapes.entries()) {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-budget-at-limit-${current.name}`,
          options: {
            kind: "budget-at-limit",
            key: current.name,
            userId: "user-1",
            payload: current.payload,
          },
        });
        expect(state.frontendProcesses.size).toBe(index + 6);
        expect(state.frontendProcessKeyIndex.size).toBe(index + 6);
      }
      expect(frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )).toHaveLength(8);
    } finally {
      try {
        if (cleanupHost) {
          (cleanupHost as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
        }
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });

  test.serial("rejects frontend metadata and both frontend message directions before forwarding", () => {
    const { host, messages } = createProcessHost();
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-metadata-overflow",
        options: {
          kind: "metadata-budget",
          userId: "user-1",
          metadata: { value: "a".repeat(262_145) },
        },
      });
      const metadataResponse = messages.find((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "frontend-metadata-overflow",
      );
      if (typeof metadataResponse !== "object" || metadataResponse === null || !("error" in metadataResponse)) {
        throw new Error("frontend metadata budget was not rejected");
      }
      expect(metadataResponse.error).toMatch(/spawn metadata.*bytes/i);
      expect(frontendEvents).toHaveLength(0);

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-message-process",
        options: { kind: "message-budget", userId: "user-1" },
      });
      const spawnPayload = frontendEvents.find((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      if (typeof spawnPayload !== "object" || spawnPayload === null || !("processId" in spawnPayload)) {
        throw new Error("frontend message budget spawn did not include process id");
      }
      const processId = spawnPayload.processId;
      if (typeof processId !== "string") throw new Error("frontend message budget process id was not a string");
      const sendFrontendProcess = (host as unknown as {
        handleFrontendProcessSend: (processId: string, payload: unknown, userId?: string) => void;
      }).handleFrontendProcessSend;
      const messageBudgetCases: unknown[] = [
        "a".repeat(262_145),
        Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
          `part${index}`,
          Array.from({ length: index === 9 ? 999 : 999 }, () => null),
        ])),
        (() => {
          let value: unknown = null;
          for (let depth = 0; depth < 33; depth += 1) value = { next: value };
          return value;
        })(),
        Array.from({ length: 1_001 }, () => null),
      ];
      host.handleFrontendProcessEvent(processId, "user-1", "ready");
      const eventCountBeforeMessage = frontendEvents.length;
      const workerMessageCountBeforeMessage = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_message",
      ).length;
      for (const payload of messageBudgetCases) {
        host.handleFrontendProcessMessage(processId, "user-1", payload);
        sendFrontendProcess.call(host, processId, payload, "user-1");
      }
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_message",
      )).toHaveLength(workerMessageCountBeforeMessage);
      expect(frontendEvents).toHaveLength(eventCountBeforeMessage);
      host.handleFrontendProcessMessage(processId, "user-1", "a".repeat(262_144));
      expect(messages[messages.length - 1]).toEqual({
        type: "frontend_process_message",
        processId,
        payload: "a".repeat(262_144),
        userId: "user-1",
      });
      sendFrontendProcess.call(host, processId, "a".repeat(262_144), "user-1");
      expect(frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "message",
      )).toEqual([{
        extensionId: "extension-process-response-test",
        identifier: "process_response_test",
        action: "message",
        processId,
        payload: "a".repeat(262_144),
      }]);
    } finally {
      try {
        (host as unknown as {
          stopAllFrontendProcesses: (reason: string) => void;
        }).stopAllFrontendProcesses("backend_unloaded");
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });
  test.serial("bounds backend spawn envelopes and both backend message directions before transport forwarding", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend budget test could not capture Bun.spawn");
    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const hostMethods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        handleBackendProcessRuntimeMessage: (processId: string, message: unknown) => void;
      };
      hostMethods.resolveBackendProcessEntryPath = async () => "/tmp/backend-budget.js";
      hostMethods.getStorageRootPath = () => "/tmp/backend-budget-storage";
      hostMethods.getBackendProcessRuntimeMode = () => "process";
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      const atLimitBytes = "a".repeat(262_144);
      const overLimitBytes = "a".repeat(262_145);
      const makeNodeBudget = (extra: number) => {
        const parts = Array.from({ length: 10 }, (_, index) =>
          Array.from({ length: index === 9 ? 998 + extra : 999 }, () => null),
        );
        return Object.fromEntries(parts.map((value, index) => [`part${index}`, value]));
      };
      const makeDepthBudget = (extra: number): Record<string, unknown> => {
        let value: Record<string, unknown> = {};
        for (let depth = 0; depth < 32 + extra; depth += 1) value = { next: value };
        return value;
      };
      const invalidCases: Array<{ name: string; payload: unknown; dimension: string }> = [
        { name: "bytes", payload: overLimitBytes, dimension: "bytes" },
        { name: "nodes", payload: makeNodeBudget(1), dimension: "nodes" },
        { name: "depth", payload: makeDepthBudget(1), dimension: "depth" },
        { name: "collection", payload: Array.from({ length: 1_001 }, () => null), dimension: "collection" },
      ];
      for (const current of invalidCases) {
        const requestId = `backend-budget-${current.name}`;
        await invokeHandleBackendProcessSpawn(host, requestId, {
          entry: "dist/backend.js",
          kind: "backend-budget",
          key: `backend-${current.name}`,
          userId: "user-1",
          payload: current.payload,
        });
        const response = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === requestId,
        );
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`backend ${current.name} budget was not rejected`);
        }
        expect(response.error).toMatch(/spawn payload.*(bytes|visited values|max depth|max collection|collection entries)/i);
        expect(state.backendProcesses.size).toBe(0);
        expect(state.backendProcessKeyIndex.size).toBe(0);
        expect(spawnCalls).toBe(0);
      }

      const metadataCases: Array<{ name: string; metadata: Record<string, unknown>; dimension: string }> = [
        { name: "bytes", metadata: { value: overLimitBytes }, dimension: "bytes" },
        { name: "nodes", metadata: makeNodeBudget(1), dimension: "nodes" },
        { name: "depth", metadata: makeDepthBudget(1), dimension: "depth" },
        { name: "collection", metadata: { entries: Array.from({ length: 1_001 }, () => null) }, dimension: "collection" },
      ];
      for (const current of metadataCases) {
        const requestId = `backend-metadata-budget-${current.name}`;
        await invokeHandleBackendProcessSpawn(host, requestId, {
          entry: "dist/backend.js",
          kind: "backend-metadata-budget",
          key: `backend-metadata-${current.name}`,
          userId: "user-1",
          metadata: current.metadata,
        });
        const response = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === requestId,
        );
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`backend metadata ${current.name} budget was not rejected`);
        }
        expect(response.error).toMatch(/spawn metadata.*(bytes|visited values|max depth|max collection|collection entries|plain object)/i);
        expect(state.backendProcesses.size).toBe(0);
        expect(state.backendProcessKeyIndex.size).toBe(0);
        expect(spawnCalls).toBe(0);
      }

      await invokeHandleBackendProcessSpawn(host, "backend-budget-at-limit", {
        entry: "dist/backend.js",
        kind: "backend-budget",
        key: "backend-at-limit",
        userId: "user-1",
        payload: atLimitBytes,
      });
      const metadataAtLimitShapes: Array<{ name: string; metadata: Record<string, unknown> }> = [
        { name: "bytes", metadata: { value: "a".repeat(262_144 - Buffer.byteLength("value", "utf8")) } },
        { name: "nodes", metadata: makeNodeBudget(-1) },
        { name: "depth", metadata: makeDepthBudget(0) },
        { name: "collection", metadata: { entries: Array.from({ length: 1_000 }, () => null) } },
      ];
      for (const current of metadataAtLimitShapes) {
        await invokeHandleBackendProcessSpawn(host, `backend-metadata-at-limit-${current.name}`, {
          entry: "dist/backend.js",
          kind: "backend-metadata-at-limit",
          key: current.name,
          userId: "user-1",
          metadata: current.metadata,
        });
      }
      expect(state.backendProcesses.size).toBe(5);
      expect(state.backendProcessKeyIndex.size).toBe(5);
      expect(spawnCalls).toBe(5);
      const backendAtLimitShapes: Array<{ name: string; payload: unknown }> = [
        { name: "nodes", payload: makeNodeBudget(-1) },
        { name: "depth", payload: makeDepthBudget(0) },
        { name: "collection", payload: Array.from({ length: 1_000 }, () => null) },
      ];
      for (const current of backendAtLimitShapes) {
        await invokeHandleBackendProcessSpawn(host, `backend-budget-at-limit-${current.name}`, {
          entry: "dist/backend.js",
          kind: "backend-budget-at-limit",
          key: current.name,
          userId: "user-1",
          payload: current.payload,
        });
      }
      expect(state.backendProcesses.size).toBe(8);
      expect(state.backendProcessKeyIndex.size).toBe(8);
      expect(spawnCalls).toBe(8);
      const initMessage = sentToRuntime[0];
      if (typeof initMessage !== "object" || initMessage === null || !("type" in initMessage)) {
        throw new Error("backend budget runtime did not receive init");
      }
      expect(initMessage.type).toBe("init");

      const processId = Array.from(state.backendProcesses.keys())[0];
      if (typeof processId !== "string") throw new Error("backend budget process id was not a string");
      hostMethods.handleBackendProcessRuntimeMessage(processId, { type: "ready" });
      const backendMessageBudgetCases: unknown[] = [
        "a".repeat(262_145),
        Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
          `part${index}`,
          Array.from({ length: 999 }, () => null),
        ])),
        (() => {
          let value: unknown = null;
          for (let depth = 0; depth < 33; depth += 1) value = { next: value };
          return value;
        })(),
        Array.from({ length: 1_001 }, () => null),
      ];
      const sendsBeforeMessages = sentToRuntime.length;
      const workerMessagesBeforeRuntimeMessage = messages.length;
      for (const payload of backendMessageBudgetCases) {
        (host as unknown as {
          handleBackendProcessSend: (processId: string, payload: unknown, userId?: string) => void;
        }).handleBackendProcessSend(processId, payload, "user-1");
        hostMethods.handleBackendProcessRuntimeMessage(processId, {
          type: "message",
          payload,
        });
      }
      expect(sentToRuntime).toHaveLength(sendsBeforeMessages);
      expect(messages).toHaveLength(workerMessagesBeforeRuntimeMessage);
      (host as unknown as {
        handleBackendProcessSend: (processId: string, payload: unknown, userId?: string) => void;
      }).handleBackendProcessSend(processId, "a".repeat(262_144), "user-1");
      expect(sentToRuntime[sendsBeforeMessages]).toEqual({
        type: "message",
        payload: "a".repeat(262_144),
      });
      hostMethods.handleBackendProcessRuntimeMessage(processId, {
        type: "message",
        payload: "a".repeat(262_144),
      });
      expect(messages[messages.length - 1]).toEqual({
        type: "backend_process_message",
        processId,
        payload: "a".repeat(262_144),
        userId: "user-1",
      });

      const backendProcessCountBeforeMetadataOverflow = state.backendProcesses.size;
      const backendKeyCountBeforeMetadataOverflow = state.backendProcessKeyIndex.size;
      const backendSpawnCallsBeforeMetadataOverflow = spawnCalls;
      await invokeHandleBackendProcessSpawn(host, "backend-metadata-overflow", {
        entry: "dist/backend.js",
        kind: "backend-metadata-budget",
        key: "backend-metadata-overflow",
        userId: "user-1",
        metadata: { value: "a".repeat(262_145) },
      });
      const metadataResponse = messages.find((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "backend-metadata-overflow",
      );
      if (typeof metadataResponse !== "object" || metadataResponse === null || !("error" in metadataResponse)) {
        throw new Error("backend metadata budget was not rejected");
      }
      expect(metadataResponse.error).toMatch(/spawn metadata.*(bytes|visited values|max depth|max collection|collection entries|plain object)/i);
      expect(state.backendProcesses.size).toBe(backendProcessCountBeforeMetadataOverflow);
      expect(state.backendProcessKeyIndex.size).toBe(backendKeyCountBeforeMetadataOverflow);
      expect(spawnCalls).toBe(backendSpawnCallsBeforeMetadataOverflow);
    } finally {
      try {
        if (cleanupHost) {
          const cleanupState = cleanupHost as unknown as {
            backendProcesses: Map<string, unknown>;
            backendProcessKeyIndex: Map<string, unknown>;
            stopAllBackendProcesses: (reason: string) => void;
          };
          cleanupState.stopAllBackendProcesses("backend_unloaded");
          expect(cleanupState.backendProcesses.size).toBe(0);
          expect(cleanupState.backendProcessKeyIndex.size).toBe(0);
        }
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
  });
  test.serial("rejects aggregate frontend spawn budgets before UUID, timers, records, keys, or events", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalRandomUUIDDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    const timers: unknown[] = [];
    let uuidCalls = 0;
    const controlledSetTimeout = ((callback: () => void) => {
      timers.push(callback);
      return callback;
    }) as unknown as typeof globalThis.setTimeout;
    try {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => {
        uuidCalls += 1;
        return `unexpected-${uuidCalls}`;
      },
    });
    globalThis.setTimeout = controlledSetTimeout;
    const cases = [
      {
        name: "bytes",
        payload: "p".repeat(131_100),
        metadata: { value: "m".repeat(131_100) },
      },
      {
        name: "nodes",
        payload: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`part${index}`, Array.from({ length: 999 }, () => null)]),
        ),
        metadata: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`part${index}`, Array.from({ length: 999 }, () => null)]),
        ),
      },
    ];
      for (const current of cases) {
        const { host, messages } = createProcessHost();
        const frontendEvents: unknown[] = [];
        const originalEmit = eventBus.emit;
        eventBus.emit = ((event: EventType, payload: unknown) => {
          if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
        }) as typeof eventBus.emit;
        try {
          invokeHandleMessageInScope(host, {
            type: "frontend_process_spawn",
            requestId: `frontend-aggregate-${current.name}`,
            options: {
              kind: "aggregate-budget",
              key: `aggregate-${current.name}`,
              userId: "user-1",
              payload: current.payload,
              metadata: current.metadata,
            },
          });
          const state = host as unknown as {
            frontendProcesses: Map<string, unknown>;
            frontendProcessKeyIndex: Map<string, string>;
          };
          const responses = messages.filter((message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "response" &&
            "requestId" in message &&
            message.requestId === `frontend-aggregate-${current.name}`,
          );
          expect(responses).toHaveLength(1);
          const response = responses[0];
          if (typeof response !== "object" || response === null || !("error" in response)) {
            throw new Error(`frontend aggregate ${current.name} budget was not rejected`);
          }
          expect(response.error).toMatch(/spawn (payload|metadata).*(bytes|visited values|max depth|max collection|collection entries)/i);
          expect(uuidCalls).toBe(0);
          expect(timers).toHaveLength(0);
          expect(frontendEvents).toHaveLength(0);
          expect(state.frontendProcesses.size).toBe(0);
          expect(state.frontendProcessKeyIndex.size).toBe(0);
        } finally {
          try {
            (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
              .stopAllFrontendProcesses("backend_unloaded");
          } finally {
            eventBus.emit = originalEmit;
          }
        }
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (originalRandomUUIDDescriptor) {
        Object.defineProperty(crypto, "randomUUID", originalRandomUUIDDescriptor);
      } else {
        Reflect.deleteProperty(crypto, "randomUUID");
      }
    }
  });
  test.serial("drops direct process events with invalid aggregates and emits an exact valid boundary", () => {
    const { host } = createProcessHost();
    const originalEmit = eventBus.emit;
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;
    try {
      const invalidPayloads: Array<{ name: string; payload: Record<string, unknown> }> = [
        {
          name: "undefined-payload",
          payload: {
            action: "message",
            processId: "direct-invalid-payload",
            payload: undefined,
          },
        },
        {
          name: "aggregate-over-budget",
          payload: {
            action: "message",
            processId: "direct-over-budget",
            payload: "p".repeat(131_072),
            metadata: "m".repeat(131_073),
          },
        },
      ];
      for (const current of invalidPayloads) {
        invokeSendFrontendProcessEvent(host, "user-1", current.payload);
        expect(frontendEvents, current.name).toHaveLength(0);
      }

      const validPayload = "p".repeat(131_072);
      const validMetadata = "m".repeat(131_072);
      invokeSendFrontendProcessEvent(host, "user-1", {
        action: "message",
        processId: "direct-valid-boundary",
        payload: validPayload,
        metadata: validMetadata,
      });
      expect(frontendEvents).toEqual([
        {
          payload: {
            extensionId: "extension-process-response-test",
            identifier: "process_response_test",
            action: "message",
            processId: "direct-valid-boundary",
            payload: validPayload,
            metadata: validMetadata,
          },
          userId: "user-1",
        },
      ]);
    } finally {
      eventBus.emit = originalEmit;
    }
  });


  test.serial("counts a shared spawn root identity once across frontend payload and metadata", () => {
    const { host, messages } = createProcessHost();
    const originalEmit = eventBus.emit;
    const frontendEvents: Array<{ payload: unknown; userId?: string }> = [];
    eventBus.emit = ((event: EventType, payload: unknown, userId?: string) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push({ payload, userId });
    }) as typeof eventBus.emit;
    const shared = { value: "s".repeat(100_000) };
    const state = host as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
    };
    try {
      const sharedPayload = { shared, left: "l".repeat(30_000) };
      const sharedMetadata = { shared, right: "r".repeat(30_000) };
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-shared-identity",
        options: {
          kind: "shared-identity",
          key: "shared-identity",
          userId: "user-1",
          payload: sharedPayload,
          metadata: sharedMetadata,
        },
      });
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(0);
      const spawnEvents = frontendEvents.filter(({ payload }) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      expect(spawnEvents).toHaveLength(1);
      expect(frontendEvents[0]).toEqual({
        payload: expect.objectContaining({
          extensionId: "extension-process-response-test",
          identifier: "process_response_test",
          action: "spawn",
          kind: "shared-identity",
          key: "shared-identity",
          processId: expect.any(String),
        }),
        userId: "user-1",
      });
      expect(state.frontendProcesses.size).toBe(1);
      expect(state.frontendProcessKeyIndex.get("user-1:shared-identity:shared-identity")).toBe(
        Array.from(state.frontendProcesses.keys())[0],
      );
    } finally {
      try {
        (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });

  test.serial("bounds typed views, dense arrays, cloneable errors, boxes, and bigint measurement", () => {
    const MAX_BYTES = 262_144;
    let accessorCalls = 0;
    const denseArray = new Array(1_001);
    Object.defineProperty(denseArray, "1000", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        throw new Error("dense array accessor must not run");
      },
    });
    const cases: Array<{ name: string; value: unknown }> = [
      { name: "oversized-typed-view", value: new Uint8Array(new ArrayBuffer(MAX_BYTES + 1), 0, 1) },
      { name: "oversized-dataview", value: new DataView(new ArrayBuffer(MAX_BYTES + 1), 0, 1) },
      { name: "oversized-dense-array", value: denseArray },
      { name: "oversized-error-message", value: new Error("e".repeat(MAX_BYTES + 1)) },
      { name: "oversized-boxed-string", value: new String("s".repeat(MAX_BYTES + 1)) },
    ];
    for (const current of cases) {
      const { host, messages } = createProcessHost();
      const state = host as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
      };
      const originalEmit = eventBus.emit;
      const frontendEvents: unknown[] = [];
      eventBus.emit = ((event: EventType, payload: unknown) => {
        if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
      }) as typeof eventBus.emit;
      try {
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-robustness-${current.name}`,
          options: {
            kind: "robustness",
            key: current.name,
            userId: "user-1",
            payload: current.value,
          },
        });
        const response = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === `frontend-robustness-${current.name}`,
        );
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`${current.name} was not rejected`);
        }
        expect(response.error).toMatch(/spawn payload.*(bytes|collection|binary|unsupported|plain object)/i);
        expect(frontendEvents).toHaveLength(0);
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        try {
          (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
            .stopAllFrontendProcesses("backend_unloaded");
          expect(state.frontendProcesses.size).toBe(0);
          expect(state.frontendProcessKeyIndex.size).toBe(0);
        } finally {
          eventBus.emit = originalEmit;
        }
      }
    }
    expect(accessorCalls).toBe(0);

    const acceptedValues: Array<{ name: string; value: unknown }> = [
      { name: "plain-object", value: { nested: "ok", list: [1, "two", null] } },
      { name: "plain-array", value: [1, "two", null, { nested: true }] },
      { name: "null", value: null },
      { name: "string", value: "safe" },
      { name: "boolean", value: true },
      { name: "number", value: 7 },
    ];
    const { host, messages } = createProcessHost();
    const state = host as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
    };
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      for (const current of acceptedValues) {
        const payload = current.name === "shared-backing" && typeof current.value === "object" && current.value !== null && "payload" in current.value
          ? current.value.payload
          : current.value;
        const metadata = current.name === "shared-backing" && typeof current.value === "object" && current.value !== null && "metadata" in current.value
          ? current.value.metadata
          : undefined;
        invokeHandleMessageInScope(host, {
          type: "frontend_process_spawn",
          requestId: `frontend-accepted-${current.name}`,
          options: {
            kind: "accepted",
            key: current.name,
            userId: "user-1",
            payload,
            ...(metadata === undefined ? {} : { metadata }),
          },
        });
        const acceptedResponse = messages.find((message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "response" &&
          "requestId" in message &&
          message.requestId === `frontend-accepted-${current.name}`,
        );
        if (acceptedResponse !== undefined) {
          let reason = "unknown error";
          if (typeof acceptedResponse === "object" && acceptedResponse !== null && "error" in acceptedResponse) {
            reason = String(acceptedResponse.error);
          }
          throw new Error(`accepted ${current.name} was rejected: ${reason}`);
        }
      }
      expect(state.frontendProcesses.size).toBe(acceptedValues.length);
      expect(state.frontendProcessKeyIndex.size).toBe(acceptedValues.length);
      expect(frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      )).toHaveLength(acceptedValues.length);
      expect(messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(0);
    } finally {
      try {
        (host as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }

    const originalBigIntToStringDescriptor = Object.getOwnPropertyDescriptor(BigInt.prototype, "toString");
    type BigIntHostState = {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
      stopAllFrontendProcesses: (reason: string) => void;
    };
    let bigintState: BigIntHostState | null = null;
    try {
    Object.defineProperty(BigInt.prototype, "toString", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("validator must not allocate a decimal bigint string");
      },
    });
      const { host: currentBigIntHost, messages: bigintMessages } = createProcessHost();
      const currentBigIntState = currentBigIntHost as unknown as BigIntHostState;
      bigintState = currentBigIntState;
      invokeHandleMessageInScope(currentBigIntHost, {
        type: "frontend_process_spawn",
        requestId: "frontend-4097-bit-bigint",
        options: {
          kind: "4097-bit-bigint",
          userId: "user-1",
          payload: 1n << 4096n,
        },
      });
      const response = bigintMessages.find((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      );
      if (typeof response !== "object" || response === null || !("error" in response)) {
        throw new Error("huge bigint was not rejected");
      }
      expect(response.error).toMatch(/spawn payload.*(bytes|bits|bigint)/i);
      expect(currentBigIntState.frontendProcesses.size).toBe(0);
      expect(currentBigIntState.frontendProcessKeyIndex.size).toBe(0);
    } finally {
      try {
        if (bigintState) {
          bigintState.stopAllFrontendProcesses("backend_unloaded");
          expect(bigintState.frontendProcesses.size).toBe(0);
          expect(bigintState.frontendProcessKeyIndex.size).toBe(0);
        }
      } finally {
        if (originalBigIntToStringDescriptor) {
          Object.defineProperty(BigInt.prototype, "toString", originalBigIntToStringDescriptor);
        } else {
          Reflect.deleteProperty(BigInt.prototype, "toString");
        }
      }
    }
  });
  test.serial("rejects aggregate backend spawn budgets and counts shared roots once", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend aggregate test could not capture Bun.spawn");
    let spawnCalls = 0;
    const sentToRuntime: unknown[] = [];
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });
    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const hostMethods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
      };
      hostMethods.resolveBackendProcessEntryPath = async () => "/tmp/backend-aggregate.js";
      hostMethods.getStorageRootPath = () => "/tmp/backend-aggregate-storage";
      hostMethods.getBackendProcessRuntimeMode = () => "process";
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      const payload = "p".repeat(131_100);
      const metadata = { value: "m".repeat(131_100) };
      await invokeHandleBackendProcessSpawn(host, "backend-aggregate-bytes", {
        entry: "dist/backend.js",
        kind: "aggregate",
        key: "aggregate-bytes",
        userId: "user-1",
        payload,
        metadata,
      });
      const response = messages.find((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response" &&
        "requestId" in message &&
        message.requestId === "backend-aggregate-bytes",
      );
      if (typeof response !== "object" || response === null || !("error" in response)) {
        throw new Error("backend aggregate bytes budget was not rejected");
      }
      expect(response.error).toMatch(/spawn (payload|metadata).*bytes/i);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(spawnCalls).toBe(0);
      expect(sentToRuntime).toHaveLength(0);

      const shared = { value: "s".repeat(100_000) };
      await invokeHandleBackendProcessSpawn(host, "backend-shared-identity", {
        entry: "dist/backend.js",
        kind: "shared",
        key: "shared",
        userId: "user-1",
        payload: { shared, left: "l".repeat(30_000) },
        metadata: { shared, right: "r".repeat(30_000) },
      });
      expect(state.backendProcesses.size).toBe(1);
      expect(state.backendProcessKeyIndex.get("user-1:shared:shared")).toBe(
        Array.from(state.backendProcesses.keys())[0],
      );
      expect(spawnCalls).toBe(1);
      expect(sentToRuntime).toHaveLength(1);
      const init = sentToRuntime[0];
      if (typeof init !== "object" || init === null || !("type" in init)) {
        throw new Error("backend aggregate runtime did not receive init");
      }
      expect(init.type).toBe("init");
    } finally {
      try {
        if (cleanupHost) {
          const cleanupState = cleanupHost as unknown as {
            backendProcesses: Map<string, unknown>;
            backendProcessKeyIndex: Map<string, unknown>;
            stopAllBackendProcesses: (reason: string) => void;
          };
          cleanupState.stopAllBackendProcesses("backend_unloaded");
          expect(cleanupState.backendProcesses.size).toBe(0);
          expect(cleanupState.backendProcessKeyIndex.size).toBe(0);
        }
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
  });
  test.serial("charges enumerable property-name bytes to the shared process budget without invoking getters", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("property-name budget test could not capture Bun.spawn");
    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });

    const createBudgetObject = (secondKeyBytes: number): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "k".repeat(131_072), {
        configurable: true,
        enumerable: true,
        value: null,
      });
      Object.defineProperty(value, "m".repeat(secondKeyBytes), {
        configurable: true,
        enumerable: true,
        value: null,
      });
      return value;
    };

    let cleanupHost: WorkerHost | null = null;
    try {
      const { host, messages } = createProcessHost();
      cleanupHost = host;
      const methods = host as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        stopAllBackendProcesses: (reason: string) => void;
      };
      const state = host as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      methods.resolveBackendProcessEntryPath = async () => "/tmp/property-budget.js";
      methods.getStorageRootPath = () => "/tmp/property-budget-storage";
      methods.getBackendProcessRuntimeMode = () => "process";

      await invokeHandleBackendProcessSpawn(host, "backend-property-at-limit", {
        entry: "dist/backend.js",
        kind: "property-budget",
        key: "at-limit",
        userId: "user-1",
        payload: createBudgetObject(131_072),
      });
      expect(responseFor(messages, "backend-property-at-limit")).toBeUndefined();
      expect(state.backendProcesses.size).toBe(1);
      expect(state.backendProcessKeyIndex.size).toBe(1);
      expect(spawnCalls).toBe(1);

      methods.stopAllBackendProcesses("backend_unloaded");
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);

      const overLimitRequestId = "backend-property-over-limit";
      await invokeHandleBackendProcessSpawn(host, overLimitRequestId, {
        entry: "dist/backend.js",
        kind: "property-budget",
        key: "over-limit",
        userId: "user-1",
        payload: createBudgetObject(131_073),
      });
      const overLimitResponse = responseFor(messages, overLimitRequestId);
      if (typeof overLimitResponse !== "object" || overLimitResponse === null || !("error" in overLimitResponse)) {
        throw new Error("aggregate enumerable key bytes were not rejected");
      }
      expect(overLimitResponse.error).toMatch(/spawn payload.*(bytes|UTF-8)/i);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(spawnCalls).toBe(1);
      expect(sentToRuntime).toHaveLength(1);
      expect(JSON.stringify(sentToRuntime)).not.toContain("m".repeat(131_073));

      let getterCalls = 0;
      const accessorPayload: Record<string, unknown> = {};
      Object.defineProperty(accessorPayload, "g".repeat(131_072), {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("enumerable getter must not run");
        },
      });
      const accessorRequestId = "backend-property-accessor";
      await invokeHandleBackendProcessSpawn(host, accessorRequestId, {
        entry: "dist/backend.js",
        kind: "property-budget",
        key: "accessor",
        userId: "user-1",
        payload: accessorPayload,
      });
      const accessorResponse = responseFor(messages, accessorRequestId);
      if (typeof accessorResponse !== "object" || accessorResponse === null || !("error" in accessorResponse)) {
        throw new Error("enumerable accessor was not rejected");
      }
      expect(accessorResponse.error).toMatch(/accessor/i);
      expect(getterCalls).toBe(0);
      expect(state.backendProcesses.size).toBe(0);
      expect(state.backendProcessKeyIndex.size).toBe(0);
      expect(spawnCalls).toBe(1);
    } finally {
      try {
        if (cleanupHost) {
          const cleanupState = cleanupHost as unknown as {
            backendProcesses: Map<string, unknown>;
            backendProcessKeyIndex: Map<string, unknown>;
            stopAllBackendProcesses: (reason: string) => void;
          };
          cleanupState.stopAllBackendProcesses("backend_unloaded");
          expect(cleanupState.backendProcesses.size).toBe(0);
          expect(cleanupState.backendProcessKeyIndex.size).toBe(0);
        }
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
  });
  test.serial("omits optional spawn roots but rejects explicit undefined process messages", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    const originalEmit = eventBus.emit;
    if (!originalSpawnDescriptor) throw new Error("undefined message test could not capture Bun.spawn");
    try {
      const { host: frontendHost, messages: frontendMessages } = createProcessHost();
      const frontendState = frontendHost as unknown as {
        frontendProcesses: Map<string, unknown>;
        frontendProcessKeyIndex: Map<string, string>;
        handleFrontendProcessSend: (processId: string, payload: unknown, userId?: string) => void;
        stopAllFrontendProcesses: (reason: string) => void;
      };
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;

    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });

    try {
      invokeHandleMessageInScope(frontendHost, {
        type: "frontend_process_spawn",
        requestId: "frontend-optional-roots",
        options: { kind: "optional-roots", key: "frontend", userId: "user-1" },
      });
      const frontendSpawn = frontendEvents.find((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      if (typeof frontendSpawn !== "object" || frontendSpawn === null || !("processId" in frontendSpawn)) {
        throw new Error("frontend optional-root spawn did not emit a process id");
      }
      const frontendProcessId = frontendSpawn.processId;
      if (typeof frontendProcessId !== "string") throw new Error("frontend process id was not a string");
      expect(Object.prototype.hasOwnProperty.call(frontendSpawn, "payload")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(frontendSpawn, "metadata")).toBe(false);
      invokeHandleMessageInScope(frontendHost, {
        type: "frontend_process_spawn",
        requestId: "frontend-explicit-null-roots",
        options: {
          kind: "optional-roots-null",
          key: "frontend-null",
          userId: "user-1",
          payload: null,
          metadata: {},
        },
      });
      const frontendNullSpawn = frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn" &&
        "kind" in payload &&
        payload.kind === "optional-roots-null",
      ).at(-1);
      if (
        typeof frontendNullSpawn !== "object" ||
        frontendNullSpawn === null ||
        !("payload" in frontendNullSpawn) ||
        !("metadata" in frontendNullSpawn)
      ) {
        throw new Error("frontend explicit-null spawn did not emit a process payload");
      }
      expect(Object.prototype.hasOwnProperty.call(frontendNullSpawn, "payload")).toBe(true);
      expect(frontendNullSpawn.payload).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(frontendNullSpawn, "metadata")).toBe(true);
      expect(frontendNullSpawn.metadata).toEqual({});
      expect(frontendMessages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(0);
      expect(frontendState.frontendProcesses.size).toBe(2);
      expect(frontendState.frontendProcessKeyIndex.size).toBe(2);

      const messagesBeforeUndefined = [...frontendMessages];
      const eventsBeforeUndefined = [...frontendEvents];
      frontendHost.handleFrontendProcessMessage(frontendProcessId, "user-1", undefined);
      frontendState.handleFrontendProcessSend(frontendProcessId, undefined, "user-1");
      expect(frontendMessages).toEqual(messagesBeforeUndefined);
      expect(frontendEvents).toEqual(eventsBeforeUndefined);
      expect(frontendState.frontendProcesses.size).toBe(2);
      expect(frontendState.frontendProcessKeyIndex.size).toBe(2);
    } finally {
      try {
        frontendState.stopAllFrontendProcesses("backend_unloaded");
        expect(frontendState.frontendProcesses.size).toBe(0);
        expect(frontendState.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }

    const { host: backendHost, messages: backendMessages } = createProcessHost();
    const backendMethods = backendHost as unknown as {
      resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
      getStorageRootPath: () => string;
      getBackendProcessRuntimeMode: () => "process";
      handleBackendProcessSend: (processId: string, payload: unknown, userId?: string) => void;
      stopAllBackendProcesses: (reason: string) => void;
    };
    const backendState = backendHost as unknown as {
      backendProcesses: Map<string, unknown>;
      backendProcessKeyIndex: Map<string, string>;
    };
    backendMethods.resolveBackendProcessEntryPath = async () => "/tmp/undefined-message.js";
    backendMethods.getStorageRootPath = () => "/tmp/undefined-message-storage";
    backendMethods.getBackendProcessRuntimeMode = () => "process";
    try {
      await invokeHandleBackendProcessSpawn(backendHost, "backend-optional-roots", {
        entry: "dist/backend.js",
        kind: "optional-roots",
        key: "backend",
        userId: "user-1",
      });
      const optionalInit = sentToRuntime.find((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "init",
      );
      if (
        typeof optionalInit !== "object" ||
        optionalInit === null ||
        !("process" in optionalInit) ||
        typeof optionalInit.process !== "object" ||
        optionalInit.process === null
      ) {
        throw new Error("backend optional-root spawn did not send an init process");
      }
      expect(Object.prototype.hasOwnProperty.call(optionalInit.process, "payload")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(optionalInit.process, "metadata")).toBe(false);
      await invokeHandleBackendProcessSpawn(backendHost, "backend-explicit-null-roots", {
        entry: "dist/backend.js",
        kind: "optional-roots-null",
        key: "backend-null",
        userId: "user-1",
        payload: null,
        metadata: {},
      });
      const nullInits = sentToRuntime.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "init",
      );
      const explicitNullInit = nullInits.at(-1);
      if (
        typeof explicitNullInit !== "object" ||
        explicitNullInit === null ||
        !("process" in explicitNullInit) ||
        typeof explicitNullInit.process !== "object" ||
        explicitNullInit.process === null ||
        !("payload" in explicitNullInit.process) ||
        !("metadata" in explicitNullInit.process)
      ) {
        throw new Error("backend explicit-null spawn did not send an init process");
      }
      expect(Object.prototype.hasOwnProperty.call(explicitNullInit.process, "payload")).toBe(true);
      expect(explicitNullInit.process.payload).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(explicitNullInit.process, "metadata")).toBe(true);
      expect(explicitNullInit.process.metadata).toEqual({});
      expect(backendMessages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "response",
      )).toHaveLength(0);
      expect(backendState.backendProcesses.size).toBe(2);
      expect(backendState.backendProcessKeyIndex.size).toBe(2);
      const backendProcessId = Array.from(backendState.backendProcesses.keys())[0];
      if (typeof backendProcessId !== "string") throw new Error("backend process id was not a string");
      const runtimeMessagesBeforeUndefined = [...sentToRuntime];
      const backendMessagesBeforeUndefined = [...backendMessages];
      backendMethods.handleBackendProcessSend(backendProcessId, undefined, "user-1");
      expect(sentToRuntime).toEqual(runtimeMessagesBeforeUndefined);
      expect(backendMessages).toEqual(backendMessagesBeforeUndefined);
      expect(backendState.backendProcesses.size).toBe(2);
      expect(backendState.backendProcessKeyIndex.size).toBe(2);
      expect(spawnCalls).toBe(2);
    } finally {
      try {
        backendMethods.stopAllBackendProcesses("backend_unloaded");
        expect(backendState.backendProcesses.size).toBe(0);
        expect(backendState.backendProcessKeyIndex.size).toBe(0);
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
    } finally {
      eventBus.emit = originalEmit;
      Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
    }
  });
  test.serial("rejects non-object spawn metadata before frontend or backend side effects", async () => {
    const invalidMetadata: unknown[] = [null, [], "metadata", 7, false];
    const { host: frontendHost, messages: frontendMessages } = createProcessHost();
    const frontendState = frontendHost as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, string>;
      stopAllFrontendProcesses: (reason: string) => void;
    };
    const originalEmit = eventBus.emit;
    const frontendEvents: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) frontendEvents.push(payload);
    }) as typeof eventBus.emit;
    try {
      for (const [index, metadata] of invalidMetadata.entries()) {
        const requestId = `frontend-metadata-shape-${index}`;
        invokeHandleMessageInScope(frontendHost, {
          type: "frontend_process_spawn",
          requestId,
          options: {
            kind: "metadata-shape",
            key: `invalid-${index}`,
            userId: "user-1",
            metadata,
          },
        });
        const response = responseFor(frontendMessages, requestId);
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`frontend metadata ${String(metadata)} was accepted`);
        }
        expect(response.error).toMatch(/spawn metadata.*(plain object|object)/i);
        expect(frontendState.frontendProcesses.size).toBe(0);
        expect(frontendState.frontendProcessKeyIndex.size).toBe(0);
        expect(frontendEvents).toHaveLength(0);
      }

      invokeHandleMessageInScope(frontendHost, {
        type: "frontend_process_spawn",
        requestId: "frontend-metadata-omitted",
        options: { kind: "metadata-shape", key: "omitted", userId: "user-1" },
      });
      invokeHandleMessageInScope(frontendHost, {
        type: "frontend_process_spawn",
        requestId: "frontend-metadata-object",
        options: {
          kind: "metadata-shape",
          key: "object",
          userId: "user-1",
          payload: null,
          metadata: { source: "test" },
        },
      });
      expect(frontendState.frontendProcesses.size).toBe(2);
      expect(frontendState.frontendProcessKeyIndex.size).toBe(2);
      const frontendSpawns = frontendEvents.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      expect(frontendSpawns).toHaveLength(2);
      expect(frontendSpawns.at(-1)).toEqual(expect.objectContaining({
        payload: null,
        metadata: { source: "test" },
      }));
      expect(responseFor(frontendMessages, "frontend-metadata-omitted")).toBeUndefined();
      expect(responseFor(frontendMessages, "frontend-metadata-object")).toBeUndefined();
    } finally {
      try {
        frontendState.stopAllFrontendProcesses("backend_unloaded");
      } finally {
        eventBus.emit = originalEmit;
      }
    }

    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend metadata test could not capture Bun.spawn");
    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });
    let cleanupHost: WorkerHost | null = null;
    try {
      const { host: backendHost, messages: backendMessages } = createProcessHost();
      cleanupHost = backendHost;
      const backendMethods = backendHost as unknown as {
        resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
        getStorageRootPath: () => string;
        getBackendProcessRuntimeMode: () => "process";
        stopAllBackendProcesses: (reason: string) => void;
      };
      backendMethods.resolveBackendProcessEntryPath = async () => "/tmp/backend-metadata-shape.js";
      backendMethods.getStorageRootPath = () => "/tmp/backend-metadata-shape-storage";
      backendMethods.getBackendProcessRuntimeMode = () => "process";
      const backendState = backendHost as unknown as {
        backendProcesses: Map<string, unknown>;
        backendProcessKeyIndex: Map<string, string>;
      };
      for (const [index, metadata] of invalidMetadata.entries()) {
        const requestId = `backend-metadata-shape-${index}`;
        await invokeHandleBackendProcessSpawn(backendHost, requestId, {
          entry: "dist/backend.js",
          kind: "metadata-shape",
          key: `invalid-${index}`,
          userId: "user-1",
          metadata,
        });
        const response = responseFor(backendMessages, requestId);
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`backend metadata ${String(metadata)} was accepted`);
        }
        expect(response.error).toMatch(/spawn metadata.*(plain object|object)/i);
        expect(backendState.backendProcesses.size).toBe(0);
        expect(backendState.backendProcessKeyIndex.size).toBe(0);
        expect(spawnCalls).toBe(0);
        expect(sentToRuntime).toHaveLength(0);
      }

      await invokeHandleBackendProcessSpawn(backendHost, "backend-metadata-omitted", {
        entry: "dist/backend.js",
        kind: "metadata-shape",
        key: "omitted",
        userId: "user-1",
      });
      await invokeHandleBackendProcessSpawn(backendHost, "backend-metadata-object", {
        entry: "dist/backend.js",
        kind: "metadata-shape",
        key: "object",
        userId: "user-1",
        payload: null,
        metadata: { source: "test" },
      });
      expect(backendState.backendProcesses.size).toBe(2);
      expect(backendState.backendProcessKeyIndex.size).toBe(2);
      expect(spawnCalls).toBe(2);
      const initMessages = sentToRuntime.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "init",
      );
      expect(initMessages).toHaveLength(2);
      expect(initMessages.at(-1)).toEqual(expect.objectContaining({
        type: "init",
        process: expect.objectContaining({
          payload: null,
          metadata: { source: "test" },
        }),
      }));
      expect(responseFor(backendMessages, "backend-metadata-omitted")).toBeUndefined();
      expect(responseFor(backendMessages, "backend-metadata-object")).toBeUndefined();
    } finally {
      try {
        if (cleanupHost) {
          const cleanupState = cleanupHost as unknown as {
            backendProcesses: Map<string, unknown>;
            backendProcessKeyIndex: Map<string, string>;
            stopAllBackendProcesses: (reason: string) => void;
          };
          cleanupState.stopAllBackendProcesses("backend_unloaded");
          expect(cleanupState.backendProcesses.size).toBe(0);
          expect(cleanupState.backendProcessKeyIndex.size).toBe(0);
        }
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
  });

  test.serial("bounds frontend kind and key at exact UTF-8 limits before admission", () => {
    const utf8AtLimit = (bytes: number): string => "🙂".repeat(bytes / 4);
    const cases = [
      { field: "kind" as const, maxBytes: MANAGED_PROCESS_MAX_KIND_BYTES },
      { field: "key" as const, maxBytes: MANAGED_PROCESS_MAX_KEY_BYTES },
    ];
    for (const current of cases) {
      const atLimit = utf8AtLimit(current.maxBytes);
      const overLimit = `${atLimit}a`;
      const run = (value: string, requestId: string): {
        host: WorkerHost;
        messages: unknown[];
        events: unknown[];
        state: { frontendProcesses: Map<string, unknown>; frontendProcessKeyIndex: Map<string, string> };
      } => {
        const { host, messages } = createProcessHost();
        const state = host as unknown as {
          frontendProcesses: Map<string, unknown>;
          frontendProcessKeyIndex: Map<string, string>;
          stopAllFrontendProcesses: (reason: string) => void;
        };
        const events: unknown[] = [];
        const originalEmit = eventBus.emit;
        eventBus.emit = ((event: EventType, payload: unknown) => {
          if (event === EventType.SPINDLE_FRONTEND_PROCESS) events.push(payload);
        }) as typeof eventBus.emit;
        try {
          const options = current.field === "kind"
            ? { kind: value, key: "bounded-key", userId: "user-1" }
            : { kind: "bounded-kind", key: value, userId: "user-1" };
          invokeHandleMessageInScope(host, {
            type: "frontend_process_spawn",
            requestId,
            options,
          });
          return { host, messages, events, state };
        } finally {
          eventBus.emit = originalEmit;
        }
      };

      const accepted = run(atLimit, `frontend-${current.field}-at-limit`);
      try {
        expect(responseFor(accepted.messages, `frontend-${current.field}-at-limit`)).toBeUndefined();
        expect(accepted.state.frontendProcesses.size).toBe(1);
        expect(accepted.state.frontendProcessKeyIndex.size).toBe(1);
        expect(accepted.events.filter((value) =>
          typeof value === "object" &&
          value !== null &&
          "action" in value &&
          value.action === "spawn",
        )).toHaveLength(1);
      } finally {
        (accepted.state as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
      }

      const rejected = run(overLimit, `frontend-${current.field}-over-limit`);
      try {
        const response = responseFor(rejected.messages, `frontend-${current.field}-over-limit`);
        if (typeof response !== "object" || response === null || !("error" in response)) {
          throw new Error(`${current.field} over-limit spawn was not rejected`);
        }
        expect(response.error).toMatch(new RegExp(`${current.field}.*${current.maxBytes}.*UTF-8`, "i"));
        expect(rejected.events).toHaveLength(0);
        expect(rejected.state.frontendProcesses.size).toBe(0);
        expect(rejected.state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        (rejected.state as unknown as { stopAllFrontendProcesses: (reason: string) => void })
          .stopAllFrontendProcesses("backend_unloaded");
      }
    }
  });
  test.serial("bounds backend entry, kind, and key at exact UTF-8 limits before transport creation", async () => {
    const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
    if (!originalSpawnDescriptor) throw new Error("backend string-bound test could not capture Bun.spawn");
    const sentToRuntime: unknown[] = [];
    let spawnCalls = 0;
    const fakeRuntime = {
      pid: 321,
      send(message: unknown) {
        sentToRuntime.push(message);
      },
      kill() {},
    };
    let cleanupHost: { stopAllBackendProcesses: (reason: string) => void } | null = null;
    try {
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        return fakeRuntime;
      },
    });
    const utf8AtLimit = (bytes: number): string => "🙂".repeat(bytes / 4);
    const cases = [
      { field: "entry" as const, maxBytes: MANAGED_PROCESS_MAX_ENTRY_BYTES },
      { field: "kind" as const, maxBytes: MANAGED_PROCESS_MAX_KIND_BYTES },
      { field: "key" as const, maxBytes: MANAGED_PROCESS_MAX_KEY_BYTES },
    ];
      for (const current of cases) {
        const { host, messages } = createProcessHost();
        cleanupHost = host as unknown as { stopAllBackendProcesses: (reason: string) => void };
        const methods = host as unknown as {
          resolveBackendProcessEntryPath: (entry: string) => Promise<string>;
          getStorageRootPath: () => string;
          getBackendProcessRuntimeMode: () => "process";
          stopAllBackendProcesses: (reason: string) => void;
        };
        const state = host as unknown as {
          backendProcesses: Map<string, unknown>;
          backendProcessKeyIndex: Map<string, string>;
        };
        methods.resolveBackendProcessEntryPath = async () => "/tmp/backend-string-bound.js";
        methods.getStorageRootPath = () => "/tmp/backend-string-bound-storage";
        methods.getBackendProcessRuntimeMode = () => "process";
        const atLimit = utf8AtLimit(current.maxBytes);
        const acceptedOptions = current.field === "entry"
          ? { entry: atLimit, kind: "bounded-kind", key: "bounded-key", userId: "user-1" }
          : current.field === "kind"
            ? { entry: "dist/backend.js", kind: atLimit, key: "bounded-key", userId: "user-1" }
            : { entry: "dist/backend.js", kind: "bounded-kind", key: atLimit, userId: "user-1" };
        try {
          await invokeHandleBackendProcessSpawn(host, `backend-${current.field}-at-limit`, acceptedOptions);
          expect(responseFor(messages, `backend-${current.field}-at-limit`)).toBeUndefined();
          expect(state.backendProcesses.size).toBe(1);
          expect(state.backendProcessKeyIndex.size).toBe(1);
          expect(spawnCalls).toBeGreaterThan(0);
          methods.stopAllBackendProcesses("backend_unloaded");
          expect(state.backendProcesses.size).toBe(0);
          expect(state.backendProcessKeyIndex.size).toBe(0);

          const overLimit = `${atLimit}a`;
          const rejectedOptions = current.field === "entry"
            ? { entry: overLimit, kind: "bounded-kind", key: "over-limit", userId: "user-1" }
            : current.field === "kind"
              ? { entry: "dist/backend.js", kind: overLimit, key: "over-limit", userId: "user-1" }
              : { entry: "dist/backend.js", kind: "bounded-kind", key: overLimit, userId: "user-1" };
          const beforeSpawnCalls = spawnCalls;
          await invokeHandleBackendProcessSpawn(host, `backend-${current.field}-over-limit`, rejectedOptions);
          const response = responseFor(messages, `backend-${current.field}-over-limit`);
          if (typeof response !== "object" || response === null || !("error" in response)) {
            throw new Error(`${current.field} over-limit backend spawn was not rejected`);
          }
          expect(response.error).toMatch(new RegExp(`${current.field}.*${current.maxBytes}.*UTF-8`, "i"));
          expect(state.backendProcesses.size).toBe(0);
          expect(state.backendProcessKeyIndex.size).toBe(0);
          expect(spawnCalls).toBe(beforeSpawnCalls);
          expect(sentToRuntime.some((message) => JSON.stringify(message).includes(overLimit))).toBe(false);
        } finally {
          methods.stopAllBackendProcesses("backend_unloaded");
          expect(state.backendProcesses.size).toBe(0);
          expect(state.backendProcessKeyIndex.size).toBe(0);
        }
      }
    } finally {
      try {
        cleanupHost?.stopAllBackendProcesses("backend_unloaded");
      } finally {
        Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
      }
    }
  });
  test.serial("bounds frontend process ids and lifecycle reason/error strings at UTF-8 boundaries", () => {
    const utf8AtLimit = (bytes: number): string => "🙂".repeat(bytes / 4);
    const processIdAtLimit = utf8AtLimit(MANAGED_PROCESS_MAX_PROCESS_ID_BYTES);
    const processIdOverLimit = `${processIdAtLimit}a`;
    const reasonAtLimit = utf8AtLimit(MANAGED_PROCESS_MAX_REASON_BYTES);
    const reasonOverLimit = `${reasonAtLimit}a`;
    const errorAtLimit = utf8AtLimit(MANAGED_PROCESS_MAX_ERROR_BYTES);
    const errorOverLimit = `${errorAtLimit}a`;
    const { host, messages } = createProcessHost();
    const state = host as unknown as {
      frontendProcesses: Map<string, unknown>;
      frontendProcessKeyIndex: Map<string, unknown>;
      stopAllFrontendProcesses: (reason: string) => void;
    };
    const originalEmit = eventBus.emit;
    const events: unknown[] = [];
    eventBus.emit = ((event: EventType, payload: unknown) => {
      if (event === EventType.SPINDLE_FRONTEND_PROCESS) events.push(payload);
    }) as typeof eventBus.emit;
    try {
      invokeHandleMessageInScope(host, {
        type: "frontend_process_get",
        requestId: "frontend-process-id-at-limit",
        processId: processIdAtLimit,
      });
      expect(responseFor(messages, "frontend-process-id-at-limit")).toEqual({
        type: "response",
        requestId: "frontend-process-id-at-limit",
        result: null,
      });
      invokeHandleMessageInScope(host, {
        type: "frontend_process_get",
        requestId: "frontend-process-id-over-limit",
        processId: processIdOverLimit,
      });
      const processIdResponse = responseFor(messages, "frontend-process-id-over-limit");
      if (typeof processIdResponse !== "object" || processIdResponse === null || !("error" in processIdResponse)) {
        throw new Error("oversized frontend process id was not rejected");
      }
      expect(processIdResponse.error).toMatch(/processId.*128.*UTF-8/i);

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-error-boundary",
        options: { kind: "error-boundary", key: "error-boundary", userId: "user-1" },
      });
      const spawn = events.find((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      );
      if (typeof spawn !== "object" || spawn === null || !("processId" in spawn) || typeof spawn.processId !== "string") {
        throw new Error("error boundary frontend spawn did not expose a process id");
      }
      const processId = spawn.processId;
      const lifecycleMessagesBeforeError = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_lifecycle",
      );
      const eventsBeforeError = events.length;
      host.handleFrontendProcessEvent(processId, "user-1", "fail", errorAtLimit);
      expect(events).toHaveLength(eventsBeforeError);
      const lifecycleMessagesAfterError = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_lifecycle",
      );
      expect(lifecycleMessagesAfterError).toHaveLength(lifecycleMessagesBeforeError.length + 1);
      expect(lifecycleMessagesAfterError.at(-1)).toEqual({
        type: "frontend_process_lifecycle",
        event: expect.objectContaining({
          processId,
          kind: "error-boundary",
          key: "error-boundary",
          userId: "user-1",
          state: "failed",
          previousState: "starting",
          exitReason: "failed",
          error: errorAtLimit,
        }),
      });
      expect(state.frontendProcesses.get(processId)).toBeUndefined();
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);
      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-error-over-limit",
        options: { kind: "error-boundary-over", key: "error-boundary-over", userId: "user-1" },
      });
      const oversizedSpawn = events.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn" &&
        "kind" in payload &&
        payload.kind === "error-boundary-over",
      ).at(-1);
      if (
        typeof oversizedSpawn !== "object" ||
        oversizedSpawn === null ||
        !("processId" in oversizedSpawn) ||
        typeof oversizedSpawn.processId !== "string"
      ) {
        throw new Error("oversized error boundary frontend spawn did not expose a process id");
      }
      const oversizedProcessId = oversizedSpawn.processId;
      const eventsBeforeOversizedError = events.length;
      const lifecycleMessagesBeforeOversizedError = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_lifecycle",
      );
      host.handleFrontendProcessEvent(oversizedProcessId, "user-1", "fail", errorOverLimit);
      expect(events).toHaveLength(eventsBeforeOversizedError);
      const lifecycleMessagesAfterOversizedError = messages.filter((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "frontend_process_lifecycle",
      );
      expect(lifecycleMessagesAfterOversizedError).toHaveLength(lifecycleMessagesBeforeOversizedError.length);
      expect((state.frontendProcesses.get(oversizedProcessId) as { state?: unknown } | undefined)?.state).toBe("starting");
      state.stopAllFrontendProcesses("backend_unloaded");
      expect(state.frontendProcesses.size).toBe(0);
      expect(state.frontendProcessKeyIndex.size).toBe(0);

      invokeHandleMessageInScope(host, {
        type: "frontend_process_spawn",
        requestId: "frontend-reason-boundary",
        options: { kind: "reason-boundary", key: "reason-boundary", userId: "user-1" },
      });
      const reasonSpawn = events.filter((payload) =>
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        payload.action === "spawn",
      ).at(-1);
      if (typeof reasonSpawn !== "object" || reasonSpawn === null || !("processId" in reasonSpawn) || typeof reasonSpawn.processId !== "string") {
        throw new Error("reason boundary frontend spawn did not expose a process id");
      }
      const reasonProcessId = reasonSpawn.processId;
      invokeHandleMessageInScope(host, {
        type: "frontend_process_stop",
        requestId: "frontend-reason-at-limit",
        processId: reasonProcessId,
        options: { userId: "user-1", reason: reasonAtLimit },
      });
      expect(responseFor(messages, "frontend-reason-at-limit")).toEqual({
        type: "response",
        requestId: "frontend-reason-at-limit",
        result: undefined,
      });
      expect(state.frontendProcesses.size).toBe(1);

      invokeHandleMessageInScope(host, {
        type: "frontend_process_stop",
        requestId: "frontend-reason-over-limit",
        processId: reasonProcessId,
        options: { userId: "user-1", reason: reasonOverLimit },
      });
      const reasonResponse = responseFor(messages, "frontend-reason-over-limit");
      if (typeof reasonResponse !== "object" || reasonResponse === null || !("error" in reasonResponse)) {
        throw new Error("oversized frontend reason was not rejected");
      }
      expect(reasonResponse.error).toMatch(/reason.*4096.*UTF-8/i);
      expect(state.frontendProcesses.size).toBe(1);
    } finally {
      try {
        state.stopAllFrontendProcesses("backend_unloaded");
        expect(state.frontendProcesses.size).toBe(0);
        expect(state.frontendProcessKeyIndex.size).toBe(0);
      } finally {
        eventBus.emit = originalEmit;
      }
    }
  });
});

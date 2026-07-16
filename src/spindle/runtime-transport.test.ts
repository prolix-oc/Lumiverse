import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { createRuntimeTransport } from "./runtime-transport";
import type { RuntimeTransport } from "./runtime-transport";
import { isSensitiveEnvironmentKey } from "./dangerous-runtime-policy";

test.serial("explicit sandbox mode fails closed on unsupported platforms", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalSpawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn");
  if (!originalPlatformDescriptor || !originalSpawnDescriptor) {
    throw new Error("runtime transport test could not capture global descriptors");
  }
  let spawnCalls = 0;
  try {
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "linux",
    });
    Object.defineProperty(Bun, "spawn", {
      ...originalSpawnDescriptor,
      value: (..._args: unknown[]) => {
        spawnCalls += 1;
        throw new Error("sandbox regression attempted runtime creation");
      },
    });

    expect(() =>
      createRuntimeTransport({
        runtimePath: "/definitely/not-a-runtime.ts",
        extensionIdentifier: "sandbox-platform-test",
        repoPath: "/definitely/not-a-repo",
        storagePath: "/definitely/not-storage",
        mode: "sandbox",
        onMessage() {},
        onError() {},
        onExit() {},
      }),
    ).toThrow(/Sandbox mode requires macOS.*refusing to downgrade to process mode/);
    expect(spawnCalls).toBe(0);
  } finally {
    try {
      Object.defineProperty(Bun, "spawn", originalSpawnDescriptor);
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

const ENV_KEYS_TO_CHECK = [
  "PATH",
  "TMPDIR",
  "LUMIVERSE_CONFIG",
  "AUTH_TOKEN",
  "SECRET_VALUE",
  "DATABASE_URL",
  "AWS_ACCESS_KEY_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "PRIVATE_KEY_PEM",
  "SESSION_COOKIE",
  "JWT_SIGNING_KEY",
] as const;

type TransportProbe = {
  env: Record<string, unknown>;
  ownKeys: string[];
  descriptorKeys: string[];
  spreadKeys: string[];
};

function isTransportProbe(value: unknown): value is TransportProbe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("env" in value) || !("ownKeys" in value) || !("descriptorKeys" in value) || !("spreadKeys" in value)) {
    return false;
  }
  return (
    typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) &&
    Array.isArray(value.ownKeys) && value.ownKeys.every((key) => typeof key === "string") &&
    Array.isArray(value.descriptorKeys) && value.descriptorKeys.every((key) => typeof key === "string") &&
    Array.isArray(value.spreadKeys) && value.spreadKeys.every((key) => typeof key === "string")
  );
}

test("process transport receives only the safe environment projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-runtime-transport-"));
  const previous = new Map<string, string | undefined>();
  const overrides: Record<string, string> = {
    PATH: dirname(process.execPath),
    TMPDIR: directory,
    LUMIVERSE_CONFIG: "do-not-forward",
    AUTH_TOKEN: "do-not-forward",
    SECRET_VALUE: "do-not-forward",
    DATABASE_URL: "postgres://secret@example.test/db",
    AWS_ACCESS_KEY_ID: "do-not-forward",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/credentials.json",
    PRIVATE_KEY_PEM: "do-not-forward",
    TRANSPORT_PROBE_EXIT_CODE: "0",
    SESSION_COOKIE: "do-not-forward",
    JWT_SIGNING_KEY: "do-not-forward",
  };
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const runtimePath = join(directory, "env-probe.ts");
  writeFileSync(
    runtimePath,
    `
      if (typeof process.send !== "function") throw new Error("IPC is unavailable");
      const env = Object.fromEntries(${JSON.stringify(ENV_KEYS_TO_CHECK)}.map((name) => [name, process.env[name]]));
      const ownKeys = Reflect.ownKeys(process.env).filter((key) => typeof key === "string");
      const descriptorKeys = ${JSON.stringify(ENV_KEYS_TO_CHECK)}.filter((name) => Object.getOwnPropertyDescriptor(process.env, name) !== undefined);
      const spreadKeys = Object.keys({ ...process.env });
      process.send({ env, ownKeys, descriptorKeys, spreadKeys });
      process.exitCode = Number(process.env.TRANSPORT_PROBE_EXIT_CODE ?? "0");
    `,
    "utf8",
  );
  const hangingRuntimePath = join(directory, "hanging-probe.ts");
  writeFileSync(
    hangingRuntimePath,
    `
      if (typeof process.send !== "function") throw new Error("IPC is unavailable");
      process.send({ ready: true }, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `,
    "utf8",
  );

  let transport: RuntimeTransport | undefined;
  const exited = Promise.withResolvers<void>();
  let payloadSettled = false;
  let normalPayloadReceived = false;
  let normalExitObservedAfterPayload = false;
  let normalTerminateCalls = 0;
  let transportExited = false;
  let hangingTransport: RuntimeTransport | undefined;
  let hangingExitObserved = false;
  try {
    const received = await new Promise<TransportProbe>((resolve, reject) => {
      transport = createRuntimeTransport({
        runtimePath,
        extensionIdentifier: "transport-test",
        repoPath: directory,
        storagePath: join(directory, "storage"),
        mode: "process",
        onMessage(message: unknown) {
          normalPayloadReceived = true;
          if (!isTransportProbe(message)) {
            payloadSettled = true;
            transport?.terminate(true);
            reject(new Error("transport probe returned an invalid payload"));
            return;
          }
          payloadSettled = true;
          resolve(message);
        },
        onError(message) {
          if (payloadSettled) return;
          payloadSettled = true;
          reject(new Error(message));
        },
        onExit(exitCode, signalCode, error) {
          transportExited = true;
          normalExitObservedAfterPayload = normalPayloadReceived;
          if (error) {
            exited.reject(error);
          } else if (exitCode !== 0 || signalCode !== null) {
            exited.reject(new Error(`transport probe exited abnormally: ${exitCode ?? "null"}/${signalCode ?? "null"}`));
          } else {
            exited.resolve();
          }
          if (payloadSettled) return;
          payloadSettled = true;
          reject(new Error("transport probe exited before reporting its environment"));
        },
      });
      if (transport) {
        const originalTerminate = transport.terminate.bind(transport);
        transport.terminate = (force = false): void => {
          normalTerminateCalls += 1;
          originalTerminate(force);
        };
      }
    });

    await exited.promise;
    expect(transportExited).toBe(true);
    expect(normalPayloadReceived).toBe(true);
    expect(normalExitObservedAfterPayload).toBe(true);
    expect(normalTerminateCalls).toBe(0);

    expect(received.env.PATH).toBe(dirname(process.execPath));
    expect(received.env.TMPDIR).toBe(directory);
    for (const key of ENV_KEYS_TO_CHECK.slice(2)) {
      expect(received.env[key], `${key} must be scrubbed from transport`).toBeUndefined();
    }
    expect(received.ownKeys.every((key) => !isSensitiveEnvironmentKey(key))).toBe(true);
    expect(received.descriptorKeys).toEqual(["PATH", "TMPDIR"]);
    expect(received.spreadKeys.every((key) => !isSensitiveEnvironmentKey(key))).toBe(true);
    process.env.TRANSPORT_PROBE_EXIT_CODE = "7";
    let abnormalPayloadReceived = false;
    let abnormalExitRejected = false;
    try {
      await new Promise<void>((resolve, reject) => {
        createRuntimeTransport({
          runtimePath,
          extensionIdentifier: "transport-abnormal-exit-test",
          repoPath: directory,
          storagePath: join(directory, "storage"),
          mode: "process",
          onMessage(message) {
            abnormalPayloadReceived = isTransportProbe(message);
          },
          onError(message) {
            reject(new Error(message));
          },
          onExit(exitCode, signalCode, error) {
            if (error) {
              reject(error);
              return;
            }
            if (exitCode === 7 && signalCode === null && abnormalPayloadReceived) {
              reject(new Error("transport probe exited abnormally after payload: 7/null"));
              return;
            }
            resolve();
          },
        });
      });
    } catch (error) {
      abnormalExitRejected =
        error instanceof Error &&
        error.message === "transport probe exited abnormally after payload: 7/null";
    }
    expect(abnormalPayloadReceived).toBe(true);
    const hangingReady = Promise.withResolvers<void>();
    const hangingDone = Promise.withResolvers<void>();
    hangingTransport = createRuntimeTransport({
      runtimePath: hangingRuntimePath,
      extensionIdentifier: "transport-timeout-test",
      repoPath: directory,
      storagePath: join(directory, "storage"),
      mode: "process",
      onMessage(message) {
        if (
          typeof message === "object" &&
          message !== null &&
          "ready" in message &&
          message.ready === true
        ) {
          hangingReady.resolve();
        }
      },
      onError(message) {
        hangingDone.reject(new Error(message));
      },
      onExit(_exitCode, _signalCode, error) {
        hangingExitObserved = true;
        if (error) {
          hangingDone.reject(error);
        } else {
          hangingDone.resolve();
        }
      },
    });
    await hangingReady.promise;
    let deadlineReached = false;
    // This is the integration boundary under test: a stuck child must be
    // force-terminated at a bounded deadline, then fully reaped before cleanup.
    const deadline = setTimeout(() => {
      deadlineReached = true;
      hangingTransport?.terminate(true);
    }, 250);
    try {
      await hangingDone.promise;
    } finally {
      clearTimeout(deadline);
      if (!hangingExitObserved) hangingTransport.terminate(true);
    }
    expect(deadlineReached).toBe(true);
    expect(hangingExitObserved).toBe(true);
    expect(abnormalExitRejected).toBe(true);
    if (transport && !transportExited) transport.terminate(true);
  } finally {
    if (hangingTransport && !hangingExitObserved) hangingTransport.terminate(true);
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, { timeout: 5_000 });

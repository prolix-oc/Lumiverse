import { describe, expect, test } from "bun:test";

describe("initializeSandbox", () => {
  test("preserves Function prototype helpers while blocking constructor use", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const originalCall = Function.prototype.call;
          const originalApply = Function.prototype.apply;
          const originalBind = Function.prototype.bind;

          initializeSandbox();

          if (Function.prototype.call !== originalCall) throw new Error("call changed");
          if (Function.prototype.apply !== originalApply) throw new Error("apply changed");
          if (Function.prototype.bind !== originalBind) throw new Error("bind changed");

          let blocked = false;
          try {
            new Function("return 1");
          } catch (error) {
            blocked = error instanceof Error && error.message === "Function constructor is disabled in extension context";
          }
          if (!blocked) throw new Error("Function constructor was not blocked");

          blocked = false;
          try {
            Function.prototype.constructor("return 1");
          } catch (error) {
            blocked = error instanceof Error && error.message === "Function constructor is disabled in extension context";
          }
          if (!blocked) throw new Error("Function.prototype.constructor was not blocked");

          blocked = false;
          try {
            eval("1 + 1");
          } catch (error) {
            blocked = error instanceof Error && error.message === "eval is disabled in extension context";
          }
          if (!blocked) throw new Error("eval was not blocked");
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("blocks every function constructor prototype while preserving captured async handlers", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const NativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          initializeSandbox();

          const attempts = [
            ["function", () => (function () {}).constructor("return 1")],
            ["async function", () => (async function () {}).constructor("return 1")],
            ["generator", () => (function* () {}).constructor("yield 1")],
            ["async generator", () => (async function* () {}).constructor("yield 1")],
            ["Object", () => Object.constructor("return 1")],
          ];
          for (const [label, attempt] of attempts) {
            let blocked = false;
            try {
              attempt();
            } catch (error) {
              blocked = error instanceof Error && error.message === "Function constructor is disabled in extension context";
            }
            if (!blocked) throw new Error(label + " constructor was not blocked");
          }

          const approved = Reflect.construct(NativeAsyncFunction, [
            "ctx",
            '"use strict"; return await Promise.resolve(ctx.value);',
          ]);
          const value = await approved({ value: "approved" });
          if (value !== "approved") throw new Error("captured async handler failed");
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
  test("blocks every dynamic constructor when allowDynamicCode is false", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          initializeSandbox({ allowDynamicCode: false });
          const attempts = [
            ["Function", () => new Function("return 1")],
            ["async Function", () => (Object.getPrototypeOf(async function () {}).constructor)("return 1")],
            ["generator Function", () => (Object.getPrototypeOf(function* () {}).constructor)("yield 1")],
            ["async generator Function", () => (Object.getPrototypeOf(async function* () {}).constructor)("yield 1")],
          ];
          for (const [label, attempt] of attempts) {
            let blocked = false;
            try {
              attempt();
            } catch (error) {
              blocked = error instanceof Error &&
                error.message === "Function constructor is disabled in extension context";
            }
            if (!blocked) throw new Error(label + " constructor was not blocked");
          }
        `,
      ],
      timeout: 1_000,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("allows dynamic constructors only when opted in and keeps hard guards active", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";
          import { createRequire } from "node:module";
          Object.defineProperty(globalThis, "require", {
            value: createRequire(import.meta.url),
            writable: true,
            configurable: true,
          });
          if (globalThis.module === undefined) {
            Object.defineProperty(globalThis, "module", {
              value: { require: globalThis.require },
              writable: true,
              configurable: true,
            });
          }

          initializeSandbox({ allowDynamicCode: true });
          const value = new Function("return 41")();
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const asyncValue = await AsyncFunction("return 42")();
          const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
          const generatorValue = new GeneratorFunction("yield 43")().next().value;
          const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
          const asyncGeneratorValue = (await new AsyncGeneratorFunction("yield 44")().next()).value;
          if (value !== 41 || asyncValue !== 42 || generatorValue !== 43 || asyncGeneratorValue !== 44) {
            throw new Error("dynamic constructors did not execute after explicit opt-in");
          }

          const blockedCalls = [
            ["module", () => globalThis.import("bun:jsc"), "Module 'bun:jsc' is blocked in extension context"],
            ["require", () => globalThis.require("bun:jsc"), "Module 'bun:jsc' is blocked in extension context"],
            ["module.require", () => globalThis.module.require("bun:jsc"), "Module 'bun:jsc' is blocked in extension context"],
            ["process", () => process.getBuiltinModule("fs"), "process.getBuiltinModule is disabled in extension context"],
            ["network", () => fetch("https://example.test"), "fetch is disabled in extension context"],
            ["filesystem", () => Bun.file("/tmp/sandbox-policy-denied"), "Bun.file is disabled in extension context"],
          ];
          for (const [label, attempt, expected] of blockedCalls) {
            let blocked = false;
            try {
              await attempt();
            } catch (error) {
              blocked = error instanceof Error && error.message === expected;
            }
            if (!blocked) throw new Error(label + " guard was weakened by dynamic-code opt-in");
          }
        `,
      ],
      stdout: "pipe",
      timeout: 1_000,
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("guards global require for module-loader and native FFI specifiers", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { createRequire } from "node:module";
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          Object.defineProperty(globalThis, "require", {
            value: createRequire(import.meta.url),
            writable: true,
            configurable: true,
          });
          initializeSandbox();

          const guardedRequire = globalThis.require;
          if (typeof guardedRequire !== "function") throw new Error("guarded require missing");

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
            let blocked = false;
            try {
              guardedRequire(specifier);
            } catch (error) {
              blocked =
                error instanceof Error &&
                error.message === \`Module '\${specifier}' is blocked in extension context\`;
            }
            if (!blocked) throw new Error(\`require('\${specifier}') was not blocked\`);
          }

          const processAttempts = [
            ["direct", () => process.getBuiltinModule("fs")],
            ["destructured", () => {
              const { getBuiltinModule } = process;
              return getBuiltinModule("fs");
            }],
            ["aliased", () => {
              const loader = process.getBuiltinModule;
              return loader("fs");
            }],
          ];
          for (const [label, attempt] of processAttempts) {
            let blocked = false;
            try {
              attempt();
            } catch (error) {
              blocked =
                error instanceof Error &&
                error.message === "process.getBuiltinModule is disabled in extension context";
            }
            if (!blocked) throw new Error(\`process getBuiltinModule \${label} was not blocked\`);
          }

          if (guardedRequire.main !== undefined) {
            throw new Error("guarded require exposed main loader");
          }
          if (guardedRequire.cache !== undefined) {
            throw new Error("guarded require exposed cache loaders");
          }

          const path = guardedRequire("path");
          if (path.basename("/tmp/safe.txt") !== "safe.txt") {
            throw new Error("safe third-party require was blocked");
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("blocks mutable runtime globals and scrubs Bun.env and process.env", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { createRequire } from "node:module";
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          if (typeof globalThis.require !== "function") {
            Object.defineProperty(globalThis, "require", {
              value: createRequire(import.meta.url),
              writable: true,
              configurable: true,
            });
          }

          process.env.SECRET_FOR_SANDBOX = "must-disappear";
          process.env.AUTH_TOKEN_FOR_SANDBOX = "must-disappear";
          process.env.PATH = "/sandbox-safe/bin";
          process.env.TMPDIR = "/sandbox-safe/tmp";
          const protectedValues = [
            [globalThis, "fetch", globalThis.fetch],
            [globalThis, "WebSocket", globalThis.WebSocket],
            [globalThis, "Worker", globalThis.Worker],
            [globalThis, "BroadcastChannel", globalThis.BroadcastChannel],
            [process, "binding", process.binding],
            [process, "_linkedBinding", process._linkedBinding],
            [Bun, "file", Bun.file],
            [process, "getBuiltinModule", process.getBuiltinModule],
            [Bun, "spawn", Bun.spawn],
            [Bun, "serve", Bun.serve],
            [globalThis, "eval", globalThis.eval],
            [globalThis, "Function", globalThis.Function],
            [globalThis, "require", globalThis.require],
          ];
          initializeSandbox();
          const importDescriptor = Object.getOwnPropertyDescriptor(globalThis, "import");
          if (
            typeof globalThis.import !== "function" ||
            !importDescriptor ||
            importDescriptor.writable !== false ||
            importDescriptor.configurable !== false
          ) {
            throw new Error("globalThis.import guard descriptor is missing or mutable");
          }
          let importBlocked = false;
          try {
            await globalThis.import("node:fs");
          } catch (error) {
            importBlocked =
              error instanceof Error &&
              error.message === "Module 'node:fs' is blocked in extension context";
          }
          if (!importBlocked) throw new Error("globalThis.import did not block node:fs");

          const guardedImport = globalThis.import;
          let importReassignmentError = false;
          try {
            globalThis.import = () => undefined;
          } catch (error) {
            importReassignmentError = error instanceof TypeError;
          }
          const importAfterDescriptor = Object.getOwnPropertyDescriptor(globalThis, "import");
          if (
            !importReassignmentError ||
            globalThis.import !== guardedImport ||
            !importAfterDescriptor ||
            importAfterDescriptor.value !== guardedImport ||
            importAfterDescriptor.writable !== false ||
            importAfterDescriptor.configurable !== false
          ) {
            throw new Error("globalThis.import guard was replaceable");
          }
          for (const [owner, key, original] of protectedValues) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (!descriptor || descriptor.writable !== false || descriptor.configurable !== false) {
              throw new Error(key + " guard descriptor is mutable");
            }
            const replacement = () => undefined;
            try {
              owner[key] = replacement;
            } catch {}
            if (owner[key] === replacement || owner[key] === original) {
              throw new Error(key + " guard was replaceable");
            }
          }

          const sensitive = ["SECRET_FOR_SANDBOX", "AUTH_TOKEN_FOR_SANDBOX"];
          for (const key of sensitive) {
            if (process.env[key] !== undefined) throw new Error("process.env leaked " + key);
            if (Bun.env[key] !== undefined) throw new Error("Bun.env leaked " + key);
            if (Object.keys(process.env).includes(key)) throw new Error("process.env keys leaked " + key);
            if (Reflect.ownKeys(process.env).includes(key)) throw new Error("process.env ownKeys leaked " + key);
            if (Object.getOwnPropertyDescriptor(process.env, key) !== undefined) throw new Error("process.env descriptor leaked " + key);
            if (Object.keys(Bun.env).includes(key)) throw new Error("Bun.env keys leaked " + key);
            if (Reflect.ownKeys(Bun.env).includes(key)) throw new Error("Bun.env ownKeys leaked " + key);
            if (Object.getOwnPropertyDescriptor(Bun.env, key) !== undefined) throw new Error("Bun.env descriptor leaked " + key);
            if (Object.keys({ ...Bun.env }).includes(key)) throw new Error("Bun.env spread leaked " + key);
            if (Object.keys({ ...process.env }).includes(key)) throw new Error("process.env spread leaked " + key);
          }
          if (process.env.PATH !== "/sandbox-safe/bin") throw new Error("PATH was removed");
          if (process.env.TMPDIR !== "/sandbox-safe/tmp") throw new Error("TMPDIR was removed");
          if (Bun.env.PATH !== "/sandbox-safe/bin") throw new Error("Bun PATH was removed");
          if (Bun.env.TMPDIR !== "/sandbox-safe/tmp") throw new Error("Bun TMPDIR was removed");

          let writeBlocked = false;
          try {
            process.env.SECRET_FOR_SANDBOX = "write-attempt";
          } catch (error) {
            writeBlocked =
              error instanceof Error &&
              error.message === "Setting sensitive env var 'SECRET_FOR_SANDBOX' is blocked in extension context";
          }
          if (!writeBlocked) throw new Error("sensitive process.env write was not blocked by the exact guard");
          let bunWriteError = "";
          try {
            Bun.env.SECRET_FOR_SANDBOX = "bun-write-attempt";
          } catch (error) {
            bunWriteError = error instanceof Error ? error.name + ":" + error.message : String(error);
          }
          if (
            bunWriteError !== "TypeError:Attempting to define property on object that is not extensible." ||
            Bun.env.SECRET_FOR_SANDBOX !== undefined ||
            Object.keys(Bun.env).includes("SECRET_FOR_SANDBOX") ||
            Reflect.ownKeys(Bun.env).includes("SECRET_FOR_SANDBOX")
          ) {
            throw new Error("sensitive Bun.env write was not rejected and scrubbed");
          }

          const blockedCalls = [
            ["process.binding", "process.binding is disabled in extension context", () => process.binding("fs")],
            ["process._linkedBinding", "process._linkedBinding is disabled in extension context", () => process._linkedBinding("fs")],
            ["process.getBuiltinModule", "process.getBuiltinModule is disabled in extension context", () => process.getBuiltinModule("fs")],
            ["fetch", "fetch is disabled in extension context", () => fetch("https://example.test")],
            ["WebSocket", "WebSocket is disabled in extension context", () => new WebSocket("wss://example.test")],
            ["Worker", "Worker is disabled in extension context", () => new Worker("data:text/javascript,export default 1")],
            ["BroadcastChannel", "BroadcastChannel is disabled in extension context", () => new BroadcastChannel("extension-test")],
          ];
          for (const [label, expected, attempt] of blockedCalls) {
            let blocked = false;
            try {
              attempt();
            } catch (error) {
              blocked = error instanceof Error && error.message === expected;
            }
            if (!blocked) throw new Error(label + " was not blocked by the sandbox guard");
          }

          const bunCalls = [
            ["Bun.file", "Bun.file is disabled in extension context", () => Bun.file("/tmp/spindle-sandbox-denied")],
            ["Bun.spawn", "Bun.spawn is disabled in extension context", () => Bun.spawn(["true"])],
            ["Bun.serve", "Bun.serve is disabled in extension context", () => Bun.serve({ port: 0, fetch() { return new Response("no"); } })],
          ];
          for (const [label, expected, attempt] of bunCalls) {
            let blocked = false;
            try {
              attempt();
            } catch (error) {
              blocked = error instanceof Error && error.message === expected;
            }
            if (!blocked) throw new Error(label + " was not blocked by the sandbox guard");
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});

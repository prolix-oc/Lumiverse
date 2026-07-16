import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

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
          const evalValue = eval("40 + 1");
          const evalAliasValue = globalThis.eval("40 + 2");
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const asyncValue = await AsyncFunction("return 42")();
          const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
          const generatorValue = new GeneratorFunction("yield 43")().next().value;
          const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
          const asyncGeneratorValue = (await new AsyncGeneratorFunction("yield 44")().next()).value;
          const important = "important";
          const requirement = "requirement";
          const moduleName = "moduleName";
          globalThis.important = important;
          globalThis.requirement = requirement;
          globalThis.moduleName = moduleName;
          const ordinaryEval = eval("important + requirement + moduleName");
          const ordinaryConstructor = new Function(
            "important",
            "requirement",
            "moduleName",
            "return important + requirement + moduleName",
          )(important, requirement, moduleName);
          if (
            ordinaryEval !== "importantrequirementmoduleName" ||
            ordinaryConstructor !== "importantrequirementmoduleName"
          ) {
            throw new Error("ordinary identifiers were rejected by the dynamic-code scanner");
          }
          if (
            value !== 41 ||
            evalValue !== 41 ||
            evalAliasValue !== 42 ||
            asyncValue !== 42 ||
            generatorValue !== 43 ||
            asyncGeneratorValue !== 44
          ) {
            throw new Error("dynamic constructors or eval did not execute after explicit opt-in");
          }
          const blockedCalls = [
            ["module", () => globalThis.import("bun:jsc"), "Module loading is disabled in extension context"],
            ["require", () => globalThis.require("bun:jsc"), "Module loading is disabled in extension context"],
            ["module.require", () => globalThis.module.require("bun:jsc"), "Module loading is disabled in extension context"],
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
  test("keeps successful guards permanently installed for the one-shot worker lifetime", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const initialized = initializeSandbox({ allowDynamicCode: true });
          if (initialized !== undefined) throw new Error("sandbox exposed a disposer");
          const guardedEval = globalThis.eval;
          const guardedFunction = globalThis.Function;
          const guardedImport = globalThis.import;
          for (const [owner, key] of [
            [globalThis, "eval"],
            [globalThis, "Function"],
            [globalThis, "import"],
          ]) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (!descriptor || descriptor.writable !== false || descriptor.configurable !== false) {
              throw new Error(key + " guard was not permanent");
            }
          }

          if (new Function("return 41")() !== 41) {
            throw new Error("authorized dynamic code did not execute");
          }
          initializeSandbox({ allowDynamicCode: false });
          if (
            globalThis.eval !== guardedEval ||
            globalThis.Function !== guardedFunction ||
            globalThis.import !== guardedImport
          ) {
            throw new Error("one-shot initialization changed a permanent guard");
          }
          if (new Function("return 42")() !== 42) {
            throw new Error("one-shot initialization weakened authorized dynamic code");
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("runs every preflight before mutating host surfaces", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const tracked = [
            [globalThis, "eval"],
            [globalThis, "Function"],
            [process, "exit"],
            [globalThis, "module"],
          ];
          const before = tracked.map(([owner, key]) => ({
            owner,
            key,
            descriptor: Object.getOwnPropertyDescriptor(owner, key),
          }));
          globalThis.__sandbox_side_effect = false;
          const hostileFetch = () => {
            globalThis.__sandbox_side_effect = true;
            return "forged";
          };
          Object.defineProperty(globalThis, "fetch", {
            value: hostileFetch,
            writable: false,
            configurable: false,
            enumerable: true,
          });

          let startupError;
          try {
            initializeSandbox();
          } catch (error) {
            startupError = error;
          }
          if (
            !(startupError instanceof Error) ||
            startupError.message !== "Sandbox guard installation failed (global fetch)"
          ) {
            throw new Error("hostile preflight did not fail closed");
          }
          if (globalThis.__sandbox_side_effect) {
            throw new Error("preflight reached a user side effect");
          }
          for (const { owner, key, descriptor: expected } of before) {
            const actual = Object.getOwnPropertyDescriptor(owner, key);
            for (const property of ["value", "writable", "enumerable", "configurable", "get", "set"]) {
              if (actual?.[property] !== expected?.[property]) {
                throw new Error(key + " changed before preflight completed");
              }
            }
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects static computed import properties before generated side effects", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          initializeSandbox({ allowDynamicCode: true });
          const expected = "Dynamic code is blocked in extension context: module loading";
          const sources = [
            "globalThis.__dynamic_code_ran = true; globalThis[\\\"im\\\" + \\\"port\\\"](\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Reflect.get(globalThis, \\\"im\\\" + \\\"port\\\")(\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Reflect?.get(globalThis, \\\"im\\\" + \\\"port\\\")(\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Reflect.get?.(globalThis, \\\"im\\\" + \\\"port\\\")(\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Object.getOwnPropertyDescriptor(globalThis, \\\"im\\\" + \\\"port\\\").value(\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; return import" + "('fs');",
            "globalThis.__dynamic_code_ran = true; globalThis[(\\\"im\\\" + \\\"port\\\")](\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; globalThis?.[\\\"im\\\" + \\\"port\\\"](\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Reflect.get(globalThis, (\\\"im\\\" + \\\"port\\\"), globalThis)(\\\"node:fs\\\");",
            "globalThis.__dynamic_code_ran = true; Object.getOwnPropertyDescriptors(globalThis)[\\\"im\\\" + \\\"port\\\"].value(\\\"node:fs\\\");",
          ];

          globalThis.__dynamic_code_ran = false;
          let splitImportFailure;
          try {
            Function("globalThis.__dynamic_code_ran = true; return import" + "('fs');")();
          } catch (error) {
            splitImportFailure = error;
          }
          if (
            !(splitImportFailure instanceof Error) ||
            splitImportFailure.message !== expected ||
            globalThis.__dynamic_code_ran
          ) {
            throw new Error("split static import source escaped or ran before rejection");
          }

          for (const source of sources) {
            globalThis.__dynamic_code_ran = false;
            let failure;
            try {
              new Function(source)();
            } catch (error) {
              failure = error;
            }
            if (!(failure instanceof Error) || failure.message !== expected) {
              throw new Error("computed import source escaped the static guard");
            }
            if (globalThis.__dynamic_code_ran) {
              throw new Error("computed import source ran a side effect before rejection");
            }
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("allows safe dynamic code with ordinary identifiers containing import", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          initializeSandbox({ allowDynamicCode: true });
          const importedValue = new Function(
            "importedValue",
            "return importedValue + '!'",
          )("safe");
          const safeLiteral = new Function(
            "return 'globalThis[\\\"im\\\" + \\\"port\\\"]'",
          )();
          const safeComment = new Function(
            "// globalThis[\\\"im\\\" + \\\"port\\\"]\\nreturn 'comment-safe';",
          )();
          const holderValue = new Function(
            "holder",
            "return holder.globalThis[\\\"im\\\" + \\\"port\\\"]()",
          )({ globalThis: { import: () => "local" } });
          if (
            safeLiteral !== 'globalThis["im" + "port"]' ||
            safeComment !== "comment-safe" ||
            holderValue !== "local"
          ) {
            throw new Error("safe strings, comments, or member names were rejected as import access");
          }
          const importableValue = new Function(
            "importableValue",
            "return importableValue",
          )("ordinary");
          if (importedValue !== "safe!" || importableValue !== "ordinary") {
            throw new Error("ordinary identifiers containing import were rejected");
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("rescans hostile dynamic-code source before native execution", () => {
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
          initializeSandbox({ allowDynamicCode: true });

          const sources = [
            ["direct import", "globalThis.__dynamic_code_ran = true; void import('node:fs');"],
            ["dynamic import", "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; void import(specifier);"],
            ["direct module loader", "globalThis.__dynamic_code_ran = true; globalThis.require('node:fs');"],
            ["dynamic module loader", "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; globalThis.require(specifier);"],
            ["computed global module loader", "globalThis.__dynamic_code_ran = true; globalThis['requ' + 'ire']('node:fs');"],
            ["aliased computed module loader", "const loader = globalThis['requ' + 'ire']; globalThis.__dynamic_code_ran = true; loader('node:fs');"],
            ["dynamic computed module loader", "const key = 'requ' + 'ire'; globalThis.__dynamic_code_ran = true; globalThis[key]('node:fs');"],
          ];
          const constructors = [
            ["eval", (source) => eval(source)],
            ["globalThis.eval", (source) => globalThis.eval(source)],
            ["Function call", (source) => Function(source)()],
            ["Function construct", (source) => {
              const Constructor = Function;
              return new Constructor(source)();
            }],
            ["Function.prototype.constructor call", (source) => Function.prototype.constructor(source)()],
            ["Function.prototype.constructor construct", (source) => {
              const Constructor = Function.prototype.constructor;
              return new Constructor(source)();
            }],
            ["AsyncFunction constructor call", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return Constructor(source)();
            }],
            ["AsyncFunction constructor construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return new Constructor(source)();
            }],
            ["GeneratorFunction constructor call", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return Constructor(source)().next();
            }],
            ["GeneratorFunction constructor construct", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return new Constructor(source)().next();
            }],
            ["AsyncGeneratorFunction constructor call", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return Constructor(source)().next();
            }],
            ["AsyncGeneratorFunction constructor construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return new Constructor(source)().next();
            }],
          ];

          for (const [sourceLabel, source] of sources) {
            for (const [constructorLabel, attempt] of constructors) {
              globalThis.__dynamic_code_ran = false;
              let rejected = false;
              try {
                await attempt(source);
              } catch {
                rejected = true;
              }
              if (!rejected) {
                throw new Error(constructorLabel + " accepted " + sourceLabel);
              }
              if (globalThis.__dynamic_code_ran) {
                throw new Error(constructorLabel + " executed " + sourceLabel + " before rejecting");
              }
            }
          }
          const nbspSource =
            "globalThis.__dynamic_code_ran = true; return import\u00A0('node:fs');";
          const nbspConstructors = [
            ["Function call", (source) => Function(source)()],
            ["Function construct", (source) => new Function(source)()],
            ["AsyncFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return Constructor(source)();
            }],
            ["AsyncFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return new Constructor(source)();
            }],
          ];
          for (const [label, attempt] of nbspConstructors) {
            globalThis.__dynamic_code_ran = false;
            let rejected = false;
            try {
              await attempt(nbspSource);
            } catch {
              rejected = true;
            }
            if (!rejected || globalThis.__dynamic_code_ran) {
              throw new Error(label + " accepted or executed NBSP native import");
            }
          }
          const parameterizedSources = [
            ["parameterized import", "globalThis.__dynamic_code_ran = true; return import('node:fs');"],
            ["parameterized dynamic loader", "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; return require(specifier);"],
          ];
          const parameterizedConstructors = [
            ["Function call", (source) => Function("value", source)(0)],
            ["Function construct", (source) => new Function("value", source)(0)],
            ["AsyncFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return Constructor("value", source)(0);
            }],
            ["AsyncFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return new Constructor("value", source)(0);
            }],
            ["GeneratorFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return Constructor("value", source)(0).next();
            }],
            ["GeneratorFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return new Constructor("value", source)(0).next();
            }],
            ["AsyncGeneratorFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return Constructor("value", source)(0).next();
            }],
            ["AsyncGeneratorFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return new Constructor("value", source)(0).next();
            }],
          ];
          const expectedDynamicCodeRejection =
            "Dynamic code is blocked in extension context: module loading";
          for (const [sourceLabel, source] of parameterizedSources) {
            for (const [label, attempt] of parameterizedConstructors) {
              globalThis.__dynamic_code_ran = false;
              let failure;
              try {
                await attempt(source);
              } catch (error) {
                failure = error;
              }
              if (
                !(failure instanceof Error) ||
                failure.message !== expectedDynamicCodeRejection
              ) {
                throw new Error(label + " failed outside the dynamic-code guard for " + sourceLabel);
              }
              if (globalThis.__dynamic_code_ran) {
                throw new Error(label + " accepted or executed " + sourceLabel);
              }
            }
          }

          const parameterizedBenignConstructors = [
            ["Function call", () => Function("left", "right", "return left + right;")(20, 22)],
            ["Function construct", () => new Function("left", "right", "return left + right;")(20, 22)],
            ["AsyncFunction call", () => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return Constructor("left", "right", "return left + right;")(20, 22);
            }],
            ["AsyncFunction construct", () => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return new Constructor("left", "right", "return left + right;")(20, 22);
            }],
            ["GeneratorFunction call", () => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return Constructor("left", "right", "yield left + right;")(20, 22).next().value;
            }],
            ["GeneratorFunction construct", () => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return new Constructor("left", "right", "yield left + right;")(20, 22).next().value;
            }],
            ["AsyncGeneratorFunction call", async () => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return (await Constructor("left", "right", "yield left + right;")(20, 22).next()).value;
            }],
            ["AsyncGeneratorFunction construct", async () => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return (await new Constructor("left", "right", "yield left + right;")(20, 22).next()).value;
            }],
          ];
          for (const [label, attempt] of parameterizedBenignConstructors) {
            let value;
            try {
              value = await attempt();
            } catch (error) {
              throw new Error(
                label +
                  " rejected benign multi-argument source: " +
                  (error instanceof Error ? error.message : "non-error"),
              );
            }
            if (value !== 42) {
              throw new Error(label + " returned the wrong value for benign multi-argument source");
            }
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
  test("fails closed when hostile code patches scanner primitives and probes native constructors", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { createRequire } from "node:module";
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const NativeFunction = Function;
          const NativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const NativeGeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
          const NativeAsyncGeneratorFunction =
            Object.getPrototypeOf(async function* () {}).constructor;
          const nativeConstructors = [
            NativeFunction,
            NativeAsyncFunction,
            NativeGeneratorFunction,
            NativeAsyncGeneratorFunction,
          ];
          Object.defineProperty(globalThis, "require", {
            value: createRequire(import.meta.url),
            writable: true,
            configurable: true,
          });
          initializeSandbox({ allowDynamicCode: true });

          const guardedConstructors = [
            globalThis.Function,
            Object.getPrototypeOf(async function () {}).constructor,
            Object.getPrototypeOf(function* () {}).constructor,
            Object.getPrototypeOf(async function* () {}).constructor,
          ];
          for (const constructor of guardedConstructors) {
            if (nativeConstructors.includes(constructor)) {
              throw new Error("sandbox leaked a native dynamic constructor");
            }
            if (constructor.prototype?.constructor !== constructor) {
              throw new Error("constructor prototype leaked an unguarded constructor");
            }
          }

          const nativeReflectApply = Reflect.apply;
          const nativeReflectConstruct = Reflect.construct;
          const nativeString = globalThis.String;
          const nativeRegExp = globalThis.RegExp;
          const nativeJoin = Array.prototype.join;
          const nativeMap = Array.prototype.map;
          const nativeSetAdd = Set.prototype.add;
          const nativeSetHas = Set.prototype.has;
          const nativeTrim = String.prototype.trim;
          const nativeReplace = String.prototype.replace;
          const nativeSlice = String.prototype.slice;
          const nativeIndexOf = String.prototype.indexOf;
          const nativeMatch = String.prototype.match;
          const nativeMatchAll = String.prototype.matchAll;
          const nativeStartsWith = String.prototype.startsWith;
          let nativeLeak = false;
          let patchedPrimitiveCalls = 0;

          Reflect.apply = function (target, thisArg, args) {
            patchedPrimitiveCalls += 1;
            if (nativeConstructors.includes(target)) nativeLeak = true;
            return nativeReflectApply(target, thisArg, args);
          };
          Reflect.construct = function (target, args, newTarget) {
            patchedPrimitiveCalls += 1;
            if (nativeConstructors.includes(target)) nativeLeak = true;
            return newTarget === undefined
              ? nativeReflectConstruct(target, args)
              : nativeReflectConstruct(target, args, newTarget);
          };
          globalThis.String = function () {
            patchedPrimitiveCalls += 1;
            return "return 1";
          };
          globalThis.RegExp = function () {
            patchedPrimitiveCalls += 1;
            return nativeRegExp("(?!)");
          };
          Array.prototype.join = function () {
            patchedPrimitiveCalls += 1;
            return "return 1";
          };
          Array.prototype.map = function () {
            patchedPrimitiveCalls += 1;
            return [];
          };
          Set.prototype.add = function () {
            patchedPrimitiveCalls += 1;
            return this;
          };
          Set.prototype.has = function () {
            patchedPrimitiveCalls += 1;
            return false;
          };
          String.prototype.startsWith = function () {
            patchedPrimitiveCalls += 1;
            return false;
          };
          String.prototype.trim = function () {
            patchedPrimitiveCalls += 1;
            return "";
          };
          String.prototype.replace = function () {
            patchedPrimitiveCalls += 1;
            return "";
          };
          String.prototype.slice = function () {
            patchedPrimitiveCalls += 1;
            return "";
          };
          String.prototype.indexOf = function () {
            patchedPrimitiveCalls += 1;
            return -1;
          };
          String.prototype.match = function () {
            patchedPrimitiveCalls += 1;
            return null;
          };
          String.prototype.matchAll = function () {
            patchedPrimitiveCalls += 1;
            return [][Symbol.iterator]();
          };
          let requireError = false;
          let requireValue;
          try {
            requireValue = globalThis["requ" + "ire"]("node:fs");
          } catch {
            requireError = true;
          }
          if (!requireError || requireValue !== undefined) {
            throw new Error("computed globalThis require loaded a blocked module");
          }

          const hostileSources = [
            ["direct import", "globalThis.__dynamic_code_ran = true; void import('node:fs');"],
            ["dynamic import", "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; void import(specifier);"],
            ["NBSP import", "globalThis.__dynamic_code_ran = true; void import\u00A0('node:fs');"],
            ["NBSP module loader", "globalThis.__dynamic_code_ran = true; globalThis.require\u00A0('node:fs');"],
            ["computed module loader", "globalThis.__dynamic_code_ran = true; globalThis['requ' + 'ire']('node:fs');"],
            ["aliased computed module loader", "const loader = globalThis['requ' + 'ire']; globalThis.__dynamic_code_ran = true; loader('node:fs');"],
            ["dynamic computed module loader", "const key = 'requ' + 'ire'; globalThis.__dynamic_code_ran = true; globalThis[key]('node:fs');"],
            ["bare module loader", "globalThis.__dynamic_code_ran = true; require('node:fs');"],
            ["bare dynamic module loader", "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; require(specifier);"],
            ["bare aliased module loader", "const loader = require; globalThis.__dynamic_code_ran = true; loader('node:fs');"],
            ["bare NBSP module loader", "globalThis.__dynamic_code_ran = true; require\u00A0('node:fs');"],
          ];
          const functionConstructorAttempts = [
            ["Function call", (source) => globalThis.Function(source)()],
            ["Function construct", (source) => {
              const Constructor = globalThis.Function;
              return new Constructor(source)();
            }],
            ["Function.call", (source) => globalThis.Function.call(null, source)()],
            ["Function.apply", (source) => globalThis.Function.apply(null, [source])()],
            ["Function.bind", (source) => globalThis.Function.bind(null, source)()],
            ["Reflect.apply", (source) => Reflect.apply(globalThis.Function, null, [source])()],
            ["Reflect.construct", (source) => (Reflect.construct(globalThis.Function, [source]))()],
          ];
          const attempts = [
            ["eval", (source) => eval(source)],
            ["globalThis.eval", (source) => globalThis.eval(source)],
            ...functionConstructorAttempts,
            ["AsyncFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return Constructor(source)();
            }],
            ["AsyncFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function () {}).constructor;
              return new Constructor(source)();
            }],
            ["GeneratorFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return Constructor(source)().next();
            }],
            ["GeneratorFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(function* () {}).constructor;
              return new Constructor(source)().next();
            }],
            ["AsyncGeneratorFunction call", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return Constructor(source)().next();
            }],
            ["AsyncGeneratorFunction construct", (source) => {
              const Constructor = Object.getPrototypeOf(async function* () {}).constructor;
              return new Constructor(source)().next();
            }],
          ];

          const variableSpecifierImportSource =
            "const specifier = 'node:fs'; globalThis.__dynamic_code_ran = true; return import(specifier);";
          for (const [label, attempt] of functionConstructorAttempts) {
            globalThis.__dynamic_code_ran = false;
            let failure;
            try {
              await attempt(variableSpecifierImportSource);
            } catch (error) {
              failure = error;
            }
            if (
              !(failure instanceof Error) ||
              failure.message !== "Dynamic code is blocked in extension context: module loading"
            ) {
              throw new Error(label + " failed outside the dynamic-code guard for variable-specifier import");
            }
            if (globalThis.__dynamic_code_ran) {
              throw new Error(label + " executed variable-specifier import before rejection");
            }
          }

          const errors = [];
          const expectedDynamicCodeRejection =
            "Dynamic code is blocked in extension context: module loading";
          for (const [sourceLabel, hostileSource] of hostileSources) {
            for (const [label, attempt] of attempts) {
              globalThis.__dynamic_code_ran = false;
              let rejected = false;
              try {
                await attempt(hostileSource);
              } catch (error) {
                rejected = true;
                errors.push([sourceLabel + " " + label, error instanceof Error ? error.message : "non-error"]);
              }
              if (!rejected) throw new Error(label + " accepted " + sourceLabel);
              if (globalThis.__dynamic_code_ran) {
                throw new Error(label + " executed " + sourceLabel + " before rejection");
              }
            }
          }

          Array.prototype.join = nativeJoin;
          Array.prototype.map = nativeMap;
          Set.prototype.add = nativeSetAdd;
          Set.prototype.has = nativeSetHas;
          String.prototype.trim = nativeTrim;
          String.prototype.replace = nativeReplace;
          String.prototype.slice = nativeSlice;
          String.prototype.indexOf = nativeIndexOf;
          String.prototype.match = nativeMatch;
          String.prototype.matchAll = nativeMatchAll;
          String.prototype.startsWith = nativeStartsWith;
          globalThis.String = nativeString;
          globalThis.RegExp = nativeRegExp;
          Reflect.apply = nativeReflectApply;
          Reflect.construct = nativeReflectConstruct;

          if (nativeLeak) throw new Error("guard invoked a captured native constructor");
          if (patchedPrimitiveCalls === 0) {
            throw new Error("hostile primitive patch was not exercised");
          }
          for (const [label, message] of errors) {
            if (message !== expectedDynamicCodeRejection) {
              throw new Error(label + " failed outside the dynamic-code guard");
            }
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
  test("rejects hostile source with each primitive tampered independently", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const NativeFunction = Function;
          const nativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const nativeGeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
          const nativeAsyncGeneratorFunction =
            Object.getPrototypeOf(async function* () {}).constructor;
          initializeSandbox({ allowDynamicCode: true });
          const hostileSource =
            "globalThis.__dynamic_code_ran = true; void import('node:fs');";
          const nativeConstructors = [
            NativeFunction,
            nativeAsyncFunction,
            nativeGeneratorFunction,
            nativeAsyncGeneratorFunction,
          ];
          const nativeReflectApply = Reflect.apply;
          const nativeReflectConstruct = Reflect.construct;
          const nativeString = globalThis.String;
          const nativeRegExp = globalThis.RegExp;
          const nativeJoin = Array.prototype.join;
          const nativeMap = Array.prototype.map;
          const nativeSetAdd = Set.prototype.add;
          const nativeSetHas = Set.prototype.has;
          const nativeTrim = String.prototype.trim;
          const nativeReplace = String.prototype.replace;
          const nativeSlice = String.prototype.slice;
          const nativeIndexOf = String.prototype.indexOf;
          const nativeMatch = String.prototype.match;
          const nativeMatchAll = String.prototype.matchAll;
          const nativeStartsWith = String.prototype.startsWith;

          const primitiveCases = [
            [
              "Reflect.apply",
              () => {
                Reflect.apply = function (target, thisArg, args) {
                  if (nativeConstructors.includes(target)) globalThis.__native_leak = true;
                  return nativeReflectApply(target, thisArg, args);
                };
              },
              () => {
                Reflect.apply = nativeReflectApply;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "Reflect.construct",
              () => {
                Reflect.construct = function (target, args, newTarget) {
                  if (nativeConstructors.includes(target)) globalThis.__native_leak = true;
                  return newTarget === undefined
                    ? nativeReflectConstruct(target, args)
                    : nativeReflectConstruct(target, args, newTarget);
                };
              },
              () => {
                Reflect.construct = nativeReflectConstruct;
              },
              () => new globalThis.Function(hostileSource)(),
            ],
            [
              "String",
              () => {
                globalThis.String = () => "return 1";
              },
              () => {
                globalThis.String = nativeString;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "RegExp",
              () => {
                globalThis.RegExp = () => nativeRegExp("(?!)");
              },
              () => {
                globalThis.RegExp = nativeRegExp;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "Array.prototype.join",
              () => {
                Array.prototype.join = () => "return 1";
              },
              () => {
                Array.prototype.join = nativeJoin;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "Array.prototype.map",
              () => {
                Array.prototype.map = () => [];
              },
              () => {
                Array.prototype.map = nativeMap;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "Set.prototype.add",
              () => {
                Set.prototype.add = function () {
                  return this;
                };
              },
              () => {
                Set.prototype.add = nativeSetAdd;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "Set.prototype.has",
              () => {
                Set.prototype.has = () => false;
              },
              () => {
                Set.prototype.has = nativeSetHas;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.trim",
              () => {
                String.prototype.trim = () => "";
              },
              () => {
                String.prototype.trim = nativeTrim;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.replace",
              () => {
                String.prototype.replace = () => "";
              },
              () => {
                String.prototype.replace = nativeReplace;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.slice",
              () => {
                String.prototype.slice = () => "";
              },
              () => {
                String.prototype.slice = nativeSlice;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.indexOf",
              () => {
                String.prototype.indexOf = () => -1;
              },
              () => {
                String.prototype.indexOf = nativeIndexOf;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.match",
              () => {
                String.prototype.match = () => null;
              },
              () => {
                String.prototype.match = nativeMatch;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.matchAll",
              () => {
                String.prototype.matchAll = () => [][Symbol.iterator]();
              },
              () => {
                String.prototype.matchAll = nativeMatchAll;
              },
              () => globalThis.Function(hostileSource)(),
            ],
            [
              "String.prototype.startsWith",
              () => {
                String.prototype.startsWith = () => false;
              },
              () => {
                String.prototype.startsWith = nativeStartsWith;
              },
              () => globalThis.Function(hostileSource)(),
            ],
          ];

          for (const [label, install, restore, attempt] of primitiveCases) {
            globalThis.__dynamic_code_ran = false;
            globalThis.__native_leak = false;
            let rejected = false;
            let errorMessage = "";
            install();
            try {
              await attempt();
            } catch (error) {
              rejected = true;
              errorMessage = error instanceof Error ? error.message : "non-error";
            } finally {
              restore();
            }
            if (!rejected || globalThis.__dynamic_code_ran) {
              throw new Error(label + " allowed or executed hostile source");
            }
            if (globalThis.__native_leak) {
              throw new Error(label + " exposed a native dynamic constructor");
            }
            if (!errorMessage.startsWith("Dynamic code")) {
              throw new Error(label + " failed outside the dynamic-code guard");
            }
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects every global loader surface for every specifier", () => {
    for (const allowDynamicCode of [false, true]) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            import { createRequire } from "node:module";
            import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

            let forwardedCalls = 0;
            const originalRequire = createRequire(import.meta.url);
            const forwardingImport = async (specifier) => {
              forwardedCalls += 1;
              return import(specifier);
            };
            const forwardingRequire = (specifier) => {
              forwardedCalls += 1;
              return originalRequire(specifier);
            };
            globalThis.__loader_side_effect = false;
            globalThis.__loader_surface_touched = false;
            for (const loader of [forwardingImport, forwardingRequire]) {
              for (const property of ["resolve", "extensions", "cache", "main"]) {
                Object.defineProperty(loader, property, {
                  configurable: true,
                  get() {
                    globalThis.__loader_surface_touched = true;
                    return undefined;
                  },
                });
              }
            }
            Object.defineProperty(globalThis, "import", {
              value: forwardingImport,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(globalThis, "require", {
              value: forwardingRequire,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(globalThis, "module", {
              value: { require: forwardingRequire },
              writable: true,
              configurable: true,
            });

            initializeSandbox({ allowDynamicCode: ${allowDynamicCode} });
            const moduleRequireDescriptor = Object.getOwnPropertyDescriptor(globalThis.module, "require");
            if (
              !moduleRequireDescriptor ||
              moduleRequireDescriptor.writable !== false ||
              moduleRequireDescriptor.configurable !== false
            ) {
              throw new Error("module.require guard descriptor is missing or mutable");
            }
            const installedModuleRequire = globalThis.module.require;
            try {
              globalThis.module.require = forwardingRequire;
            } catch {}
            if (globalThis.module.require !== installedModuleRequire) {
              throw new Error("module.require guard was replaceable");
            }
            const expectedError = "Module loading is disabled in extension context";
            const loaders = [
              ["globalThis.import", [
                (specifier) => globalThis.import(specifier),
                (specifier) => globalThis["import"](specifier),
                (() => {
                  const captured = globalThis.import;
                  return (specifier) => captured(specifier);
                })(),
              ]],
              ["globalThis.require", [
                (specifier) => globalThis.require(specifier),
                (specifier) => globalThis["require"](specifier),
                (() => {
                  const captured = globalThis.require;
                  return (specifier) => captured(specifier);
                })(),
              ]],
              ["globalThis.module.require", [
                (specifier) => globalThis.module.require(specifier),
                (specifier) => globalThis.module["require"](specifier),
                (() => {
                  const captured = globalThis.module.require;
                  return (specifier) => captured(specifier);
                })(),
              ]],
            ];
            const specifiers = [
              ["relative", "./src/spindle/worker-runtime-sandbox.ts"],
              ["relative parent", "../lumiverse-spindle-loom-block-editor/src/spindle/worker-runtime-sandbox.ts"],
              ["absolute", "/tmp/sandbox-loader-escape.js"],
              ["file URL", "file:///tmp/sandbox-loader-escape.js"],
              ["data URL", "data:text/javascript,globalThis.__loader_side_effect=true;export default 1"],
              ["http URL", "http://example.test/sandbox-loader.js"],
              ["https URL", "https://example.test/sandbox-loader.js"],
              ["blocked fs builtin", "node:fs"],
              ["blocked ffi builtin", "bun:ffi"],
              ["ordinary package", "hono"],
              ["ordinary package types", "lumiverse-spindle-types"],
              ["safe core path", "node:path"],
              ["undefined", undefined],
              ["null", null],
              ["boolean", false],
              ["number", 42],
              ["bigint", 42n],
              ["symbol", Symbol("hostile-symbol")],
            ];

            async function assertBlocked(label, attempt) {
              let errorMessage = "";
              try {
                await attempt();
              } catch (error) {
                errorMessage = error instanceof Error ? error.message : "non-error";
              }
              if (errorMessage !== expectedError) {
                throw new Error(label + " did not fail closed: " + errorMessage);
              }
            }
            for (const [loaderLabel, calls] of loaders) {
              for (let index = 0; index < calls.length; index += 1) {
                await assertBlocked(
                  loaderLabel + " missing argument " + index,
                  () => calls[index](),
                );
              }
            }

            for (const [loaderLabel, calls] of loaders) {
              for (const [specifierLabel, specifier] of specifiers) {
                for (let index = 0; index < calls.length; index += 1) {
                  await assertBlocked(
                    loaderLabel + " call " + index + " " + specifierLabel,
                    () => calls[index](specifier),
                  );
                }
              }
            }

            let coercions = 0;
            const hostileSpecifier = {
              [Symbol.toPrimitive]() {
                coercions += 1;
                throw new Error("hostile specifier was coerced");
              },
              toString() {
                coercions += 1;
                throw new Error("hostile specifier was stringified");
              },
              valueOf() {
                coercions += 1;
                throw new Error("hostile specifier valueOf was called");
              },
            };
            for (const [loaderLabel, calls] of loaders) {
              for (let index = 0; index < calls.length; index += 1) {
                await assertBlocked(
                  loaderLabel + " hostile call " + index,
                  () => calls[index](hostileSpecifier),
                );
              }
            }
            if (globalThis.__loader_side_effect) {
              throw new Error("blocked global loaders dispatched a data URL");
            }
            if (globalThis.__loader_surface_touched) {
              throw new Error("blocked global loaders exposed a source loader property");
            }
            if (coercions !== 0) {
              throw new Error("blocked global loaders coerced a hostile specifier");
            }
            if (forwardedCalls !== 0) {
              throw new Error("blocked global loaders forwarded a call");
            }

            for (const [label, loader] of [
              ["import", globalThis.import],
              ["require", globalThis.require],
              ["module.require", globalThis.module.require],
            ]) {
              if (typeof loader !== "function") {
                throw new Error(label + " loader missing");
              }
              for (const property of ["resolve", "extensions", "cache", "main"]) {
                if (loader[property] !== undefined || property in loader) {
                  throw new Error(label + " exposed loader property " + property);
                }
              }
            }
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
    }
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

          const runtimeSensitiveSeed = crypto.randomUUID();
          process.env.SECRET_FOR_SANDBOX = runtimeSensitiveSeed + "A";
          process.env.AUTH_TOKEN_FOR_SANDBOX = runtimeSensitiveSeed + "B";
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
              error.message === "Module loading is disabled in extension context";
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
  test("seals Module constructor loaders across hostile descriptors and fails closed when impossible", () => {
    for (const mode of ["configurable", "nonconfigurable-writable", "nonconfigurable-frozen", "impossible"] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";
            const mode = ${JSON.stringify(mode)};
            const impossible = mode === "impossible" || mode === "nonconfigurable-frozen";
            const sandboxUrl = new URL("./src/spindle/worker-runtime-sandbox.ts", import.meta.url).href;
            const expectedError = "Module loading is disabled in extension context";
            const startupError = "Module loader surface could not be sealed in extension context";

            async function workerMessage(source) {
              const { promise, resolve, reject } = Promise.withResolvers();
              const worker = new Worker(
                "data:text/javascript," + encodeURIComponent(source),
                { type: "module" },
              );
              worker.onmessage = (event) => {
                worker.terminate();
                resolve(event.data);
              };
              worker.onerror = (event) => {
                worker.terminate();
                reject(new Error(String(event.message ?? event)));
              };
              return await promise;
            }

            const defaultWorker = await workerMessage(
              "postMessage({ module: typeof globalThis.module, require: typeof globalThis.require, worker: typeof Worker });",
            );
            if (
              defaultWorker.module !== "undefined" ||
              defaultWorker.require !== "undefined" ||
              defaultWorker.worker !== "function"
            ) {
              throw new Error("Bun ESM Worker did not expose the observed default module surface");
            }
            const initializedWorker = await workerMessage(
              "import { initializeSandbox } from " + JSON.stringify(sandboxUrl) + "; initializeSandbox(); postMessage('initialized');",
            );
            if (initializedWorker !== "initialized") {
              throw new Error("ordinary ESM Worker initialization did not complete");
            }

            let escaped = false;
            const hostileLoader = () => {
              escaped = true;
              return "escaped";
            };
            const hostileConstructor = Object.create(null);
            for (const key of ["_load", "createRequire", "require"]) {
              Object.defineProperty(hostileConstructor, key, {
                value: hostileLoader,
                writable: false,
                configurable: false,
                enumerable: true,
              });
            }
            const hostilePrototype = Object.create(null);
            Object.defineProperty(hostilePrototype, "constructor", {
              value: hostileConstructor,
              writable: false,
              configurable: false,
              enumerable: false,
            });
            const hostileModule = Object.create(hostilePrototype);
            Object.defineProperty(hostileModule, "__proto__", {
              value: hostilePrototype,
              writable: false,
              configurable: false,
              enumerable: false,
            });
            Object.defineProperty(hostileModule, "constructor", {
              value: hostileConstructor,
              writable: true,
              configurable: true,
              enumerable: false,
            });
            Object.defineProperty(hostileModule, "require", {
              value: hostileLoader,
              writable: true,
              configurable: true,
              enumerable: true,
            });

            if (impossible) {
              Object.defineProperty(hostileModule, "constructor", {
                value: hostileConstructor,
                writable: false,
                configurable: false,
              });
              Object.defineProperty(hostileModule, "require", {
                value: hostileLoader,
                writable: false,
                configurable: false,
              });
              Object.preventExtensions(hostileModule);
            }
            Object.defineProperty(globalThis, "module", {
              value: hostileModule,
              writable: mode === "configurable" || mode === "nonconfigurable-writable",
              configurable: mode === "configurable",
              enumerable: true,
            });

            if (impossible) {
              let continued = false;
              try {
                initializeSandbox();
                continued = true;
              } catch (error) {
                if (!(error instanceof Error) || error.message !== startupError) throw error;
              }
              if (continued) throw new Error("sandbox continued after impossible Module hardening");
              if (escaped) throw new Error("impossible Module hardening reached a hostile loader");
            } else {
              initializeSandbox();
              const guardedModule = globalThis.module;
              const moduleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "module");
              if (
                !moduleDescriptor ||
                moduleDescriptor.value !== guardedModule ||
                moduleDescriptor.writable !== false ||
                moduleDescriptor.configurable !== false
              ) {
                throw new Error("global module descriptor remained repopulatable");
              }
              const guardedPrototype = Object.getPrototypeOf(guardedModule);
              if (guardedPrototype !== null) {
                throw new Error("guarded module retained a hostile prototype");
              }
              const constructorDescriptor = Object.getOwnPropertyDescriptor(guardedModule, "constructor");
              const requireDescriptor = Object.getOwnPropertyDescriptor(guardedModule, "require");
              if (
                !constructorDescriptor ||
                constructorDescriptor.writable !== false ||
                constructorDescriptor.configurable !== false ||
                !requireDescriptor ||
                requireDescriptor.writable !== false ||
                requireDescriptor.configurable !== false
              ) {
                throw new Error("guarded Module surfaces remained mutable");
              }

              const attempts = [
                ["direct _load", () => guardedModule.constructor._load("node:fs")],
                ["direct createRequire", () => guardedModule.constructor.createRequire("/tmp/extension.js")],
                ["static computed", () => guardedModule["constructor"]["_load"]("node:fs")],
                ["Object.getOwnPropertyDescriptor", () => Object.getOwnPropertyDescriptor(guardedModule, "constructor")?.value?._load("node:fs")],
                ["Reflect.getOwnPropertyDescriptor", () => Reflect.getOwnPropertyDescriptor(guardedModule, "constructor")?.value?._load("node:fs")],
                ["Reflect.get", () => Reflect.get(guardedModule, "constructor")?._load("node:fs")],
                ["Object.getPrototypeOf", () => Object.getPrototypeOf(guardedModule)?.constructor?._load("node:fs")],
                ["Reflect.getPrototypeOf", () => Reflect.getPrototypeOf(guardedModule)?.constructor?._load("node:fs")],
                ["call", () => guardedModule.constructor._load.call(null, "node:fs")],
                ["apply", () => guardedModule.constructor._load.apply(null, ["node:fs"])],
                ["bind", () => guardedModule.constructor._load.bind(null, "node:fs")()],
                ["Reflect.apply", () => Reflect.apply(guardedModule.constructor._load, null, ["node:fs"])],
                ["prototype __proto__", () => guardedModule.__proto__?.constructor?._load("node:fs")],
              ];
              for (const [label, attempt] of attempts) {
                escaped = false;
                let value;
                try {
                  value = attempt();
                } catch {}
                if (escaped || value === "escaped") {
                  throw new Error(label + " recovered a hostile Module loader");
                }
              }

              const guardedConstructor = guardedModule.constructor;
              try {
                globalThis.module = hostileModule;
              } catch {}
              try {
                guardedModule.constructor = hostileConstructor;
                guardedModule.require = hostileLoader;
              } catch {}
              for (const repopulate of [
                () => Object.defineProperty(guardedModule, "constructor", { value: hostileConstructor }),
                () => Reflect.defineProperty(guardedModule, "constructor", { value: hostileConstructor }),
                () => Object.setPrototypeOf(guardedModule, hostilePrototype),
                () => Reflect.setPrototypeOf(guardedModule, hostilePrototype),
              ]) {
                try {
                  repopulate();
                } catch {}
              }
              if (
                globalThis.module !== guardedModule ||
                guardedModule.constructor === hostileConstructor ||
                guardedModule.require === hostileLoader
              ) {
                throw new Error("guarded Module object was repopulatable");
              }
              if (guardedModule.constructor !== guardedConstructor) {
                throw new Error("guarded Module constructor changed after reassignment");
              }
            }
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      expect(result.exitCode, mode + ": " + result.stderr.toString()).toBe(0);
      expect(result.stderr.toString(), mode).toBe("");
    }
  });
  test("fails closed on a substituted immutable Bun callable without invoking it", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const originalDescriptor = Object.getOwnPropertyDescriptor(Bun, "file");
          if (!originalDescriptor || !("value" in originalDescriptor)) {
            throw new Error("Bun.file fixture descriptor was unavailable");
          }
          let invoked = false;
          const hostile = () => {
            invoked = true;
            return "escaped";
          };
          Object.defineProperty(Bun, "file", {
            ...originalDescriptor,
            value: hostile,
            writable: false,
            configurable: false,
          });

          let startupError;
          try {
            initializeSandbox();
          } catch (error) {
            startupError = error;
          }
          if (
            !(startupError instanceof Error) ||
            startupError.message !== "Sandbox guard installation failed (Bun.file)"
          ) {
            throw new Error("hostile immutable Bun callable did not fail closed");
          }
          if (invoked) throw new Error("hostile immutable Bun callable was invoked");
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
  test("replaces module graph values with a fresh blank blocked surface", () => {
    for (const mode of ["replaceable", "nonconfigurable-writable"] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

            const mode = ${JSON.stringify(mode)};
            let escaped = false;
            let getterCalls = 0;
            const hostileLoader = () => {
              escaped = true;
              return "escaped";
            };
            const moduleValue = Object.create(null);
            const parent = { require: hostileLoader };
            const child = { require: hostileLoader };
            const exportsValue = { require: hostileLoader };
            Object.defineProperties(moduleValue, {
              parent: {
                value: parent,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              children: {
                value: [child],
                writable: true,
                configurable: true,
                enumerable: true,
              },
              exports: {
                value: exportsValue,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              loader: {
                value: hostileLoader,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              lazyLoader: {
                get() {
                  getterCalls += 1;
                  return hostileLoader;
                },
                configurable: true,
                enumerable: true,
              },
              id: {
                value: "inert-module-id",
                writable: true,
                configurable: true,
                enumerable: true,
              },
              loaded: {
                value: false,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              retainedNaN: {
                value: NaN,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              retainedNegativeZero: {
                value: -0,
                writable: true,
                configurable: true,
                enumerable: true,
              },
              retainedPositiveZero: {
                value: 0,
                writable: true,
                configurable: true,
                enumerable: true,
              },
            });
            Object.defineProperty(globalThis, "module", {
              value: moduleValue,
              writable: true,
              configurable: mode === "replaceable",
              enumerable: true,
            });

            initializeSandbox();
            const guardedModule = globalThis.module;
            if (
              guardedModule === moduleValue ||
              Object.getPrototypeOf(guardedModule) !== null
            ) {
              throw new Error("module graph was hardened in place");
            }
            const moduleKeys = Object.getOwnPropertyNames(guardedModule);
            if (
              moduleKeys.length !== 2 ||
              !moduleKeys.includes("require") ||
              !moduleKeys.includes("constructor")
            ) {
              throw new Error("module graph metadata was retained in the fresh surface");
            }
            for (const key of [
              "parent",
              "children",
              "exports",
              "loader",
              "lazyLoader",
              "id",
              "loaded",
              "retainedNaN",
              "retainedNegativeZero",
              "retainedPositiveZero",
            ]) {
              if (Object.getOwnPropertyDescriptor(guardedModule, key) !== undefined) {
                throw new Error(key + " leaked into the blank module surface");
              }
            }
            const lazyDescriptor = Object.getOwnPropertyDescriptor(moduleValue, "lazyLoader");
            if (!lazyDescriptor || typeof lazyDescriptor.get !== "function") {
              throw new Error("original module accessor was changed");
            }
            if (
              moduleValue.parent !== parent ||
              moduleValue.children[0] !== child ||
              moduleValue.exports !== exportsValue ||
              moduleValue.loader !== hostileLoader ||
              moduleValue.id !== "inert-module-id" ||
              !Object.is(moduleValue.loaded, false) ||
              !Object.is(moduleValue.retainedNaN, NaN) ||
              !Object.is(moduleValue.retainedNegativeZero, -0) ||
              !Object.is(moduleValue.retainedPositiveZero, 0) ||
              getterCalls !== 0 ||
              escaped
            ) {
              throw new Error("original module graph was inspected or mutated");
            }

            const moduleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "module");
            if (
              !moduleDescriptor ||
              moduleDescriptor.value !== guardedModule ||
              moduleDescriptor.writable !== false ||
              moduleDescriptor.configurable !== false
            ) {
              throw new Error("fresh module descriptor remained mutable");
            }

            const moduleCalls = [
              () => guardedModule.require("node:fs"),
              () => guardedModule.constructor._load("node:fs"),
              () => guardedModule.constructor.createRequire("/tmp/extension.js"),
              () => guardedModule.constructor.require("node:fs"),
            ];
            for (const call of moduleCalls) {
              let blocked = false;
              try {
                call();
              } catch (error) {
                blocked =
                  error instanceof Error &&
                  error.message === "Module loading is disabled in extension context";
              }
              if (!blocked || escaped) throw new Error("guarded module loader escaped");
            }

            const constructorAttempts = [
              ["Object.constructor", () => Object.constructor("globalThis.__dynamic_code_ran = true;")],
              ["globalThis.constructor.constructor", () => globalThis.constructor.constructor("globalThis.__dynamic_code_ran = true;")],
              ["Object prototype constructor", () => Object.getPrototypeOf(globalThis).constructor.constructor("globalThis.__dynamic_code_ran = true;")],
              ["Reflect.get constructor", () => Reflect.get(Object, "constructor")("globalThis.__dynamic_code_ran = true;")],
            ];
            for (const [label, attempt] of constructorAttempts) {
              globalThis.__dynamic_code_ran = false;
              let blocked = false;
              try {
                attempt();
              } catch (error) {
                blocked =
                  error instanceof Error &&
                  error.message === "Function constructor is disabled in extension context";
              }
              if (!blocked || globalThis.__dynamic_code_ran) {
                throw new Error(label + " bypassed the dynamic-code guard");
              }
            }
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(result.exitCode, mode + ": " + result.stderr.toString()).toBe(0);
      expect(result.stderr.toString(), mode).toBe("");
    }
  });
  test("fails closed for fixed module values and ignores proxy traps", () => {
    for (const mode of [
      "plain",
      "null-proto",
      "map",
      "set",
      "array",
      "map-iterator",
      "set-iterator",
      "array-iterator",
      "generator",
      "function",
      "accessor",
      "replaceable-accessor",
      "proxy",
      "replaceable-proxy",
    ] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

            const mode = ${JSON.stringify(mode)};
            let escaped = false;
            let trapCalls = 0;
            let accessorCalls = 0;
            let accessorValue;
            const hostileLoader = () => {
              escaped = true;
              return "escaped";
            };
            const record = Object.create(null);
            record.inert = "value";
            let moduleValue;
            if (mode === "plain") {
              moduleValue = { inert: "value" };
            } else if (mode === "null-proto") {
              moduleValue = record;
            } else if (mode === "map") {
              moduleValue = new Map([["parent", { require: hostileLoader }]]);
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "set") {
              moduleValue = new Set(["value"]);
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "array") {
              moduleValue = ["value"];
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "map-iterator") {
              moduleValue = new Map([["key", "value"]]).entries();
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "set-iterator") {
              moduleValue = new Set(["value"]).values();
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "array-iterator") {
              moduleValue = ["value"][Symbol.iterator]();
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "generator") {
              moduleValue = (function* () {
                yield "value";
              })();
              Object.setPrototypeOf(moduleValue, null);
            } else if (mode === "function") {
              moduleValue = function hostileModule() {
                escaped = true;
              };
            } else if (mode === "accessor" || mode === "replaceable-accessor") {
              accessorValue = Object.create(null);
              moduleValue = accessorValue;
            } else if (mode === "proxy" || mode === "replaceable-proxy") {
              const target = Object.create(null);
              moduleValue = new Proxy(target, {
                ownKeys() {
                  trapCalls += 1;
                  escaped = true;
                  return [];
                },
                getPrototypeOf() {
                  trapCalls += 1;
                  escaped = true;
                  return null;
                },
                getOwnPropertyDescriptor() {
                  trapCalls += 1;
                  escaped = true;
                  return undefined;
                },
                setPrototypeOf() {
                  trapCalls += 1;
                  escaped = true;
                  return false;
                },
                defineProperty() {
                  trapCalls += 1;
                  escaped = true;
                  return false;
                },
                preventExtensions() {
                  trapCalls += 1;
                  escaped = true;
                  return false;
                },
                isExtensible() {
                  trapCalls += 1;
                  escaped = true;
                  return true;
                },
                get() {
                  trapCalls += 1;
                  escaped = true;
                  return undefined;
                },
                set() {
                  trapCalls += 1;
                  escaped = true;
                  return false;
                },
              });
            }
            const replaceable =
              mode === "replaceable-proxy" || mode === "replaceable-accessor";
            if (mode === "accessor" || mode === "replaceable-accessor") {
              Object.defineProperty(globalThis, "module", {
                get() {
                  accessorCalls += 1;
                  escaped = true;
                  throw new Error("module getter executed");
                },
                configurable: mode === "replaceable-accessor",
                enumerable: true,
              });
            } else {
              Object.defineProperty(globalThis, "module", {
                value: moduleValue,
                writable: replaceable,
                configurable: replaceable,
                enumerable: true,
              });
            }

            let startupError;
            try {
              initializeSandbox();
            } catch (error) {
              startupError = error;
            }
            if (replaceable) {
              if (startupError || escaped || trapCalls !== 0 || accessorCalls !== 0) {
                throw new Error("replaceable module value was inspected or rejected");
              }
              const guardedModule = globalThis.module;
              if (guardedModule === moduleValue || Object.getPrototypeOf(guardedModule) !== null) {
                throw new Error("replaceable proxy was not replaced with a blank null-prototype surface");
              }
              const moduleKeys = Object.getOwnPropertyNames(guardedModule);
              if (
                moduleKeys.length !== 2 ||
                !moduleKeys.includes("require") ||
                !moduleKeys.includes("constructor")
              ) {
                throw new Error("replaceable proxy metadata leaked into the module surface");
              }
              const moduleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "module");
              if (
                !moduleDescriptor ||
                moduleDescriptor.value !== guardedModule ||
                moduleDescriptor.writable !== false ||
                moduleDescriptor.configurable !== false
              ) {
                throw new Error("blank replacement module descriptor remained mutable");
              }
              let blocked = false;
              try {
                guardedModule.require("node:fs");
              } catch (error) {
                blocked =
                  error instanceof Error &&
                  error.message === "Module loading is disabled in extension context";
              }
              if (!blocked) throw new Error("blank replacement module loader was not blocked");
            } else if (
              !(startupError instanceof Error) ||
              startupError.message !== "Module loader surface could not be sealed in extension context"
            ) {
              throw new Error(mode + " module value was not rejected");
            } else if (escaped || trapCalls !== 0 || accessorCalls !== 0) {
              throw new Error(mode + " module value executed before rejection");
            }
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(result.exitCode, mode + ": " + result.stderr.toString()).toBe(0);
      expect(result.stderr.toString(), mode).toBe("");
    }
  });
  test("rejects startup on hostile privileged descriptors before extension import", () => {
    const cases = [
      ["fetch", {}, "global", "Sandbox guard installation failed (global fetch)"],
      ["WebSocket", {}, "global", "Sandbox guard installation failed (global WebSocket)"],
      ["Worker", {}, "global", "Sandbox guard installation failed (global Worker)"],
      ["BroadcastChannel", {}, "global", "Sandbox guard installation failed (global BroadcastChannel)"],
      ["fetch", {}, "global-getter", "Sandbox guard installation failed (global fetch)"],
      ["Bun.file", {}, "bun", "Sandbox guard installation failed (Bun.file)"],
      ["Bun.write", {}, "bun", "Sandbox guard installation failed (Bun.write)"],
      ["Bun.spawn", {}, "bun", "Sandbox guard installation failed (Bun.spawn)"],
      ["Bun.serve", {}, "bun", "Sandbox guard installation failed (Bun.serve)"],
      ["Bun.connect", {}, "bun", "Sandbox guard installation failed (Bun.connect)"],
      ["Bun.__hostile_getter", {}, "bun-getter", "Sandbox guard installation failed (Bun.__hostile_getter)"],
      ["process.binding", {}, "process", "Sandbox guard installation failed (process.binding)"],
      ["process._linkedBinding", {}, "process", "Sandbox guard installation failed (process._linkedBinding)"],
      ["process.getBuiltinModule", {}, "process", "Sandbox guard installation failed (process.getBuiltinModule)"],
      ["process.exit", {}, "process", "Sandbox guard installation failed (process.exit)"],
      ["process.binding", {}, "process-getter", "Sandbox guard installation failed (process.binding)"],
      ["eval", { allowDynamicCode: false }, "global", "Sandbox guard installation failed (eval)"],
      ["eval", { allowDynamicCode: true }, "global", "Sandbox guard installation failed (eval)"],
      ["Function", { allowDynamicCode: false }, "global", "Sandbox guard installation failed (Function)"],
      ["Function", { allowDynamicCode: true }, "global", "Sandbox guard installation failed (Function)"],
      ["Function.prototype.constructor", { allowDynamicCode: false }, "function-prototype", "Sandbox guard installation failed (constructor prototype)"],
      ["AsyncFunction.prototype.constructor", { allowDynamicCode: true }, "async-function-prototype", "Sandbox guard installation failed (constructor prototype)"],
      ["GeneratorFunction.prototype.constructor", { allowDynamicCode: false }, "generator-function-prototype", "Sandbox guard installation failed (constructor prototype)"],
      ["AsyncGeneratorFunction.prototype.constructor", { allowDynamicCode: true }, "async-generator-function-prototype", "Sandbox guard installation failed (constructor prototype)"],
      ["globalThis.require", {}, "require", "Sandbox guard installation failed (global require)"],
      ["globalThis.import", {}, "import", "Sandbox guard installation failed (global import)"],
      ["module.require", {}, "module-require", "Module loader surface could not be sealed in extension context"],
      ["module.constructor", {}, "module-constructor", "Module loader surface could not be sealed in extension context"],
    ] as const;

    for (const [surface, options, fixture, expectedError] of cases) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            import { BLOCKED_BUN_API_NAMES } from "./src/spindle/dangerous-runtime-policy";
            import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

            const surface = ${JSON.stringify(surface)};
            const fixture = ${JSON.stringify(fixture)};
            const options = ${JSON.stringify(options)};
            const fixtures = [];
            let getterCount = 0;
            globalThis.__extension_import_attempted = false;
            globalThis.__extension_side_effect = false;

            function installHostile(owner, key, value) {
              Object.defineProperty(owner, key, {
                value,
                writable: false,
                configurable: false,
                enumerable: true,
              });
              const descriptor = Object.getOwnPropertyDescriptor(owner, key);
              if (!descriptor) throw new Error(surface + " fixture descriptor was not installed");
              fixtures.push({ owner, key, descriptor });
            }
            function installHostileGetter(owner, key, value) {
              const getter = () => {
                getterCount += 1;
                globalThis.__extension_side_effect = true;
                return value;
              };
              Object.defineProperty(owner, key, {
                get: getter,
                set: undefined,
                configurable: false,
                enumerable: true,
              });
              const descriptor = Object.getOwnPropertyDescriptor(owner, key);
              if (!descriptor) throw new Error(surface + " getter fixture descriptor was not installed");
              fixtures.push({ owner, key, descriptor });
            }

            const hostile = () => {
              globalThis.__extension_side_effect = true;
              return "forged";
            };
            if (fixture === "global") {
              installHostile(globalThis, surface, hostile);
            } else if (fixture === "global-getter") {
              installHostileGetter(globalThis, surface, hostile);
            } else if (fixture === "bun") {
              installHostile(Bun, surface.replace("Bun.", ""), hostile);
            } else if (fixture === "bun-getter") {
              BLOCKED_BUN_API_NAMES.push("__hostile_getter");
              installHostileGetter(Bun, "__hostile_getter", hostile);
            } else if (fixture === "process") {
              installHostile(process, surface.replace("process.", ""), hostile);
            } else if (fixture === "process-getter") {
              installHostileGetter(process, surface.replace("process.", ""), hostile);
            } else if (fixture === "function-prototype") {
              installHostile(Object.getPrototypeOf(function () {}), "constructor", hostile);
            } else if (fixture === "async-function-prototype") {
              installHostile(Object.getPrototypeOf(async function () {}), "constructor", hostile);
            } else if (fixture === "generator-function-prototype") {
              installHostile(Object.getPrototypeOf(function* () {}), "constructor", hostile);
            } else if (fixture === "async-generator-function-prototype") {
              installHostile(Object.getPrototypeOf(async function* () {}), "constructor", hostile);
            } else if (fixture === "require") {
              installHostile(globalThis, "require", hostile);
            } else if (fixture === "import") {
              installHostile(globalThis, "import", hostile);
            } else if (fixture === "module-require") {
              const moduleValue = Object.create(null);
              installHostile(moduleValue, "require", hostile);
              Object.defineProperty(globalThis, "module", {
                value: moduleValue,
                writable: false,
                configurable: false,
                enumerable: true,
              });
              const descriptor = Object.getOwnPropertyDescriptor(globalThis, "module");
              if (!descriptor) throw new Error("module fixture descriptor was not installed");
              fixtures.push({ owner: globalThis, key: "module", descriptor });
            } else if (fixture === "module-constructor") {
              const constructorValue = Object.create(null);
              installHostile(constructorValue, "_load", hostile);
              installHostile(constructorValue, "createRequire", hostile);
              const moduleValue = Object.create(null);
              installHostile(moduleValue, "constructor", constructorValue);
              Object.defineProperty(globalThis, "module", {
                value: moduleValue,
                writable: false,
                configurable: false,
                enumerable: true,
              });
              const descriptor = Object.getOwnPropertyDescriptor(globalThis, "module");
              if (!descriptor) throw new Error("module constructor fixture descriptor was not installed");
              fixtures.push({ owner: globalThis, key: "module", descriptor });
            } else {
              throw new Error("unknown hostile fixture " + fixture);
            }

            let startupError;
            try {
              initializeSandbox(options);
              globalThis.__extension_import_attempted = true;
            } catch (error) {
              startupError = error;
            }
            if (!(startupError instanceof Error) || startupError.message !== ${JSON.stringify(expectedError)}) {
              throw new Error(surface + " startup error did not match the exact guard contract: " + (startupError?.message ?? ""));
            }
            if (
              globalThis.__extension_import_attempted ||
              globalThis.__extension_side_effect ||
              getterCount !== 0
            ) {
              throw new Error(
                surface + " reached extension import/side effect or invoked hostile getter " + getterCount + " times",
              );
            }

            for (const { owner, key, descriptor: before } of fixtures) {
              const after = Object.getOwnPropertyDescriptor(owner, key);
              if (!after) throw new Error(surface + " descriptor disappeared");
              for (const property of ["value", "writable", "enumerable", "configurable", "get", "set"]) {
                if (after[property] !== before[property]) {
                  throw new Error(surface + " descriptor changed for " + key);
                }
              }
            }
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(result.exitCode, surface + " (" + fixture + "): " + result.stderr.toString()).toBe(0);
      expect(result.stderr.toString(), surface + " (" + fixture + ")").toBe("");
    }
  });

  test("rejects real Worker startup before extension entry side effects", async () => {
    const sandboxUrl = new URL("./worker-runtime-sandbox.ts", import.meta.url).href;
    const extensionUrl =
      "data:text/javascript," +
      encodeURIComponent(
        "globalThis.__extension_side_effect = true; postMessage({ kind: 'extension-side-effect' }); export default 1",
      );
    const workerSource = `
      import { initializeSandbox } from ${JSON.stringify(sandboxUrl)};
      globalThis.__extension_side_effect = false;
      const hostileFetch = () => "forged";
      Object.defineProperty(globalThis, "fetch", {
        value: hostileFetch,
        writable: false,
        configurable: false,
        enumerable: true,
      });
      const before = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      let startupError;
      let extensionImportAttempted = false;
      try {
        initializeSandbox();
        extensionImportAttempted = true;
        await import(${JSON.stringify(extensionUrl)});
      } catch (error) {
        startupError = error;
      }
      const after = Object.getOwnPropertyDescriptor(globalThis, "fetch");
      postMessage({
        kind: "startup-report",
        error: startupError instanceof Error ? startupError.message : "",
        extensionImportAttempted,
        extensionSideEffect: globalThis.__extension_side_effect,
        descriptorUnchanged:
          before?.value === after?.value &&
          before?.writable === after?.writable &&
          before?.configurable === after?.configurable &&
          before?.enumerable === after?.enumerable,
      });
    `;
    const workerPath = `/tmp/spindle-sandbox-startup-${crypto.randomUUID()}.mjs`;
    await Bun.write(workerPath, workerSource);
    const worker = new Worker(workerPath, { type: "module" });
    let extensionSideEffect = false;
    try {
      const report = await new Promise<{
        error: string;
        extensionImportAttempted: boolean;
        extensionSideEffect: boolean;
        descriptorUnchanged: boolean;
      }>((resolve, reject) => {
        worker.onmessage = (event) => {
          if (event.data?.kind === "extension-side-effect") {
            extensionSideEffect = true;
            return;
          }
          if (event.data?.kind === "startup-report") resolve(event.data);
        };
        worker.onerror = (event) => reject(new Error(event.message || "sandbox worker failed"));
      });
      expect(report.error).toBe("Sandbox guard installation failed (global fetch)");
      expect(report.extensionImportAttempted).toBe(false);
      expect(report.extensionSideEffect).toBe(false);
      expect(extensionSideEffect).toBe(false);
      expect(report.descriptorUnchanged).toBe(true);
    } finally {
      worker.terminate();
      await unlink(workerPath);
    }
  }, { timeout: 30_000 });

  test("allows startup when an optional blocked surface is absent", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          import { initializeSandbox } from "./src/spindle/worker-runtime-sandbox.ts";

          const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
          if (descriptor && !descriptor.configurable) {
            throw new Error("WebSocket fixture cannot be made absent");
          }
          delete globalThis.WebSocket;
          if ("WebSocket" in globalThis) throw new Error("WebSocket surface remained present");

          initializeSandbox();
          if (typeof globalThis.WebSocket !== "undefined") {
            throw new Error("absent WebSocket surface was recreated");
          }
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});

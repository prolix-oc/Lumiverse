/**
 * Runtime sandbox for Spindle extension workers / subprocesses.
 *
 * Called immediately before the extension entry is dynamically imported.
 * It patches global APIs that are common bypass vectors: eval, the Function
 * constructor, indirect Bun/process API access, and sensitive env vars.
 *
 * IMPORTANT: This is a *cooperative* sandbox. It raises the cost of escape
 * but does not replace OS-level isolation (sandbox-exec, containers, etc.).
 *
 * KNOWN LIMITATION — dynamic import(): the `globalThis.import` override below
 * does NOT intercept the native ESM `import()` operator. `import()` is a
 * syntactic form resolved by the runtime, not a property read on globalThis,
 * so overriding the global has no effect on `await import("node:process")` or
 * `await import("bun:ffi")`; Bun loader plugins likewise cannot intercept
 * `node:` builtins. Blocking dangerous module specifiers is enforced UPSTREAM
 * by the static scan (`detectDangerousBackendCapabilities`, which fails closed
 * on any non-constant specifier) and, when enabled, by the OS-level sandbox.
 * The override here is kept only as best-effort defence against code that
 * reads `globalThis.import` explicitly — treat it as belt-and-suspenders, not
 * a boundary.
 */

import {
  BLOCKED_BUN_API_NAMES,
  BLOCKED_GLOBAL_API_NAMES,
  BLOCKED_MODULE_SPECIFIER_LABELS,
  BLOCKED_PROCESS_API_NAMES,
  isSensitiveEnvironmentKey,
} from "./dangerous-runtime-policy";

const BLOCKED_SPECIFIERS = new Set(BLOCKED_MODULE_SPECIFIER_LABELS.keys());

const BLOCKED_BUN_APIS = BLOCKED_BUN_API_NAMES;
const BLOCKED_PROCESS_APIS = BLOCKED_PROCESS_API_NAMES;

function guardImport(
  originalImport: (specifier: string | URL) => Promise<any>
): (specifier: string | URL) => Promise<any> {
  return async function (specifier: string | URL) {
    const key = String(specifier);
    if (BLOCKED_SPECIFIERS.has(key)) {
      throw new Error(`Module '${key}' is blocked in extension context`);
    }
    // Block data: URLs that may contain executable JavaScript
    if (
      key.startsWith("data:text/javascript") ||
      key.startsWith("data:application/javascript")
    ) {
      throw new Error(
        "data: javascript URLs are blocked in extension context"
      );
    }
    return (originalImport as any)(specifier);
  } as any;
}

function guardRequire(originalRequire: NodeRequire): NodeRequire {
  const wrapped = function (specifier: string) {
    if (BLOCKED_SPECIFIERS.has(specifier)) {
      throw new Error(`Module '${specifier}' is blocked in extension context`);
    }
    return originalRequire(specifier);
  } as NodeRequire;
  wrapped.resolve = originalRequire.resolve;
  wrapped.extensions = originalRequire.extensions;
  return wrapped;
}

/** Mask sensitive env vars so extensions cannot exfiltrate credentials. */
function scrubSensitiveEnv(rawEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(rawEnv)) {
    if (isSensitiveEnvironmentKey(key)) {
      try {
        delete rawEnv[key];
      } catch {
        /* ignore undeletable environment entries */
      }
    }
  }
}

function createMaskedEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {

  return new Proxy(rawEnv, {
    get(target, prop) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        return undefined;
      }
      return (target as any)[prop];
    },
    set(target, prop, value) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        throw new Error(
          `Setting sensitive env var '${prop}' is blocked in extension context`
        );
      }
      (target as any)[prop] = value;
      return true;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((k) => {
        return typeof k !== "string" || !isSensitiveEnvironmentKey(k);
      });
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

export function initializeSandbox(options?: { allowDynamicCode?: boolean }): void {
  const allowDynamicCode = options?.allowDynamicCode === true;

  // The dynamic-code capability only opts out of the eval/constructor guards.
  // Every module-loader, network, filesystem, process, environment, and Bun
  // guard below remains active regardless of this option.
  // ── Guard dynamic import (best-effort only) ──
  // NOTE: this overrides the `globalThis.import` property, which the native
  // `import()` operator does NOT consult. It does not stop `await import(...)`.
  // See the file header — real enforcement is the upstream static scan / OS
  // sandbox. Kept for the rare case of explicit `globalThis.import(...)` use.
  try {
    const originalImport = (globalThis as any).import;
    Object.defineProperty(globalThis, "import", {
      value: guardImport(originalImport),
      writable: false,
      configurable: false,
    });
  } catch {
    /* ignore */
  }

  // ── Guard require (CJS interop in Bun) ──
  const g = globalThis as any;
  if (typeof g.require === "function") {
    try {
      Object.defineProperty(g, "require", {
        value: guardRequire(g.require),
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // ── Guard the global module.require escape ──
  if (g.module && typeof g.module.require === "function") {
    try {
      const moduleRequire = g.module.require.bind(g.module) as NodeRequire;
      Object.defineProperty(g.module, "require", {
        value: guardRequire(moduleRequire),
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // ── Restrict privileged global constructors and fetch ──
  for (const api of BLOCKED_GLOBAL_API_NAMES) {
    if (typeof g[api] !== "function") continue;
    try {
      Object.defineProperty(g, api, {
        value: function () {
          throw new Error(`${api} is disabled in extension context`);
        },
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore unavailable global */
    }
  }

  if (!allowDynamicCode) {
    // ── Block eval ──
    try {
      Object.defineProperty(globalThis, "eval", {
        value: function () {
          throw new Error("eval is disabled in extension context");
        },
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }

    // ── Block dynamic function constructors ──
    try {
      const originalFunctionPrototype = Function.prototype;
      const dynamicFunctionPrototypes = [
        originalFunctionPrototype,
        Object.getPrototypeOf(async function () {}),
        Object.getPrototypeOf(function* () {}),
        Object.getPrototypeOf(async function* () {}),
      ];
      const blockedFunction = function () {
        throw new Error("Function constructor is disabled in extension context");
      };
      for (const prototype of dynamicFunctionPrototypes) {
        try {
          Object.defineProperty(prototype, "constructor", {
            value: blockedFunction,
            writable: false,
            configurable: false,
          });
        } catch {
          /* ignore unavailable intrinsic */
        }
      }

      const blockedFunctionPrototype = Object.create(
        Object.getPrototypeOf(originalFunctionPrototype)
      );
      Object.defineProperties(
        blockedFunctionPrototype,
        Object.getOwnPropertyDescriptors(originalFunctionPrototype)
      );
      blockedFunction.prototype = blockedFunctionPrototype;

      Object.defineProperty(globalThis, "Function", {
        value: blockedFunction,
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // ── Restrict Bun APIs ──
  if (typeof Bun !== "undefined") {
    for (const api of BLOCKED_BUN_APIS) {
      if ((Bun as any)[api]) {
        try {
          Object.defineProperty(Bun, api, {
            value: function () {
              throw new Error(`Bun.${api} is disabled in extension context`);
            },
            writable: false,
            configurable: false,
          });
        } catch {
          /* read-only or non-configurable */
        }
      }
    }
  }

  // ── Restrict process APIs ──
  if (typeof process !== "undefined") {
    for (const api of BLOCKED_PROCESS_APIS) {
      if ((process as any)[api]) {
        try {
          Object.defineProperty(process, api, {
            value: function () {
              throw new Error(
                `process.${api} is disabled in extension context`
              );
            },
            writable: false,
            configurable: false,
          });
        } catch {
          /* ignore */
        }
      }
    }

    // Mask sensitive env vars
    try {
      scrubSensitiveEnv(process.env);
      Object.preventExtensions(process.env);
      const maskedEnv = createMaskedEnv(process.env);
      Object.defineProperty(process, "env", {
        value: maskedEnv,
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
  }
}

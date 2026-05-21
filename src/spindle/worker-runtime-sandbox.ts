/**
 * Runtime sandbox for Spindle extension workers / subprocesses.
 *
 * Called immediately before the extension entry is dynamically imported.
 * It patches global APIs that are common bypass vectors for static-analysis
 * defences (dynamic imports, eval, indirect Bun API access, etc.).
 *
 * IMPORTANT: This is a *cooperative* sandbox. It raises the cost of escape
 * but does not replace OS-level isolation (sandbox-exec, containers, etc.).
 */

const BLOCKED_SPECIFIERS = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "http",
  "node:http",
  "https",
  "node:https",
  "bun:sqlite",
  "node:sqlite",
  "sqlite3",
  "better-sqlite3",
]);

const BLOCKED_BUN_APIS = new Set([
  "file",
  "write",
  "spawn",
  "spawnSync",
  "serve",
  "connect",
  "listen",
  "openInEditor",
]);

const BLOCKED_PROCESS_APIS = new Set([
  "exit",
  "kill",
  "chdir",
  "dlopen",
  "abort",
]);

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
  wrapped.cache = originalRequire.cache;
  wrapped.extensions = originalRequire.extensions;
  wrapped.main = originalRequire.main;
  return wrapped;
}

/** Mask sensitive env vars so extensions cannot exfiltrate credentials. */
function createMaskedEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const SENSITIVE_PATTERNS = [
    /^LUMIVERSE_/i,
    /^AUTH_/i,
    /SECRET/i,
    /PASSWORD/i,
    /PRIVATE_KEY/i,
    /ENCRYPTION_KEY/i,
    /API_KEY/i,
    /TOKEN/i,
    /^HOME$/i,
    /^USERPROFILE$/i,
    /^SSH_/i,
  ];

  function isSensitive(key: string): boolean {
    return SENSITIVE_PATTERNS.some((p) => p.test(key));
  }

  return new Proxy(rawEnv, {
    get(target, prop) {
      if (typeof prop === "string" && isSensitive(prop)) {
        return undefined;
      }
      return (target as any)[prop];
    },
    set(target, prop, value) {
      if (typeof prop === "string" && isSensitive(prop)) {
        throw new Error(
          `Setting sensitive env var '${prop}' is blocked in extension context`
        );
      }
      (target as any)[prop] = value;
      return true;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((k) => {
        return typeof k !== "string" || !isSensitive(k);
      });
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && isSensitive(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

export function initializeSandbox(): void {
  // ── Guard dynamic import ──
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

  // ── Block Function constructor ──
  try {
    const originalFunctionPrototype = Function.prototype;
    const blockedFunction = function () {
      throw new Error("Function constructor is disabled in extension context");
    };
    const blockedFunctionPrototype = Object.create(
      Object.getPrototypeOf(originalFunctionPrototype)
    );
    Object.defineProperties(
      blockedFunctionPrototype,
      Object.getOwnPropertyDescriptors(originalFunctionPrototype)
    );
    Object.defineProperty(blockedFunctionPrototype, "constructor", {
      value: blockedFunction,
      writable: true,
      configurable: true,
    });
    blockedFunction.prototype = blockedFunctionPrototype;

    Object.defineProperty(globalThis, "Function", {
      value: blockedFunction,
      writable: false,
      configurable: false,
    });
  } catch {
    /* ignore */
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

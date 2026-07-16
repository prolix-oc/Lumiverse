import { describe, expect, test } from "bun:test";

import {
  applyStorageSeeds,
  bunInstallCmd,
  declaredCapabilitiesFromManifest,
  detectDangerousBackendCapabilities,
  detectSerializedHandlerModuleAccess,
  getManifest,
  importLocalExtensions,
  PRIVILEGED_PERMISSIONS,
  shouldUseWindowsSpindleBunSyncFallback,
  validateBackendModuleGraph,
} from "./manager.service";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { env } from "../env";
import type { SpindleCapability, SpindleManifest } from "lumiverse-spindle-types";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function manyIgnoredSpanHandler(): string {
  const ignored = Array.from({ length: 4_096 }, (_, index) => `/*ignored-${index}*/`).join("");
  const handler = `${ignored}return globalThis.require("node:fs");`;
  if (new TextEncoder().encode(handler).byteLength > 65_536) {
    throw new Error("many-ignored-span fixture exceeded the serialized handler limit");
  }
  return handler;
}

describe("detectDangerousBackendCapabilities", () => {
  test("flags blocked runtime capabilities", () => {
    const code = `
      import { readFileSync } from "node:fs";
      const child = require("node:child_process");
      const db = await import("bun:sqlite");
      const value = process.env.SECRET_KEY;
      Bun.spawn(["whoami"]);
      void readFileSync;
      void child;
      void db;
      void value;
    `;

    expect(detectDangerousBackendCapabilities(code)).toEqual([
      "filesystem module access",
      "subprocess module access",
      "direct SQLite module access",
      "dangerous Bun system API usage",
      "dangerous process API usage",
    ]);
  });

  test("allows ordinary spindle backend logic", () => {
    const code = `
      spindle.onFrontendMessage((payload) => {
        spindle.frontend.postMessage({ ok: true, payload });
      });

      export async function activate() {
        const granted = await spindle.permissions.getGranted();
        return granted.length;
      }
    `;

    expect(detectDangerousBackendCapabilities(code)).toEqual([]);
  });
  test("does not classify local shadows by free identifier name", () => {
    const safeCases = [
      { name: "unused Worker class declaration", source: "class Worker {}" },
      { name: "unused WebSocket class declaration", source: "class WebSocket {}" },
      { name: "unused BroadcastChannel class declaration", source: "class BroadcastChannel {}" },
      {
        name: "unused Worker named import binding",
        source: 'import { Worker } from "./local-worker";',
      },
      {
        name: "unused WebSocket named import binding",
        source: 'import { WebSocket } from "./local-websocket";',
      },
      {
        name: "unused BroadcastChannel named import binding",
        source: 'import { BroadcastChannel } from "./local-channel";',
      },
      {
        name: "unused Worker default import binding",
        source: 'import Worker from "./local-worker";',
      },
      {
        name: "unused WebSocket namespace import binding",
        source: 'import * as WebSocket from "./local-websocket";',
      },
      { name: "unused Worker class expression binding", source: "const Worker = class {};" },
      { name: "unused WebSocket class expression binding", source: "const WebSocket = class {};" },
      {
        name: "unused BroadcastChannel class expression binding",
        source: "const BroadcastChannel = class {};",
      },
      {
        name: "local fetch function invocation",
        source: "function fetch() {} fetch();",
      },
      {
        name: "local Worker function instantiation",
        source: "function Worker() {} new Worker();",
      },
      {
        name: "local WebSocket function instantiation",
        source: "function WebSocket() {} new WebSocket();",
      },
      {
        name: "local BroadcastChannel function instantiation",
        source: "function BroadcastChannel() {} new BroadcastChannel();",
      },
      {
        name: "local fetch variable invocation",
        source: "const fetch = () => {}; fetch();",
      },
      {
        name: "local Worker variable instantiation",
        source: "const Worker = function Worker() {}; new Worker();",
      },
      {
        name: "local WebSocket variable instantiation",
        source: "const WebSocket = function WebSocket() {}; new WebSocket();",
      },
      {
        name: "local BroadcastChannel variable instantiation",
        source: "const BroadcastChannel = function BroadcastChannel() {}; new BroadcastChannel();",
      },
      {
        name: "local fetch alias invocation",
        source: "const fetch = () => {}; const f = fetch; f();",
      },
    ];

    for (const { name, source } of safeCases) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([]);
    }
  });

  test("classifies explicit globalThis access and globalThis-derived bindings", () => {
    const dangerousCases = [
      {
        name: "explicit globalThis fetch call",
        source: 'globalThis.fetch("https://example.test");',
        label: "direct network API usage",
      },
      {
        name: "computed globalThis Worker constructor",
        source: 'new globalThis["Worker"]("worker.js");',
        label: "worker runtime API usage",
      },
      {
        name: "computed globalThis WebSocket constructor",
        source: 'new globalThis["WebSocket"]("wss://example.test");',
        label: "direct network API usage",
      },
      {
        name: "Worker destructuring alias sourced from globalThis",
        source: 'const { Worker: WorkerCtor } = globalThis; new WorkerCtor("worker.js");',
        label: "worker runtime API usage",
      },
      {
        name: "WebSocket destructuring alias sourced from globalThis",
        source: 'const { WebSocket: SocketCtor } = globalThis; new SocketCtor("wss://example.test");',
        label: "direct network API usage",
      },
      {
        name: "BroadcastChannel destructuring alias sourced from globalThis",
        source: 'const { BroadcastChannel: ChannelCtor } = globalThis; new ChannelCtor("events");',
        label: "worker runtime API usage",
      },
      {
        name: "globalThis destructuring default binding",
        source: "const localFetch = () => {}; const { fetch = localFetch } = globalThis;",
        label: "direct network API usage",
      },
      {
        name: "parenthesized globalThis destructuring assignment",
        source: "let WorkerCtor; ({ Worker: WorkerCtor } = globalThis);",
        label: "worker runtime API usage",
      },
    ];

    for (const { name, source, label } of dangerousCases) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([label]);
    }
  });
  test("tracks recognized global-object aliases without broadening local-object matches", () => {
    const blockedCases = [
      {
        name: "direct globalThis alias",
        source: 'const root = globalThis; root.fetch("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "direct self fetch",
        source: 'self.fetch("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "direct global Worker constructor",
        source: 'new global.Worker("worker.js");',
        expected: ["worker runtime API usage"],
      },
      {
        name: "direct global alias",
        source: 'const root = global; root.fetch("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "transitive globalThis aliases",
        source: 'const root = globalThis; const alias = root; alias.fetch("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "assigned globalThis alias",
        source: 'let root; root = globalThis; root.fetch("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "nested writer promotes transitive alias",
        source: "let root = {}; function set() { root = globalThis; } set(); const alias = root; alias.fetch(url);",
        expected: ["direct network API usage"],
      },
      {
        name: "default parameter global alias",
        source: "function f(root = globalThis) { root.fetch(url); } f();",
        expected: ["direct network API usage"],
      },
      {
        name: "expression-bodied arrow default global alias",
        source: "const f = (root = globalThis) => root.fetch(url); f();",
        expected: ["direct network API usage"],
      },
      {
        name: "destructured default parameter global alias",
        source: "function f({ root = globalThis } = {}) { root.fetch(url); } f();",
        expected: ["direct network API usage"],
      },
      {
        name: "array-default nested global alias",
        source: "function f([root = globalThis] = []) { root.fetch(url); } f([]);",
        expected: ["direct network API usage"],
      },
      {
        name: "nested destructured-array default global alias",
        source: "function f({x: [root = globalThis]}={x:[]}) { root.fetch(url); } f();",
        expected: ["direct network API usage"],
      },
      {
        name: "for-of global alias",
        source: "for (const root of [globalThis]) { root.fetch(url); }",
        expected: ["direct network API usage"],
      },
      {
        name: "for-init global alias",
        source: "for (const root = globalThis; ;) { root.fetch(url); break; }",
        expected: ["direct network API usage"],
      },
      {
        name: "named function in instanceof does not shadow global root",
        source: "void (0 instanceof function globalThis(){}); globalThis.fetch(url);",
        expected: ["direct network API usage"],
      },
      {
        name: "named function in switch case does not shadow global root",
        source: "switch (value) { case function globalThis(){}: globalThis.fetch(url); }",
        expected: ["direct network API usage"],
      },
      {
        name: "nested function assignment promotes outer alias",
        source: "let root = {}; function set() { root = globalThis; } set(); root.fetch(url);",
        expected: ["direct network API usage"],
      },
      {
        name: "later function declaration assignment promotes outer alias",
        source: "let root = {}; set(); root.fetch(url); function set() { root = globalThis; }",
        expected: ["direct network API usage"],
      },
      {
        name: "transitively assigned self alias",
        source: 'let root; root = self; let alias; alias = root; new alias.Worker("worker.js");',
        expected: ["worker runtime API usage"],
      },
      {
        name: "computed static key through alias",
        source: 'const root = globalThis; root["f" + "etch"]("https://example.test");',
        expected: ["direct network API usage"],
      },
      {
        name: "constructor access through alias",
        source: 'const root = globalThis; new root.Worker("worker.js");',
        expected: ["worker runtime API usage"],
      },
      {
        name: "destructuring from an aliased global object",
        source: 'const root = globalThis; const { WebSocket: Socket } = root; new Socket("wss://example.test");',
        expected: ["direct network API usage"],
      },
    ];

    for (const { name, source, expected } of blockedCases) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual(expected);
    }

    const failClosedCases = [
      {
        name: "unresolved direct globalThis key",
        source: "globalThis[dynamicKey]();",
      },
      {
        name: "unresolved direct globalThis read",
        source: "void globalThis[dynamicKey];",
      },
      {
        name: "unresolved aliased global constructor",
        source: "const root = globalThis; new root[dynamicKey]();",
      },
      {
        name: "unresolved optional global access",
        source: "globalThis?.[dynamicKey];",
      },
      {
        name: "unresolved optional aliased global access",
        source: "const root = globalThis; root?.[dynamicKey];",
      },
      {
        name: "oversized direct global key",
        source: `globalThis[${JSON.stringify("x".repeat(301))}]();`,
      },
      {
        name: "unresolved aliased global key",
        source: "const root = globalThis; root[dynamicKey]();",
      },
      {
        name: "oversized aliased global key",
        source: `const root = globalThis; root[${JSON.stringify("x".repeat(301))}]();`,
      },
    ];
    for (const { name, source } of failClosedCases) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([
        "dynamic global API access",
      ]);
    }

    const safeCases = [
      {
        name: "ordinary local object with dangerous-looking property",
        source: "const root = {}; root.fetch();",
      },
      {
        name: "factory result with dangerous-looking property",
        source: "const root = makeGlobalLikeObject(); root.Worker();",
      },
      {
        name: "known harmless property through global alias",
        source: "const root = globalThis; root.setTimeout(() => {}, 0);",
      },
      {
        name: "shadowed default parameter stays local",
        source: "const root=globalThis; function f(root={}){root.fetch(url)} f();",
      },
      {
        name: "shadowed globalThis parameter",
        source: "function use(globalThis) { globalThis.fetch(); }",
      },
      {
        name: "shadowed self binding",
        source: "const self = {}; self.Worker();",
      },
      {
        name: "shadowed global binding",
        source: "const global = {}; global.fetch();",
      },
      {
        name: "nested local alias shadows outer global provenance",
        source: "const root = globalThis; { const root = {}; root.fetch(); }",
      },
      {
        name: "reassigned alias loses global provenance",
        source: "let root = globalThis; root = {}; root.fetch();",
      },
      {
        name: "oversized key on ordinary local object",
        source: `const root = {}; root[${JSON.stringify("fetch".repeat(100))}]();`,
      },
    ];
    for (const { name, source } of safeCases) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([]);
    }
  });

  test("flags global Reflect/Object property access through static call forms", () => {
    const blocked: Array<{ name: string; source: string; label: string }> = [
      {
        name: "Reflect.get direct globalThis fetch",
        source: 'Reflect.get(globalThis, "fetch")',
        label: "direct network API usage",
      },
      {
        name: "Reflect.get computed global WebSocket",
        source: 'Reflect["get"](global, "WebSocket")',
        label: "direct network API usage",
      },
      {
        name: "Object descriptor self Worker",
        source: 'Object.getOwnPropertyDescriptor(self, "Worker")',
        label: "worker runtime API usage",
      },
      {
        name: "Object computed descriptor globalThis BroadcastChannel",
        source: 'Object["getOwnPropertyDescriptor"](globalThis, "BroadcastChannel")',
        label: "worker runtime API usage",
      },
      {
        name: "Object descriptor BroadcastChannel value",
        source: 'Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel").value',
        label: "worker runtime API usage",
      },
      {
        name: "comment-separated Reflect alias",
        source: 'Reflect /* gap */ . /* gap */ get(/* receiver */ globalThis, /* key */ "fetch")',
        label: "direct network API usage",
      },
      {
        name: "Reflect.get call dispatch",
        source: 'Reflect.get.call(null, globalThis, "fetch")',
        label: "direct network API usage",
      },
      {
        name: "Reflect computed get apply dispatch",
        source: 'Reflect["get"].apply(null, [global, "WebSocket"])',
        label: "direct network API usage",
      },
      {
        name: "Object descriptor bind dispatch",
        source: 'Object.getOwnPropertyDescriptor.bind(null)(self, "Worker")',
        label: "worker runtime API usage",
      },
      {
        name: "global fetch call dispatch",
        source: "globalThis.fetch.call(undefined, request)",
        label: "direct network API usage",
      },
      {
        name: "self WebSocket apply dispatch",
        source: "self.WebSocket.apply(undefined, [url])",
        label: "direct network API usage",
      },
      {
        name: "global Worker bind dispatch",
        source: "global.Worker.bind(undefined)",
        label: "worker runtime API usage",
      },
      {
        name: "global alias Reflect descriptor",
        source:
          'const host = global; Object.getOwnPropertyDescriptor(host, "BroadcastChannel")',
        label: "worker runtime API usage",
      },
    ];

    for (const { name, source, label } of blocked) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([label]);
    }
  });

  test("fails closed for unresolved global Reflect/Object receivers or keys", () => {
    const dynamic = [
      'Reflect.get(receiver, "fetch")',
      'Reflect.get(globalThis, propertyName)',
      'Object.getOwnPropertyDescriptor(receiver, "WebSocket")',
      'Object["getOwnPropertyDescriptor"](global, propertyName)',
      'Reflect.get.call(null, globalThis, propertyName)',
    ];

    for (const source of dynamic) {
      expect(detectDangerousBackendCapabilities(source), source).toContain(
        "dynamic global API access",
      );
    }
  });

  test("does not classify local or unrelated Reflect/Object receivers", () => {
    const safe = `
      const local = {
        fetch: 1,
        WebSocket: 2,
        Worker: 3,
        BroadcastChannel: 4,
      };
      const globalThis = local;
      Reflect.get(local, "fetch");
      Reflect.get(local, "WebSocket");
      Object.getOwnPropertyDescriptor(local, "Worker");
      Object["getOwnPropertyDescriptor"](local, "BroadcastChannel");
      local.fetch.call(undefined);
      globalThis.WebSocket;
    `;

    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("rejects static native-addon module targets across loader forms", () => {
    const blocked: Array<{ name: string; source: string }> = [
      { name: "static import", source: 'import addon from "./native.node"; void addon;' },
      { name: "static bare ESM import", source: 'import "native.node";' },
      { name: "dynamic relative import", source: 'await import("./native.node");' },
      { name: "dynamic concatenated import", source: 'await import("./" + "native.node");' },
      { name: "bare require", source: 'require("native.node");' },
      { name: "case-insensitive query/hash require", source: 'require("./native.NODE?abi=1#arm64");' },
      { name: "relative import.meta.require", source: 'import.meta.require("./native.node");' },
      { name: "bare import.meta.require", source: 'import.meta.require("native.node");' },
      {
        name: "relative createRequire",
        source: 'createRequire(import.meta.url)("./native.node");',
      },
      {
        name: "bare createRequire with query/hash",
        source: 'createRequire(import.meta.url)("native.node?abi=1#x");',
      },
      { name: "module.require", source: 'module.require("./native.node");' },
    ];

    for (const { name, source } of blocked) {
      const expected = name.includes("createRequire")
        ? ["module loading", "dynamic module access"]
        : ["module loading"];
      expect(detectDangerousBackendCapabilities(source), name).toEqual(expected);
    }
  });

  test("does not reject native-addon text or non-loader controls", () => {
    const safe = `
      const suffix = ".node";
      const mention = "native.node?abi=1#x";
      const ordinary = await import("./native.js");
      const version = require("native.node.txt");
      const source = import.meta.url;
      fetch("native.node");
      void suffix; void mention; void ordinary; void version; void source;
    `;

    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("keeps exact classification after thousands of expression arrows", () => {
    const arrows = Array.from(
      { length: 2_048 },
      (_, index) => `(value${index}) => value${index}`,
    ).join(",\n");
    const source = `const handlers = [\n${arrows}\n];\nReflect.get(process, "env");`;

    // Structural load, not a wall-clock benchmark: every arrow contributes a
    // delimiter boundary and the final reflective access is the only hit.
    expect(detectDangerousBackendCapabilities(source)).toEqual([
      "dangerous process API usage",
    ]);
  });


  test("flags common evasions for native backend capabilities", () => {
    const samples: Array<[string, string]> = [
      [`Bun["file"]("/etc/passwd")`, "dangerous Bun system API usage"],
      [`Bun["fil" + "e"]("/etc/passwd")`, "dangerous Bun system API usage"],
      [`Bun[\`fil\${""}e\`]("/etc/passwd")`, "dangerous Bun system API usage"],
      [`const B = Bun; B.file("/etc/passwd")`, "dangerous Bun system API usage"],
      [`const { file } = Bun; file("/etc/passwd")`, "dangerous Bun system API usage"],
      [`await import("f" + "s")`, "filesystem module access"],
      [`await import(String.fromCharCode(102, 115))`, "filesystem module access"],
      [`process["e" + "nv"].SECRET`, "dangerous process API usage"],
      [`Object.getOwnPropertyDescriptor(process, "env")?.value`, "dangerous process API usage"],
      [`\u0070rocess.env.SECRET`, "dangerous process API usage"],
      [`eval(Buffer.from("Zm9v", "base64").toString())`, "dynamic code execution"],
      [`const bytes = Buffer.from(input, "base64");`, "base64 decoding"],
    ];

    for (const [code, label] of samples) {
      expect(detectDangerousBackendCapabilities(code)).toContain(label);
    }
  });

  test("fails closed on dynamic import()/require() with a non-constant specifier", () => {
    // The whole point: a specifier the scanner cannot prove constant could
    // resolve to node:fs / child_process / etc. at runtime, and neither the
    // (inert) global import override nor a Bun loader plugin can intercept a
    // node: builtin. So these MUST be hard-blocked at scan time.
    const bypasses = [
      'const seg = "fs"; await import(`node:${seg}`);',     // template interpolation
      'const s = "fs"; await import("node:" + s);',          // concat with a variable
      'await import(["node:", "fs"].join(""));',             // array join
      'const n = 110; await import(String.fromCharCode(n, 111, 100, 101, 58, 102, 115));', // fromCharCode w/ var
      'const k = "fs"; const fs = require(k);',              // bare variable
      'const x = "f"; await import(`${x}s`);',               // leading interpolation
      'await import(globalThis["node:" + "fs"]);',           // computed member access
    ];
    for (const code of bypasses) {
      expect(detectDangerousBackendCapabilities(code)).toContain("dynamic module access");
    }
  });

  test("hard-blocks dynamic module access even with every capability declared", () => {
    // "dynamic module access" has no capability opt-in (the specifier could be
    // any blocked builtin), mirroring fs/child_process.
    const code = 'const seg = "fs"; await import(`node:${seg}`);';
    expect(
      detectDangerousBackendCapabilities(
        code,
        new Set<SpindleCapability>(["dynamic_code_execution", "base64_decode"]),
      ),
    ).toContain("dynamic module access");
  });

  test("still resolves constant dynamic specifiers to their specific label", () => {
    // Fail-closed must not lose precision: provably-constant dangerous
    // specifiers keep their exact label rather than the generic block.
    const samples: Array<[string, string]> = [
      ['await import("node:fs");', "filesystem module access"],
      ['await import("no" + "de:" + "fs");', "filesystem module access"],
      ['await import(String.fromCharCode(110, 111, 100, 101, 58, 102, 115));', "filesystem module access"],
      ['require("node:child_process");', "subprocess module access"],
    ];
    for (const [code, label] of samples) {
      const hits = detectDangerousBackendCapabilities(code);
      expect(hits).toContain(label);
      expect(hits).not.toContain("dynamic module access");
    }
  });
  test("hard-blocks every module-loader escape acquisition form and ignores opt-ins", () => {
    const blockedModules: Array<{ specifier: string; label: string }> = [
      { specifier: "fs", label: "filesystem module access" },
      { specifier: "fs/promises", label: "filesystem module access" },
      { specifier: "node:fs", label: "filesystem module access" },
      { specifier: "node:fs/promises", label: "filesystem module access" },
      { specifier: "child_process", label: "subprocess module access" },
      { specifier: "node:child_process", label: "subprocess module access" },
      { specifier: "net", label: "direct socket module access" },
      { specifier: "tls", label: "direct socket module access" },
      { specifier: "dgram", label: "direct socket module access" },
      { specifier: "http", label: "direct socket module access" },
      { specifier: "https", label: "direct socket module access" },
      { specifier: "node:net", label: "direct socket module access" },
      { specifier: "node:tls", label: "direct socket module access" },
      { specifier: "node:dgram", label: "direct socket module access" },
      { specifier: "node:http", label: "direct socket module access" },
      { specifier: "node:https", label: "direct socket module access" },
      { specifier: "worker_threads", label: "worker or cluster module access" },
      { specifier: "cluster", label: "worker or cluster module access" },
      { specifier: "node:worker_threads", label: "worker or cluster module access" },
      { specifier: "node:cluster", label: "worker or cluster module access" },
      { specifier: "bun:sqlite", label: "direct SQLite module access" },
      { specifier: "node:sqlite", label: "direct SQLite module access" },
      { specifier: "sqlite3", label: "direct SQLite module access" },
      { specifier: "better-sqlite3", label: "direct SQLite module access" },
      { specifier: "module", label: "module loader access" },
      { specifier: "node:module", label: "module loader access" },
      { specifier: "vm", label: "module loader access" },
      { specifier: "node:vm", label: "module loader access" },
      { specifier: "process", label: "module loader access" },
      { specifier: "node:process", label: "module loader access" },
      { specifier: "bun", label: "module loader access" },
      { specifier: "bun:ffi", label: "native FFI loader access" },
      { specifier: "node:ffi", label: "native FFI loader access" },
    ];

    for (const { specifier, label } of blockedModules) {
      const quoted = JSON.stringify(specifier);
      const forms = [
        `import * as acquired from ${quoted}; void acquired;`,
        `await import(${quoted});`,
        `require(${quoted});`,
      ];
      for (const code of forms) {
        expect(detectDangerousBackendCapabilities(code)).toContain(label);
      }
      if (specifier === "sqlite3" || specifier === "better-sqlite3") {
        const staticImportForms = [
          `import acquired from ${quoted}; void acquired;`,
          `import { acquired } from ${quoted}; void acquired;`,
        ];
        for (const code of staticImportForms) {
          expect(detectDangerousBackendCapabilities(code)).toContain(label);
        }
      }
    }

    const exploit = String.raw`
      const { createRequire } = await import("node:module");
      const alias = createRequire("/tmp/extension.js");
      const fs = alias("node:fs");
      const decoded = Buffer.from("Zm9v", "base64").toString();
      return eval("fs" + decoded);
    `;
    const capabilitySets: ReadonlySet<SpindleCapability>[] = [
      new Set(),
      new Set<SpindleCapability>(["dynamic_code_execution"]),
      new Set<SpindleCapability>(["base64_decode"]),
      new Set<SpindleCapability>(["dynamic_code_execution", "base64_decode"]),
    ];
    for (const capabilities of capabilitySets) {
      expect(detectDangerousBackendCapabilities(exploit, capabilities)).toContain(
        "module loader access",
      );
    }
    const exploitHits = detectDangerousBackendCapabilities(exploit, capabilitySets[3]);
    expect(exploitHits).not.toContain("dynamic code execution");
    expect(exploitHits).not.toContain("base64 decoding");

    const safe = String.raw`
      // import("node:module"); require("node:fs"); Bun.spawn(["id"]);
      const prose = "import('node:module') require('node:fs') process.env.SECRET";
      const packageModule = await import("zod");
      return { prose, packageModule };
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("blocks process builtin-module loading through direct and aliased access", () => {
    const cases = [
      `process.getBuiltinModule("fs")`,
      `const { getBuiltinModule } = process; getBuiltinModule("fs")`,
      `const loader = process.getBuiltinModule; loader("fs")`,
    ];
    const allOptIns = new Set<SpindleCapability>([
      "dynamic_code_execution",
      "base64_decode",
    ]);
    for (const code of cases) {
      expect(detectDangerousBackendCapabilities(code, allOptIns)).toContain(
        "dangerous process API usage",
      );
    }

    const safe = String.raw`
      // process.getBuiltinModule("fs");
      const prose = "process.getBuiltinModule('fs')";
      /* const { getBuiltinModule } = process; */
      return prose;
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });
  test("blocks process binding loaders through direct, aliased, and destructured access", () => {
    const dynamicLoaders = [
      "process.binding(variable)",
      'process["_linkedBinding"](variable)',
      "const binding = process.binding; binding(variable)",
      "const linked = process._linkedBinding; linked(variable)",
      "const { binding } = process; binding(variable)",
      "const { _linkedBinding: linked } = process; linked(variable)",
    ];
    const allOptIns = new Set<SpindleCapability>([
      "dynamic_code_execution",
      "base64_decode",
    ]);
    for (const code of dynamicLoaders) {
      expect(detectDangerousBackendCapabilities(code, allOptIns)).toEqual([
        "dangerous process API usage",
      ]);
    }
    const reflectiveLoaders: Array<{ name: string; source: string }> = [
      {
        name: "Reflect.get direct binding",
        source: 'Reflect.get(process, "binding")("fs")',
      },
      {
        name: "Reflect.get direct _linkedBinding",
        source: 'Reflect.get(process, "_linkedBinding")("fs")',
      },
      {
        name: "Reflect.get computed static binding",
        source: 'Reflect.get(process, "bi" + "nding")("fs")',
      },
      {
        name: "Reflect.get computed static _linkedBinding",
        source: 'Reflect.get(process, "_link" + "edBinding")("fs")',
      },
      {
        name: "Reflect.get through a simple process alias",
        source: 'const p = process; Reflect.get(p, "binding")("fs")',
      },
      {
        name: "Reflect.get through a simple process _linkedBinding alias",
        source: 'const p = process; Reflect.get(p, "_linkedBinding")("fs")',
      },
      {
        name: "nested local process does not suppress global process",
        source:
          'function local() { const process = {}; Reflect.get(process, "binding")("fs"); } Reflect.get(process, "binding")("fs")',
      },
      {
        name: "expression arrow keeps global process visible",
        source: 'const f = () => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "multiline parenthesized expression keeps global process visible",
        source: `const f = () => (
          Reflect.get(process, "binding")("fs")
        )`,
      },
      {
        name: "arrow process parameter leaves outside process global",
        source:
          'const f = (process) => Reflect.get(process, "binding")("fs"); Reflect.get(process, "binding")("fs")',
      },
      {
        name: "process parameter does not shadow an outer global process alias",
        source: 'const p = process; ((process) => Reflect.get(p, "binding")("fs"))',
      },
      {
        name: "comma expression after process parameter arrow keeps global process dangerous",
        source:
          '((process) => Reflect.get(process, "binding")("fs"), Reflect.get(process, "binding")("fs"))',
      },
      {
        name: "destructured process property alias does not bind global process",
        source: 'const f = ({ process: local }) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "comment-separated direct process receiver",
        source: 'Reflect.get(/*x*/ process, "binding")("fs")',
      },
      {
        name: "comment-separated global process alias receiver",
        source: 'const p = process; Reflect.get(/*x*/ p, "binding")("fs")',
      },
      {
        name: "comment-separated Reflect method",
        source: 'Reflect/*gap*/.get(process, "binding")("fs")',
      },
      {
        name: "comment-separated Object descriptor method",
        source: 'Object/*gap*/.getOwnPropertyDescriptor(process, "binding").value("fs")',
      },
      {
        name: "comment-separated process alias initializer",
        source: 'const p = /*gap*/ process; Reflect.get(p, "binding")("fs")',
      },
      {
        name: "completed process parameter arrow then newline global process statement",
        source: `const f = (process) =>
          Reflect.get(process, "binding")("fs");
        Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "completed increment arrow then global process statement",
        source: `const f = (process) => counter++
        Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "completed call arrow then global process statement",
        source: `const f = (process) => foo()
        Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "completed index arrow then global process statement",
        source: `const f = (process) => x[y]
        Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "static computed Reflect.get method",
        source: 'Reflect["get"](process, "binding")("fs")',
      },
      {
        name: "static computed Reflect.get call",
        source: 'Reflect["get"].call(Reflect, process, "binding")("fs")',
      },
      {
        name: "static computed Reflect.get apply",
        source: 'Reflect["get"].apply(Reflect, [process, "binding"])("fs")',
      },
      {
        name: "static computed Reflect.get bind",
        source: 'Reflect["get"].bind(Reflect, process, "binding")("fs")',
      },
      {
        name: "static computed Object descriptor method",
        source: 'Object["getOwnPropertyDescriptor"](process, "binding").value("fs")',
      },
      {
        name: "global instanceof continuation control",
        source: `const f = () =>
          value
          instanceof Reflect.get(process, "binding")`,
      },
      {
        name: "global in continuation control",
        source: `const f = () =>
          process
          in Reflect.get(process, "binding")`,
      },
      {
        name: "global tagged-template continuation control",
        source: `const f = () =>
          tag
          \`value \${Reflect.get(process, "binding")("fs")}\``,
      },
      {
        name: "no-param commented arrow body keeps global process dangerous",
        source: `const f = () => /* comment before body */
          Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "Object descriptor through a simple process alias",
        source: 'const p = process; Object.getOwnPropertyDescriptor(p, "binding").value("fs")',
      },
      {
        name: "Reflect descriptor through a simple process alias",
        source: 'const p = process; Reflect.getOwnPropertyDescriptor(p, "binding").value("fs")',
      },
      {
        name: "Reflect.get binding call",
        source: 'Reflect.get(process, "binding").call(process, "fs")',
      },
      {
        name: "Reflect.get binding apply",
        source: 'Reflect.get(process, "binding").apply(process, ["fs"])',
      },
      {
        name: "Reflect.get binding bind",
        source: 'Reflect.get(process, "binding").bind(process)("fs")',
      },
      {
        name: "Reflect.apply on a reflected binding",
        source: 'Reflect.apply(Reflect.get(process, "binding"), process, ["fs"])',
      },
      {
        name: "Reflect.get _linkedBinding call",
        source: 'Reflect.get(process, "_linkedBinding").call(process, "fs")',
      },
      {
        name: "Reflect.get _linkedBinding apply",
        source: 'Reflect.get(process, "_linkedBinding").apply(process, ["fs"])',
      },
      {
        name: "Reflect.get _linkedBinding bind",
        source: 'Reflect.get(process, "_linkedBinding").bind(process)("fs")',
      },
      {
        name: "Reflect.apply on a reflected _linkedBinding",
        source: 'Reflect.apply(Reflect.get(process, "_linkedBinding"), process, ["fs"])',
      },
      {
        name: "Object descriptor binding value",
        source: 'Object.getOwnPropertyDescriptor(process, "binding").value("fs")',
      },
      {
        name: "Reflect descriptor binding value",
        source: 'Reflect.getOwnPropertyDescriptor(process, "binding").value("fs")',
      },
      {
        name: "Object descriptor _linkedBinding value",
        source: 'Object.getOwnPropertyDescriptor(process, "_linkedBinding").value("fs")',
      },
      {
        name: "Reflect descriptor _linkedBinding value",
        source: 'Reflect.getOwnPropertyDescriptor(process, "_linkedBinding").value("fs")',
      },
      {
        name: "Object descriptor computed static binding",
        source: 'Object.getOwnPropertyDescriptor(process, "bi" + "nding").value("fs")',
      },
      {
        name: "Reflect descriptor computed static binding",
        source: 'Reflect.getOwnPropertyDescriptor(process, "bi" + "nding").value("fs")',
      },
      {
        name: "Object descriptor computed static _linkedBinding",
        source: 'Object.getOwnPropertyDescriptor(process, "_link" + "edBinding").value("fs")',
      },
      {
        name: "Reflect descriptor computed static _linkedBinding",
        source: 'Reflect.getOwnPropertyDescriptor(process, "_link" + "edBinding").value("fs")',
      },
      {
        name: "Object descriptor through a simple process _linkedBinding alias",
        source:
          'const p = process; Object.getOwnPropertyDescriptor(p, "_linkedBinding").value("fs")',
      },
      {
        name: "Reflect descriptor through a simple process _linkedBinding alias",
        source:
          'const p = process; Reflect.getOwnPropertyDescriptor(p, "_linkedBinding").value("fs")',
      },
    ];
    for (const member of ["binding", "_linkedBinding"]) {
      for (const descriptor of ["Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor"]) {
        const target = `${descriptor}(process, "${member}")`;
        reflectiveLoaders.push(
          {
            name: `${descriptor} ${member} call`,
            source: `${target}.value.call(process, "fs")`,
          },
          {
            name: `${descriptor} ${member} apply`,
            source: `${target}.value.apply(process, ["fs"])`,
          },
          {
            name: `${descriptor} ${member} bind`,
            source: `${target}.value.bind(process)("fs")`,
          },
          {
            name: `Reflect.apply on ${descriptor} ${member}`,
            source: `Reflect.apply(${target}.value, process, ["fs"])`,
          },
        );
      }
    }
    reflectiveLoaders.push(
      {
        name: "unresolved Reflect.get process key fails closed",
        source: 'Reflect.get(process, key)("fs")',
      },
      {
        name: "unresolved descriptor process key fails closed",
        source: "Object.getOwnPropertyDescriptor(process, key).value('fs')",
      },
      {
        name: "unresolved Reflect descriptor process key fails closed",
        source: "Reflect.getOwnPropertyDescriptor(process, key).value('fs')",
      },
    );
    for (const { name, source } of reflectiveLoaders) {
      expect(detectDangerousBackendCapabilities(source, allOptIns), name).toEqual([
        "dangerous process API usage",
      ]);
    }

    const safeReflectiveReceivers = [
      {
        name: "unrelated object with binding property",
        source: 'const object = { binding() {} }; Reflect.get(object, "binding")("fs")',
      },
      {
        name: "unrelated simple alias with binding property",
        source: 'const p = {}; Reflect.get(p, "binding")("fs")',
      },
      {
        name: "unrelated object descriptor with binding property",
        source: 'const object = { binding() {} }; Object.getOwnPropertyDescriptor(object, "binding").value("fs")',
      },
      {
        name: "unrelated object Reflect descriptor with binding property",
        source: 'const object = { binding() {} }; Reflect.getOwnPropertyDescriptor(object, "binding").value("fs")',
      },
      {
        name: "unrelated simple alias with _linkedBinding property",
        source: 'const p = {}; Reflect.get(p, "_linkedBinding")("fs")',
      },
      {
        name: "unrelated simple alias Object descriptor _linkedBinding",
        source: 'const p = {}; Object.getOwnPropertyDescriptor(p, "_linkedBinding").value("fs")',
      },
      {
        name: "unrelated simple alias Reflect descriptor _linkedBinding",
        source: 'const p = {}; Reflect.getOwnPropertyDescriptor(p, "_linkedBinding").value("fs")',
      },
      {
        name: "lexically shadowed process parameter",
        source: 'function use(process) { Reflect.get(process, "binding")("fs"); }',
      },
      {
        name: "expression arrow process parameter is shadowed",
        source: 'const f = (process) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "commented direct process parameter",
        source:
          'const f = (/* leading */ process /* trailing */) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "comment-separated process arrow header",
        source:
          'const f = (process) /*gap*/ => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "multiline parenthesized expression process parameter is shadowed",
        source: `const f = (process) => (
          Reflect.get(process, "binding")("fs")
        )`,
      },
      {
        name: "destructured process parameter",
        source: 'const f = ({ process }) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "renamed destructured process parameter",
        source: 'const f = ({ x: process }) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "array destructured process parameter",
        source: 'const f = ([process]) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "commented destructured process parameter",
        source:
          'const f = ({ /* leading */ process /* trailing */ }) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "commented multiline process parameter body",
        source: `const f = (process) => /* comment before body */
          Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "block-body destructured process parameter",
        source: 'const f = ({ process }) => { Reflect.get(process, "binding")("fs"); }',
      },
      {
        name: "block-body array process parameter",
        source: 'const f = ([process]) => { Reflect.get(process, "binding")("fs"); }',
      },
      {
        name: "local instanceof continuation",
        source: `const f = (process) =>
          value
          instanceof Reflect.get(process, "binding")`,
      },
      {
        name: "local in continuation",
        source: `const f = (process) =>
          process
          in Reflect.get(process, "binding")`,
      },
      {
        name: "local tagged-template continuation",
        source: `const f = (process) =>
          tag
          \`value \${Reflect.get(process, "binding")("fs")}\``,
      },
      {
        name: "default process parameter shadows global process",
        source: 'const f = (process = {}) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "rest process parameter shadows global process",
        source: 'const f = (...process) => Reflect.get(process, "binding")("fs")',
      },
      {
        name: "continued process parameter arrow body stays local",
        source: `const f = (process) =>
          Reflect.get(process, "binding")("fs") ||
          Reflect.get(process, "binding")("fs")`,
      },
      {
        name: "comment-separated local process receiver stays shadowed",
        source: 'const f = (process) => Reflect.get(/*x*/ process, "binding")("fs")',
      },
      {
        name: "lexically shadowed process descriptor",
        source: 'function use(process) { Object.getOwnPropertyDescriptor(process, "binding").value("fs"); }',
      },
      {
        name: "lexically shadowed process Reflect descriptor",
        source: 'function use(process) { Reflect.getOwnPropertyDescriptor(process, "binding").value("fs"); }',
      },
      {
        name: "local process object",
        source: 'const process = { binding() {} }; Reflect.get(process, "binding")("fs")',
      },
      {
        name: "local process descriptor",
        source: 'const process = { binding() {} }; Object.getOwnPropertyDescriptor(process, "binding").value("fs")',
      },
      {
        name: "local process Reflect descriptor",
        source: 'const process = { binding() {} }; Reflect.getOwnPropertyDescriptor(process, "binding").value("fs")',
      },
      {
        name: "simple alias to unrelated descriptor receiver",
        source: 'const p = {}; Object.getOwnPropertyDescriptor(p, "binding").value("fs")',
      },
      {
        name: "simple alias to unrelated Reflect descriptor receiver",
        source: 'const p = {}; Reflect.getOwnPropertyDescriptor(p, "binding").value("fs")',
      },
    ];
    const continuedArrowBodyCases = [
      [
        "logical AND",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs") &&
          Reflect.get(process, "binding")("fs")`,
      ],
      [
        "nullish coalescing",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs") ??
          Reflect.get(process, "binding")("fs")`,
      ],
      [
        "addition",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs") +
          Reflect.get(process, "binding")("fs")`,
      ],
      [
        "conditional",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs")
            ? Reflect.get(process, "binding")("fs")
            : Reflect.get(process, "binding")("fs")`,
      ],
      [
        "computed member",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs")
          [Reflect.get(process, "binding")("fs")]`,
      ],
      [
        "call continuation",
        `const f = (process) =>
          Reflect.get(process, "binding")("fs")
          (Reflect.get(process, "binding")("fs"))`,
      ],
    ] as const;
    for (const [name, source] of continuedArrowBodyCases) {
      safeReflectiveReceivers.push({
        name: `continued process parameter arrow body (${name})`,
        source,
      });
    }
    for (const { name, source } of safeReflectiveReceivers) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([]);
    }


    const safe = String.raw`
      // process.binding(variable); process._linkedBinding(variable);
      const prose = "process.binding('fs') _linkedBinding";
      return prose;
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("fails closed for indirect module require loaders but allows unrelated receivers", () => {
    const dynamicLoaders = [
      "module.require(variable)",
      'module["require"](variable)',
      "const loader = module.require; loader(variable)",
      "const loader = module.require.bind(module); loader(variable)",
      "const { require: loader } = module; loader(variable)",
      "require.main.require(variable)",
      "require.cache[id].require(variable)",
    ];
    for (const code of dynamicLoaders) {
      expect(detectDangerousBackendCapabilities(code)).toContain("dynamic module access");
    }

    const staticBlockedLoaders = [
      'module.require("node:fs")',
      'module["require"]("node:fs")',
      'require.main.require("node:fs")',
      'require.cache[id].require("node:fs")',
    ];
    for (const code of staticBlockedLoaders) {
      expect(detectDangerousBackendCapabilities(code)).toContain("filesystem module access");
    }

    const safe = String.raw`
      const object = { require(value) { return value; } };
      const scriptNs = { require(value) { return value; } };
      object.require(variable);
      scriptNs.require(variable);
      // module.require(variable); require.main.require(variable);
      const prose = "module['require'](variable) require.cache[id].require(variable)";
      return prose;
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });
  test("classifies import.meta module access and preserves safe metadata", () => {
    const allCapabilities = new Set<SpindleCapability>([
      "dynamic_code_execution",
      "base64_decode",
    ]);
    const blocked: Array<{
      name: string;
      source: string;
      expected: string[];
      capabilities?: ReadonlySet<SpindleCapability>;
    }> = [
      {
        name: "static import.meta.require",
        source: "import.meta.require('node:fs');",
        expected: ["filesystem module access"],
      },
      {
        name: "static import.meta.require subprocess",
        source: "import.meta.require('node:child_process');",
        expected: ["subprocess module access"],
      },
      {
        name: "static import.meta.require SQLite",
        source: "import.meta.require('bun:sqlite');",
        expected: ["direct SQLite module access"],
      },
      {
        name: "static import.meta.require sqlite3",
        source: "import.meta.require('sqlite3');",
        expected: ["direct SQLite module access"],
      },
      {
        name: "static import.meta.require better-sqlite3",
        source: "import.meta.require('better-sqlite3');",
        expected: ["direct SQLite module access"],
      },
      {
        name: "comment-separated multiline constant require",
        source: [
          "import /* gap */ . /* gap */ meta /* gap */ . /* gap */ require /* gap */ (",
          '  "node:" /* gap */ + /* gap */ "fs"',
          ");",
        ].join("\n"),
        expected: ["filesystem module access"],
      },
      {
        name: "computed literal require",
        source: "import.meta['require']('node:fs');",
        expected: ["filesystem module access"],
      },
      {
        name: "optional require call",
        source: "import.meta.require?.('node:fs');",
        expected: ["filesystem module access"],
      },
      {
        name: "dynamic require argument",
        source: "const specifier = getSpecifier(); import.meta.require(specifier);",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "bare require method reference",
        source: "const loader = import.meta.require;",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "import.meta alias pass-through",
        source: "const meta = import.meta; meta.require(variable);",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "dynamic computed metadata property",
        source: "const key = getKey(); import.meta[key]('node:fs');",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "unknown metadata property",
        source: "void import.meta.unknownLoader;",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "unknown inherited constructor metadata property",
        source: "void import.meta.constructor;",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "unknown inherited toString metadata property",
        source: "void import.meta.toString;",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
      {
        name: "computed prototype metadata property",
        source: "void import.meta['__proto__'];",
        expected: ["dynamic module access"],
        capabilities: allCapabilities,
      },
    ];

    for (const { name, source, expected, capabilities } of blocked) {
      expect(detectDangerousBackendCapabilities(source, capabilities), name).toEqual(expected);
    }

    const allowedProperties = ["url", "dir", "file", "path", "main", "resolve"];
    for (const property of allowedProperties) {
      expect(
        detectDangerousBackendCapabilities(`void import.meta.${property};`),
        `known metadata property: ${property}`,
      ).toEqual([]);
    }
  });



  test("does not flag methods named require/import (member calls + definitions)", () => {
    // Extensions ship scripting APIs whose methods are literally named
    // `require`/`import` (e.g. RisuAI-compat layers). These are NOT the global
    // require / dynamic-import operator and must not trip the fail-closed gate,
    // even with a fully dynamic argument. Regression guard for the LumiRealm
    // false positive (its bundle is all `scriptNs.require(n)` style calls).
    const safe = [
      "const mod = await scriptNs.require(n);",
      "const lib = await ctx.scriptNS.require(entry.name);",
      "const o = { async require(name) { return name; } };",
      "obj?.require(dynamicName);",
      "function require(name) { return name; }",
      'await import("./data.json", { with: { type: "json" } });', // import attributes
    ];
    for (const code of safe) {
      expect(detectDangerousBackendCapabilities(code)).toEqual([]);
    }

    // …but a constant dangerous specifier on a member receiver is still caught
    // by the literal module checks (independent of the dynamic-call heuristic).
    expect(detectDangerousBackendCapabilities('globalThis.require("node:fs");')).toContain(
      "filesystem module access",
    );
  });
  test("blocks serialized module-loading escapes across bounded and global forms", () => {
    const longDataUrl = `data:text/javascript,${"x".repeat(301)}`;
    const longCommentSeparatedImport = `import${"/* gap */".repeat(40)}("zod");`;
    const serializedBlocked: Array<{ name: string; source: string }> = [
      {
        name: "data URL import longer than 300 characters",
        source: `import ${JSON.stringify(longDataUrl)};`,
      },
      {
        name: "comment-separated import longer than 256 characters",
        source: longCommentSeparatedImport,
      },
      { name: "optional require call", source: 'require?.("zod");' },
      { name: "require call method", source: 'require.call(null, "zod");' },
      { name: "Reflect require call", source: 'Reflect.apply(require, null, ["zod"]);' },
      { name: "aliased require call", source: 'const load = require; load("zod");' },
      { name: "direct globalThis require", source: 'globalThis.require("zod");' },
      { name: "direct self require", source: 'self.require("zod");' },
      { name: "direct global require", source: 'global.require("zod");' },
      { name: "computed globalThis require", source: 'globalThis["require"]("zod");' },
      { name: "computed self require", source: 'self["require"]("zod");' },
      { name: "computed global require", source: 'global["require"]("zod");' },
      { name: "concatenated globalThis require", source: 'globalThis["re" + "quire"]("zod");' },
      { name: "concatenated self require", source: 'self["re" + "quire"]("zod");' },
      { name: "concatenated global require", source: 'global["re" + "quire"]("zod");' },
      {
        name: "dynamic globalThis require key",
        source: 'const key = getKey(); globalThis[key]("zod");',
      },
      { name: "dynamic self require key", source: 'const key = getKey(); self[key]("zod");' },
      { name: "dynamic global require key", source: 'const key = getKey(); global[key]("zod");' },
      {
        name: "ternary globalThis require key",
        source: 'globalThis[enabled ? "require" : "fetch"]("zod");',
      },
      { name: "ternary self require key", source: 'self[enabled ? "require" : "fetch"]("zod");' },
      { name: "ternary global require key", source: 'global[enabled ? "require" : "fetch"]("zod");' },
      {
        name: "computed destructuring require alias",
        source: 'const { ["re" + "quire"]: load } = globalThis; load("zod");',
      },
      {
        name: "computed key longer than 300 characters",
        source: `globalThis[${" ".repeat(301)}"require"]("zod");`,
      },
      {
        name: "multiline nested String.fromCharCode require",
        source: [
          'const text = `first line',
          'second line`;',
          "globalThis[",
          "  String.fromCharCode(",
          "    114, 101, 113, 117, 105, 114, 101",
          '  )]("zod");',
        ].join("\n"),
      },
      {
        name: "multiline globalThis require node fs",
        source: 'globalThis\n  .\n  require\n  ("node:fs");',
      },
    ];

    for (const { name, source } of serializedBlocked) {
      expect(detectSerializedHandlerModuleAccess(source), name).toEqual(["module loading"]);
    }
  });

  test("scans a near-limit handler with thousands of ignored spans within the normal timeout", () => {
    const handler = manyIgnoredSpanHandler();
    expect(detectSerializedHandlerModuleAccess(handler)).toEqual(["module loading"]);
  }, { timeout: 5_000 });

  test("keeps install scanner precision across multiline and unrelated require syntax", () => {
    const blocked: Array<{ name: string; source: string; reason: string }> = [
      {
        name: "multiline installed node fs import",
        source: 'import { readFileSync } from\n  "node:fs";',
        reason: "filesystem module access",
      },
      {
        name: "unresolved multiline bare require",
        source: "const specifier = getSpecifier();\nrequire(\n  specifier\n);",
        reason: "dynamic module access",
      },
      {
        name: "multiline nested String.fromCharCode fs import",
        source: [
          "require(",
          "  String.fromCharCode(",
          "    110, 111, 100, 101, 58, 102, 115",
          "  )",
          ");",
        ].join("\n"),
        reason: "filesystem module access",
      },
    ];

    for (const { name, source, reason } of blocked) {
      expect(detectDangerousBackendCapabilities(source), name).toContain(reason);
    }

    const safe: Array<{ name: string; source: string }> = [
      {
        name: "multiline zod import",
        source: 'import {\n  z\n} from\n  "zod";',
      },
      {
        name: "unrelated object require and optional method",
        source: "obj.require(dynamicName);\nobj?.optional(dynamicName);",
      },
      {
        name: "require method declaration",
        source: "const object = { require(value) { return value; } };",
      },
    ];

    for (const { name, source } of safe) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([]);
    }
  });

  test("allows provably-constant non-dangerous dynamic imports", () => {
    // Legitimate extensions load their own bundled modules with literal or
    // interpolation-free specifiers — these must not be flagged.
    const samples = [
      'await import("./helpers.js"); export const a = 1;',
      'await import(`./locales/en.js`);',
      'const m = await import("zod"); void m;',
      'const u = require("./utils.js"); void u;',
    ];
    for (const code of samples) {
      expect(detectDangerousBackendCapabilities(code)).toEqual([]);
    }
  });

  test("does not flag empty-body Function probes (Zod / Cloudflare feature-detect)", () => {
    const samples = [
      `(() => { try { return new Function(""), true } catch { return false } })();`,
      `try { Function(''); } catch (_) { /* no-op */ }`,
      `if (typeof Function === 'function') { new Function() }`,
    ];
    for (const code of samples) {
      expect(detectDangerousBackendCapabilities(code)).toEqual([]);
    }
  });

  test("does not flag forbidden tokens that appear inside regex literals", () => {
    const samples = [
      // lumiscript's host-dispatcher security check — itself bans Function().
      `if (/(?<!\\.)\\b(?:new\\s+)?Function\\s*\\(/.test(stripped)) throw new Error("nope");`,
      // Regex literals after various tokens are recognized as regex, not division.
      `const re = /eval\\s*\\(/g; void re;`,
      `function checkRegex(x) { return /Function\\s*\\(/.test(x); }`,
      `arr.filter((s) => /eval\\(/.test(s));`,
    ];
    for (const code of samples) {
      expect(detectDangerousBackendCapabilities(code)).toEqual([]);
    }
  });

  test("still flags real dynamic-execution calls outside regex literals", () => {
    const samples: Array<[string, string]> = [
      [`eval(payload)`, "dynamic code execution"],
      [`new Function("return process")()`, "dynamic code execution"],
      [`Function('return globalThis.fetch')()`, "dynamic code execution"],
    ];
    for (const [code, label] of samples) {
      expect(detectDangerousBackendCapabilities(code), code).toEqual([label]);
    }
  });
  test("flags function constructor indirection and honors its declared capability", () => {
    const executableSamples = [
      "(function () {}).constructor('return 1')",
      "(async function () {}).constructor('return 1')",
      "(function () {}).constructor.call(null, 'return 1')",
      "(async function () {}).constructor.apply(null, ['return 1'])",
      "(function () {})?.constructor?.('return 1')",
      "Reflect.construct((function () {}).constructor, ['return 1'])",
      "Reflect.apply((async function () {}).constructor, null, ['return 1'])",
      "(function () {}).constructor.bind(null, 'return 1')()",
    ];
    for (const code of executableSamples) {
      expect(detectDangerousBackendCapabilities(code)).toContain("dynamic code execution");
      expect(
        detectDangerousBackendCapabilities(
          code,
          new Set<SpindleCapability>(["dynamic_code_execution"]),
        ),
      ).not.toContain("dynamic code execution");
    }

    const ignoredReflectForms = [
      'Reflect.construct(factory("widget.constructor"), args)',
      "Reflect.construct(/* x.constructor */ Ctor, args)",
    ];
    for (const code of ignoredReflectForms) {
      expect(detectDangerousBackendCapabilities(code)).toEqual([]);
    }
    const mixedIgnoredAndExecutable =
      `const docs = "(function () {}).constructor("fake")"; return (function () {}).constructor("real");`;
    expect(detectDangerousBackendCapabilities(mixedIgnoredAndExecutable)).toContain(
      "dynamic code execution",
    );

    const prose = `
      const comment = "((function () {}).constructor('return 1'))";
      /* (async function () {}).constructor.call(null, 'return 1') */
      // Object.constructor('return 1')
      void comment;
    `;
    expect(detectDangerousBackendCapabilities(prose)).toEqual([]);
  });

  test("respects manifest-declared capabilities", () => {
    const code = `
      const compiled = new Function("a", "return a + 1");
      const bytes    = Buffer.from(payload, "base64");
    `;

    // Without declarations, both labels surface.
    expect(detectDangerousBackendCapabilities(code).sort()).toEqual([
      "base64 decoding",
      "dynamic code execution",
    ]);

    // Declared capabilities filter the matching labels out.
    expect(
      detectDangerousBackendCapabilities(code, new Set<SpindleCapability>(["dynamic_code_execution"])),
    ).toEqual(["base64 decoding"]);
    expect(
      detectDangerousBackendCapabilities(
        code,
        new Set<SpindleCapability>(["dynamic_code_execution", "base64_decode"]),
      ),
    ).toEqual([]);

    // Declarations do not unlock hard-blocked capabilities (no opt-in path).
    const unsafe = `import { readFileSync } from "node:fs"; void readFileSync;`;
    expect(
      detectDangerousBackendCapabilities(
        unsafe,
        new Set<SpindleCapability>(["dynamic_code_execution", "base64_decode"]),
      ),
    ).toContain("filesystem module access");
  });

  test("declaredCapabilitiesFromManifest accepts only valid entries", () => {
    const base = {
      version: "0.0.0",
      name: "x",
      identifier: "x",
      author: "x",
      github: "x",
      homepage: "x",
      permissions: [],
    } as unknown as SpindleManifest;

    expect(declaredCapabilitiesFromManifest(base)).toEqual(new Set());

    const valid = { ...base, requested_capabilities: ["dynamic_code_execution"] } as SpindleManifest;
    expect(declaredCapabilitiesFromManifest(valid)).toEqual(
      new Set<SpindleCapability>(["dynamic_code_execution"]),
    );

    const mixed = {
      ...base,
      requested_capabilities: ["dynamic_code_execution", "bogus_value", "base64_decode"] as SpindleCapability[],
    } as SpindleManifest;
    expect(declaredCapabilitiesFromManifest(mixed)).toEqual(
      new Set<SpindleCapability>(["dynamic_code_execution", "base64_decode"]),
    );
  });

  test("ignores unsafe examples inside documentation strings and comments", () => {
    const code = String.raw`
      const markdown = \`
      # Bad examples

      \`\`\`js
      import fs from "fs";
      await import("fs");
      Bun["file"]("/etc/passwd");
      process.env.SECRET;
      eval(Buffer.from("Zm9v", "base64").toString());
      \`\`\`
      \`;

      const html = '<pre><code>Bun.spawn(["whoami"]); process["env"];</code></pre>';
      const prose = "Docs mention http://example.test/fs and the fs module; neither is executable.";

      // Bad practice: Bun.file("/etc/passwd")
      /* Bad practice: require("node:child_process") */

      spindle.frontend.postMessage({ markdown, html });
    `;

    expect(detectDangerousBackendCapabilities(code)).toEqual([]);
  });

  test("still flags executable code inside template expressions", () => {
    const code = 'const message = `value: ${process.env.SECRET}`; void message;';

    expect(detectDangerousBackendCapabilities(code)).toContain("dangerous process API usage");
  });
  test("classifies Module constructor loader acquisition and unresolved keys conservatively", () => {
    const cases: Array<{ name: string; source: string; label: string }> = [
      {
        name: "direct _load",
        source: 'module.constructor._load("node:fs");',
        label: "module loading",
      },
      {
        name: "direct createRequire",
        source: 'module.constructor.createRequire("/tmp/extension.js");',
        label: "module loading",
      },
      {
        name: "static computed constructor",
        source: 'module["constructor"]["_load"]("node:fs");',
        label: "module loading",
      },
      {
        name: "simple module alias",
        source: 'const mod = module; mod.constructor.createRequire("/tmp/extension.js");',
        label: "module loading",
      },
      {
        name: "global module alias",
        source: 'const mod = globalThis.module; mod.constructor._load("node:fs");',
        label: "module loading",
      },
      {
        name: "Reflect.get constructor",
        source: 'Reflect.get(module, "constructor")._load("node:fs");',
        label: "module loading",
      },
      {
        name: "unresolved computed constructor key",
        source: 'const key = getKey(); module[key]._load("node:fs");',
        label: "dynamic module access",
      },
    ];

    for (const { name, source, label } of cases) {
      expect(detectDangerousBackendCapabilities(source), name).toContain(label);
    }
    expect(
      detectDangerousBackendCapabilities(
        'const unrelated = { constructor: { _load(value) { return value; } } }; unrelated.constructor._load("node:fs");',
      ),
    ).toEqual([]);
  });
  test("flags Reflect/Object aliases through computed call/apply/bind dispatch", () => {
    const blocked: Array<{ name: string; source: string; label: string }> = [
      {
        name: "computed Reflect alias call",
        source: 'const R = Reflect; R["get"]["call"](null, globalThis, "fetch");',
        label: "direct network API usage",
      },
      {
        name: "computed Object alias apply",
        source:
          'const O = Object; O["getOwnPropertyDescriptor"]["apply"](null, [global, "Worker"]);',
        label: "worker runtime API usage",
      },
      {
        name: "computed Reflect alias bind",
        source:
          'const R = Reflect; R["get"]["bind"](null, self, "WebSocket")();',
        label: "direct network API usage",
      },
      {
        name: "computed Object alias call",
        source:
          'const O = Object; O["getOwnPropertyDescriptor"]["call"](null, globalThis, "BroadcastChannel");',
        label: "worker runtime API usage",
      },
    ];

    for (const { name, source, label } of blocked) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([label]);
    }

    const safe = `
      const local = {};
      const R = Reflect;
      const O = Object;
      R["get"].call(null, local, "fetch");
      O["getOwnPropertyDescriptor"].apply(null, [local, "Worker"]);
      R["get"](globalThis, "setTimeout");
      O["getOwnPropertyDescriptor"](globalThis, "toString");
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("classifies parenthesized global receivers without labeling safe locals", () => {
    const blocked: Array<{ name: string; source: string; label: string }> = [
      {
        name: "parenthesized globalThis fetch",
        source: "(globalThis).fetch(request);",
        label: "direct network API usage",
      },
      {
        name: "parenthesized self Worker",
        source: '(self)["Worker"]("worker.js");',
        label: "worker runtime API usage",
      },
      {
        name: "parenthesized global WebSocket",
        source: "(global).WebSocket(url);",
        label: "direct network API usage",
      },
    ];

    for (const { name, source, label } of blocked) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual([label]);
    }

    const safe = `
      const local = {};
      const globalThis = local;
      (local).fetch(request);
      (globalThis)["Worker"]("worker.js");
      (local).WebSocket(url);
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("fails closed for unknown serialized computed aliases while ignoring local objects", () => {
    const blocked = [
      'const root = globalThis; const key = getKey(); root[key]("zod");',
      'const root = self; const key = getKey(); root[key]("zod");',
      'const { [getKey()]: load } = globalThis; load("zod");',
    ];
    for (const source of blocked) {
      expect(detectSerializedHandlerModuleAccess(source), source).toEqual(["module loading"]);
    }

    const safe = `
      const local = {};
      const alias = local;
      const key = getKey();
      alias[key]("zod");
      local["fetch"]("zod");
      globalThis["fetch"]("zod");
    `;
    expect(detectSerializedHandlerModuleAccess(safe)).toEqual([]);
  });

  test("flags aliases of every dynamic function constructor", () => {
    const blocked = [
      'const F = Function; F("return 1");',
      'const AF = AsyncFunction; AF("return 1");',
      'const GF = GeneratorFunction; GF("yield 1");',
      'const AGF = AsyncGeneratorFunction; AGF("yield 1");',
    ];
    for (const source of blocked) {
      expect(detectDangerousBackendCapabilities(source), source).toEqual([
        "dynamic code execution",
      ]);
    }

    const safe = `
      const local = {};
      const F = local["Function"];
      const AF = local["AsyncFunction"];
      F("return 1");
      AF("return 1");
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });

  test("classifies computed module.createRequire access with exact loader labels", () => {
    const blocked: Array<{ name: string; source: string; expected: string[] }> = [
      {
        name: "computed module createRequire native addon",
        source: 'module["createRequire"](import.meta.url)("./native.node");',
        expected: ["module loading", "dynamic module access"],
      },
      {
        name: "fully computed global module createRequire filesystem",
        source: 'globalThis["module"]["createRequire"](import.meta.url)("node:fs");',
        expected: ["module loading", "filesystem module access"],
      },
      {
        name: "computed module alias createRequire",
        source:
          'const mod = module; mod["createRequire"](import.meta.url)("node:child_process");',
        expected: ["module loading", "subprocess module access"],
      },
    ];

    for (const { name, source, expected } of blocked) {
      expect(detectDangerousBackendCapabilities(source), name).toEqual(expected);
    }

    const safe = `
      const local = {};
      local["createRequire"]?.(import.meta.url);
      module["require"]("./local.js");
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });
  test("reconciles bounded provenance for loader and runtime alias classes", () => {
    const positives: Array<{ name: string; source: string; label: string }> = [
      {
        name: "direct module require",
        source: 'module.require("node:fs");',
        label: "filesystem module access",
      },
      {
        name: "computed module require",
        source: 'module["require"]("node:child_process");',
        label: "subprocess module access",
      },
      {
        name: "transitive module require alias",
        source: 'const mod = module; const req = mod.require; req("node:fs");',
        label: "filesystem module access",
      },
      {
        name: "Reflect module loader",
        source: 'Reflect.get(module, "require")("node:fs");',
        label: "filesystem module access",
      },
      {
        name: "Object module descriptor",
        source:
          'Object.getOwnPropertyDescriptor(module, "require").value("node:fs");',
        label: "filesystem module access",
      },
      {
        name: "global require member",
        source: 'globalThis.require("node:fs");',
        label: "filesystem module access",
      },
      {
        name: "computed global import member",
        source: 'globalThis["import"]("node:child_process");',
        label: "subprocess module access",
      },
      {
        name: "transitive Bun alias",
        source: 'const b = Bun; const b2 = b; b2.spawn(["id"]);',
        label: "dangerous Bun system API usage",
      },
      {
        name: "transitive process alias",
        source: 'const p = process; const p2 = p; p2.env.SECRET;',
        label: "dangerous process API usage",
      },
      {
        name: "transitive global alias",
        source: 'const g = globalThis; const g2 = g; g2.fetch(url);',
        label: "direct network API usage",
      },
      {
        name: "default RHS global alias",
        source: 'function use(root = globalThis) { root.fetch(url); }',
        label: "direct network API usage",
      },
      {
        name: "control header leaves process global",
        source: 'if (process) { Reflect.get(process, "env"); }',
        label: "dangerous process API usage",
      },
    ];
    for (const { name, source, label } of positives) {
      expect(detectDangerousBackendCapabilities(source), name).toContain(label);
    }

    const safeNegatives = [
      'const module = {}; module.require("node:fs");',
      'const Bun = {}; Bun.spawn(["id"]);',
      'function use(process) { process.env.SECRET; }',
      'const Reflect = {}; Reflect.get(globalThis, "fetch");',
      'const Object = {}; Object.getOwnPropertyDescriptor(globalThis, "Worker");',
      'function use(Function, globalThis) { Function("return 1"); globalThis.fetch(url); }',
      'const local = {}; const key = getKey(); local[key]("node:fs");',
      'if (process) { const process = {}; process.env.SECRET; }',
    ];
    for (const source of safeNegatives) {
      expect(detectDangerousBackendCapabilities(source), source).toEqual([]);
    }
  });

  test("fails closed for unresolved loader keys and serialized computed import", () => {
    const unresolved = [
      'const mod = module; const key = getKey(); mod[key]("node:fs");',
      'const root = globalThis; const key = getKey(); root[key]("node:fs");',
      'Reflect.get(module, key)("node:fs");',
      'Object.getOwnPropertyDescriptor(globalThis, key).value("node:fs");',
    ];
    for (const source of unresolved) {
      expect(detectDangerousBackendCapabilities(source), source).toContain(
        "dynamic module access",
      );
    }

    const serializedBlocked = [
      'const root = globalThis; const key = getKey(); root[key]("zod");',
      'const root = self; root["im" + "port"]("zod");',
      'const root = global; const load = root.require; load("zod");',
    ];
    for (const source of serializedBlocked) {
      expect(detectSerializedHandlerModuleAccess(source), source).toContain(
        "module loading",
      );
    }

    const serializedSafe = [
      'const globalThis = {}; const key = getKey(); globalThis[key]("zod");',
      'const local = {}; local["import"]("zod");',
      'function use(require) { require("zod"); }',
    ];
    for (const source of serializedSafe) {
      expect(detectSerializedHandlerModuleAccess(source), source).toEqual([]);
    }
  });
  test("decodes escaped module specifiers and preserves object-literal division", () => {
    const blocked: Array<[string, string]> = [
      ['require("node:\\x66s")', "filesystem module access"],
      ['require("node:\\u0066s")', "filesystem module access"],
      ['require("node:\\u{66}s")', "filesystem module access"],
      ["await import(`node:\\x66s`)", "filesystem module access"],
      ["await import(`node:\\u0066s`)", "filesystem module access"],
      ["await import(`node:\\u{66}s`)", "filesystem module access"],
      ['require("node:\\x63hild_process")', "subprocess module access"],
    ];
    for (const [source, label] of blocked) {
      expect(detectDangerousBackendCapabilities(source), source).toContain(label);
    }

    expect(
      detectDangerousBackendCapabilities("const object = {} / globalThis.fetch(url) / 1;"),
    ).toContain("direct network API usage");
    expect(
      detectDangerousBackendCapabilities(
        "const object = { require(value) { return value; } } / require(\"node:fs\") / 1;",
      ),
    ).toContain("filesystem module access");

    const safeMethods = [
      "const methods = { require(value) { return value; }, import(value) { return value; } }; methods.require(name);",
      "const methods = { fetch(value) { return value; } }; methods.fetch(url);",
    ];
    for (const source of safeMethods) {
      expect(detectDangerousBackendCapabilities(source), source).toEqual([]);
    }
  });

  test("tracks require.main and require.cache loader aliases", () => {
    const staticAliases = [
      'const load = require.main.require; load("node:fs");',
      'const load = require.cache[id].require; load("node:fs");',
    ];
    for (const source of staticAliases) {
      expect(detectDangerousBackendCapabilities(source), source).toContain(
        "filesystem module access",
      );
    }

    const dynamicAliases = [
      "const load = require.main.require; load(specifier);",
      "const load = require.cache[id].require; load(specifier);",
    ];
    for (const source of dynamicAliases) {
      expect(detectDangerousBackendCapabilities(source), source).toContain(
        "dynamic module access",
      );
    }
  });

  test("blocks overflowed provenance while preserving large nested safe regions", () => {
    const depth = 4_100;
    const blocked = `${"{".repeat(depth)}globalThis.fetch(url)${"}".repeat(depth)}`;
    expect(detectDangerousBackendCapabilities(blocked)).toContain(
      "dynamic global API access",
    );

    const safe = `${"{".repeat(depth)}const local = {}; local.fetch(url);${"}".repeat(depth)}`;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);

    const arrows = Array.from(
      { length: 2_048 },
      (_, index) => `(value${index}) => value${index}`,
    ).join(",\n");
    expect(
      detectDangerousBackendCapabilities(
        `const handlers = [${arrows}]; const g = globalThis; g["f" + "etch"](url);`,
      ),
    ).toEqual(["direct network API usage"]);
  });

});
describe("backend module and path boundaries", () => {
  test("rejects symlink escapes and recursively validates local helpers", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "spindle-manager-path-"));
    const previousDataDir = env.dataDir;
    env.dataDir = root;
    const identifier = "manager_path_test";
    const repo = join(root, "extensions", identifier, "repo");
    const dist = join(repo, "dist");
    const storage = join(root, "extensions", identifier, "storage");
    mkdirSync(dist, { recursive: true });
    mkdirSync(storage, { recursive: true });

    try {
      writeFileSync(join(dist, "backend.js"), 'import "./helper";');
      writeFileSync(join(dist, "helper.js"), "export const safe = true;");
      const canonical = await validateBackendModuleGraph(identifier, "dist/backend.js");
      expect(canonical.endsWith("/dist/backend.js")).toBe(true);

      writeFileSync(join(dist, "helper.js"), "process.env.SECRET;");
      await expect(
        validateBackendModuleGraph(identifier, "dist/backend.js"),
      ).rejects.toThrow("dangerous process API usage");

      writeFileSync(join(dist, "helper.js"), "export const safe = true;");
      writeFileSync(join(dist, "backend.js"), 'import "./missing";');
      await expect(
        validateBackendModuleGraph(identifier, "dist/backend.js"),
      ).rejects.toThrow("Unresolved local backend module");

      const outsideEntry = join(root, "outside-entry.js");
      writeFileSync(outsideEntry, "export const outside = true;");
      rmSync(join(dist, "backend.js"));
      symlinkSync(outsideEntry, join(dist, "backend.js"));
      await expect(
        validateBackendModuleGraph(identifier, join(dist, "backend.js")),
      ).rejects.toThrow(/Symlink escapes|Path traversal detected/);

      writeFileSync(join(repo, "seed.txt"), "seed");
      const outsideSeed = join(root, "outside-seed.txt");
      writeFileSync(outsideSeed, "outside");
      rmSync(join(dist, "backend.js"));
      writeFileSync(join(dist, "backend.js"), "export const safe = true;");
      symlinkSync(outsideSeed, join(repo, "seed-link.txt"));
      expect(() =>
        applyStorageSeeds(
          identifier,
          {
            storage_seed_files: [{ from: "seed-link.txt", to: "seed.txt" }],
          } as unknown as SpindleManifest,
        ),
      ).toThrow("Symlink escapes");

      const outsideStorage = join(root, "outside-storage");
      mkdirSync(outsideStorage);
      rmSync(join(repo, "seed-link.txt"));
      symlinkSync(outsideStorage, join(storage, "escape"));
      expect(() =>
        applyStorageSeeds(
          identifier,
          {
            storage_seed_files: [{ from: "seed.txt", to: "escape/copied.txt" }],
          } as unknown as SpindleManifest,
        ),
      ).toThrow("Symlink escapes");

      rmSync(join(storage, "escape"));
      applyStorageSeeds(
        identifier,
        {
          storage_seed_files: [{ from: "seed.txt", to: "new/copied.txt" }],
        } as unknown as SpindleManifest,
      );
      expect(readFileSync(join(storage, "new/copied.txt"), "utf8")).toBe("seed");
    } finally {
      env.dataDir = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects external package imports from entry and nested local modules", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "spindle-manager-package-"));
    const previousDataDir = env.dataDir;
    env.dataDir = root;
    const identifier = "manager_package_test";
    const repo = join(root, "extensions", identifier, "repo");
    const dist = join(repo, "dist");
    mkdirSync(dist, { recursive: true });

    try {
      writeFileSync(join(dist, "backend.js"), 'import "package-name";');
      await expect(
        validateBackendModuleGraph(identifier, "dist/backend.js"),
      ).rejects.toThrow(/External backend module.*package-name.*bundled/);

      writeFileSync(join(dist, "backend.js"), 'import "./helper";');
      writeFileSync(join(dist, "helper.js"), 'require("package-name");');
      await expect(
        validateBackendModuleGraph(identifier, "dist/backend.js"),
      ).rejects.toThrow(/External backend module.*package-name.*bundled/);
    } finally {
      env.dataDir = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("manifest path boundaries", () => {
  test("rejects installed manifest symlink escapes while preserving normal reads", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "spindle-manager-manifest-"));
    const previousDataDir = env.dataDir;
    env.dataDir = root;
    const identifier = "manager_manifest_test";
    const repo = join(root, "extensions", identifier, "repo");
    const outsideManifest = join(root, "outside-spindle.json");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        identifier,
        version: "1.0.0",
        name: "Outside manifest",
        author: "Test author",
        github: "https://github.com/example/outside",
        homepage: "https://example.com/outside",
      }),
    );

    try {
      symlinkSync(outsideManifest, join(repo, "spindle.json"));
      await expect(getManifest(identifier)).rejects.toThrow("Symlink escapes");

      rmSync(join(repo, "spindle.json"));
      writeFileSync(
        join(repo, "spindlefile"),
        JSON.stringify({
          identifier,
          version: "1.0.1",
          name: "Installed manifest",
          author: "Test author",
          github: "https://github.com/example/installed",
          homepage: "https://example.com/installed",
        }),
      );
      await expect(getManifest(identifier)).resolves.toMatchObject({
        identifier,
        version: "1.0.1",
        name: "Installed manifest",
      });
    } finally {
      env.dataDir = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects import-local manifest symlink escapes before reading", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "spindle-manager-import-"));
    const previousDataDir = env.dataDir;
    env.dataDir = root;
    const candidateRoot = join(root, "extensions", "local_candidate");
    const repo = join(candidateRoot, "repo");
    const outsideManifest = join(root, "outside-local-spindle.json");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        identifier: "local_candidate",
        version: "1.0.0",
        name: "Outside local manifest",
        author: "Test author",
        github: "https://github.com/example/local",
        homepage: "https://example.com/local",
      }),
    );

    try {
      symlinkSync(outsideManifest, join(repo, "spindle.json"));
      const result = await importLocalExtensions();
      expect(result.imported).toEqual([]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: candidateRoot,
            reason: expect.stringContaining("Symlink escapes"),
          }),
        ]),
      );
    } finally {
      env.dataDir = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("imports an ordinary root-layout local manifest and normalizes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "spindle-manager-import-normal-"));
    const previousDataDir = env.dataDir;
    env.dataDir = root;
    const identifier = "local_manifest_test";
    const candidateRoot = join(root, "extensions", identifier);
    mkdirSync(candidateRoot, { recursive: true });
    writeFileSync(
      join(candidateRoot, "spindlefile.json"),
      JSON.stringify({
        identifier,
        version: "1.0.0",
        name: "Local manifest",
        author: "Test author",
        github: "https://github.com/example/local",
        homepage: "https://example.com/local",
      }),
    );

    closeDatabase();
    const db = initDatabase(":memory:");
    try {
      await runMigrations(db);
      const result = await importLocalExtensions();
      expect(result.skipped).toEqual([]);
      expect(result.imported).toHaveLength(1);
      expect(result.imported[0]?.identifier).toBe(identifier);
      expect(readFileSync(join(candidateRoot, "repo", "spindlefile.json"), "utf8")).toContain(
        '"identifier":"local_manifest_test"',
      );
    } finally {
      closeDatabase();
      env.dataDir = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PRIVILEGED_PERMISSIONS", () => {
  test("requires explicit approval for app manipulation", () => {
    expect(PRIVILEGED_PERMISSIONS.has("app_manipulation")).toBe(true);
  });
});

describe("bunInstallCmd", () => {
  test("disables dependency lifecycle scripts for normal installs", () => {
    withEnv(
      {
        LUMIVERSE_IS_TERMUX: undefined,
        LUMIVERSE_IS_PROOT: undefined,
      },
      () => {
        expect(bunInstallCmd()).toEqual(["bun", "install", "--ignore-scripts"]);
      }
    );
  });

  test("disables dependency lifecycle scripts for proot installs", () => {
    withEnv(
      {
        LUMIVERSE_IS_TERMUX: "true",
        LUMIVERSE_IS_PROOT: "true",
      },
      () => {
        expect(bunInstallCmd()).toEqual(["bun", "install", "--ignore-scripts", "--backend=copyfile"]);
      }
    );
  });

  test("disables dependency lifecycle scripts for native Termux installs", () => {
    withEnv(
      {
        LUMIVERSE_IS_TERMUX: "true",
        LUMIVERSE_IS_PROOT: undefined,
        LUMIVERSE_BUN_METHOD: "direct",
        LUMIVERSE_BUN_PATH: "/usr/bin/bun",
      },
      () => {
        expect(bunInstallCmd()).toEqual([
          "proot",
          "--link2symlink",
          "-0",
          "/usr/bin/bun",
          "install",
          "--ignore-scripts",
          "--backend=copyfile",
        ]);
      }
    );
  });

  test("keeps grun as the linker wrapper for native Termux installs", () => {
    withEnv(
      {
        LUMIVERSE_IS_TERMUX: "true",
        LUMIVERSE_IS_PROOT: undefined,
        LUMIVERSE_BUN_METHOD: "grun",
        LUMIVERSE_BUN_PATH: "/usr/bin/bun",
      },
      () => {
        expect(bunInstallCmd()).toEqual([
          "proot",
          "--link2symlink",
          "-0",
          "grun",
          "/usr/bin/bun",
          "install",
          "--ignore-scripts",
          "--backend=copyfile",
        ]);
      }
    );
  });

  test("falls back to the explicit glibc loader when proot is the only working method", () => {
    withEnv(
      {
        LUMIVERSE_IS_TERMUX: "true",
        LUMIVERSE_IS_PROOT: undefined,
        LUMIVERSE_BUN_METHOD: "proot",
        LUMIVERSE_BUN_PATH: "/usr/bin/bun",
        PREFIX: "/data/data/com.termux/files/usr",
      },
      () => {
        expect(bunInstallCmd()).toEqual([
          "proot",
          "--link2symlink",
          "-0",
          "/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1",
          "--library-path",
          "/data/data/com.termux/files/usr/glibc/lib",
          "/usr/bin/bun",
          "install",
          "--ignore-scripts",
          "--backend=copyfile",
        ]);
      }
    );
  });
});

describe("shouldUseWindowsSpindleBunSyncFallback", () => {
  test("defaults to the sync fallback on Windows", () => {
    expect(shouldUseWindowsSpindleBunSyncFallback("win32", {})).toBe(true);
  });

  test("allows an explicit Windows override", () => {
    expect(
      shouldUseWindowsSpindleBunSyncFallback("win32", {
        LUMIVERSE_FORCE_SPINDLE_ASYNC_BUN: "1",
      }),
    ).toBe(false);
  });

  test("keeps the async path on non-Windows platforms", () => {
    expect(shouldUseWindowsSpindleBunSyncFallback("darwin", {})).toBe(false);
    expect(shouldUseWindowsSpindleBunSyncFallback("linux", {})).toBe(false);
  });
});

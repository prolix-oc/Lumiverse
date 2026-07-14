import { describe, expect, test } from "bun:test";

import {
  bunInstallCmd,
  declaredCapabilitiesFromManifest,
  detectDangerousBackendCapabilities,
  detectSerializedHandlerModuleAccess,
  PRIVILEGED_PERMISSIONS,
  shouldUseWindowsSpindleBunSyncFallback,
} from "./manager.service";
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
      expect(detectDangerousBackendCapabilities(code, allOptIns)).toContain(
        "dangerous process API usage",
      );
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

import { describe, expect, test } from "bun:test";

import {
  BLOCKED_BUN_API_LABELS,
  BLOCKED_GLOBAL_API_LABELS,
  BLOCKED_MODULE_SPECIFIER_LABELS,
  BLOCKED_PROCESS_API_NAMES,
  buildSafeEnvironment,
  isSensitiveEnvironmentKey,
} from "./dangerous-runtime-policy";
import { detectDangerousBackendCapabilities, detectSerializedHandlerModuleAccess } from "./manager.service";
import type { SpindleCapability } from "lumiverse-spindle-types";

const ALL_OPT_INS = new Set<SpindleCapability>([
  "dynamic_code_execution",
  "base64_decode",
]);
const EXPECTED_BUN_API_LABELS = new Map<string, string>([
  ["$", "subprocess API usage"],
  ["env", "sensitive runtime API usage"],
  ["argv", "sensitive runtime API usage"],
  ["cwd", "sensitive runtime API usage"],
  ["main", "sensitive runtime API usage"],
  ["mmap", "direct filesystem API usage"],
  ["Glob", "direct filesystem API usage"],
  ["FileSystemRouter", "direct filesystem API usage"],
  ["build", "sensitive runtime API usage"],
  ["plugin", "sensitive runtime API usage"],
  ["resolve", "sensitive runtime API usage"],
  ["resolveSync", "sensitive runtime API usage"],
  ["which", "sensitive runtime API usage"],
  ["embeddedFiles", "sensitive runtime API usage"],
  ["FFI", "native FFI API usage"],
  ["unsafe", "native FFI API usage"],
  ["file", "dangerous Bun system API usage"],
  ["write", "dangerous Bun system API usage"],
  ["spawn", "dangerous Bun system API usage"],
  ["spawnSync", "dangerous Bun system API usage"],
  ["openInEditor", "sensitive runtime API usage"],
  ["serve", "direct network API usage"],
  ["connect", "direct network API usage"],
  ["listen", "direct network API usage"],
  ["udpSocket", "direct network API usage"],
  ["dns", "direct network API usage"],
  ["fetch", "direct network API usage"],
  ["sql", "direct network API usage"],
  ["SQL", "direct network API usage"],
  ["postgres", "direct network API usage"],
  ["redis", "direct network API usage"],
  ["RedisClient", "direct network API usage"],
  ["s3", "direct network API usage"],
  ["S3Client", "direct network API usage"],
  ["secrets", "sensitive runtime API usage"],
  ["stdin", "sensitive runtime API usage"],
  ["stdout", "sensitive runtime API usage"],
  ["stderr", "sensitive runtime API usage"],
  ["Terminal", "sensitive runtime API usage"],
  ["WebView", "sensitive runtime API usage"],
  ["cron", "sensitive runtime API usage"],
]);

const EXPECTED_GLOBAL_API_LABELS = new Map<string, string>([
  ["fetch", "direct network API usage"],
  ["WebSocket", "direct network API usage"],
  ["Worker", "worker runtime API usage"],
  ["BroadcastChannel", "worker runtime API usage"],
]);

const EXPECTED_BLOCKED_PROCESS_API_NAMES = [
  "exit",
  "kill",
  "chdir",
  "dlopen",
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "mainModule",
  "abort",
] as const;

function propertyExpression(objectName: string, property: string, computed: boolean): string {
  return computed ? `${objectName}[${JSON.stringify(property)}]` : `${objectName}.${property}`;
}

describe("dangerous runtime policy tables", () => {
  test("matches the independently maintained hard-block policy tables", () => {
    expect([...BLOCKED_BUN_API_LABELS]).toEqual([...EXPECTED_BUN_API_LABELS]);
    expect([...BLOCKED_GLOBAL_API_LABELS]).toEqual([...EXPECTED_GLOBAL_API_LABELS]);
    expect([...BLOCKED_PROCESS_API_NAMES]).toEqual([...EXPECTED_BLOCKED_PROCESS_API_NAMES]);
  });

  test("hard-blocks every Bun API through direct, computed, aliased, and destructured access", () => {
    for (const [api, label] of EXPECTED_BUN_API_LABELS) {
      const direct = propertyExpression("Bun", api, false);
      const computed = propertyExpression("Bun", api, true);
      const alias = propertyExpression("bunAlias", api, false);
      const destructured = `const { ${api}: selected } = Bun; selected`;

      for (const source of [
        `${direct};`,
        `${computed};`,
        `const bunAlias = Bun; ${alias};`,
        `${destructured};`,
      ]) {
        const hits = detectDangerousBackendCapabilities(source, ALL_OPT_INS);
        expect(hits, `${api} should remain hard-blocked (${source})`).toContain(label);
      }
    }
  });

  test("hard-blocks every global API through direct, computed, aliased, and destructured access", () => {
    for (const [api, label] of EXPECTED_GLOBAL_API_LABELS) {
      const direct = `globalThis.${api};`;
      const computed = `globalThis[${JSON.stringify(api)}];`;
      const alias = `const globalAlias = globalThis.${api}; globalAlias;`;
      const destructured = `const { ${api}: selected } = globalThis; selected;`;

      for (const source of [direct, computed, alias, destructured]) {
        const hits = detectDangerousBackendCapabilities(source, ALL_OPT_INS);
        expect(hits, `${api} should remain hard-blocked (${source})`).toContain(label);
      }
    }
  });

  test("hard-blocks every dangerous process loader and mutator through all access forms", () => {
    for (const api of EXPECTED_BLOCKED_PROCESS_API_NAMES) {
      const sources = [
        `process.${api};`,
        `process[${JSON.stringify(api)}];`,
        `const processAlias = process; processAlias.${api};`,
        `const { ${api}: selected } = process; selected;`,
      ];
      for (const source of sources) {
        expect(
          detectDangerousBackendCapabilities(source, ALL_OPT_INS),
          `${api} should be blocked (${source})`,
        ).toContain("dangerous process API usage");
      }
    }
  });

  test("hard-blocks process.env scanner access independently of runtime masking", () => {
    const forms = [
      "process.env.SECRET",
      "process[\"env\"].SECRET",
      "const processAlias = process; processAlias.env.SECRET",
      "const { env: processEnv } = process; processEnv.SECRET",
    ];
    for (const source of forms) {
      expect(detectDangerousBackendCapabilities(source, ALL_OPT_INS), source).toContain(
        "dangerous process API usage",
      );
    }
  });

  test("guards process.binding, _linkedBinding, and getBuiltinModule loader escapes", () => {
    const forms = [
      "process.binding(name)",
      "process[\"binding\"](name)",
      "const binding = process.binding; binding(name)",
      "const { binding } = process; binding(name)",
      "process._linkedBinding(name)",
      "process[\"_linkedBinding\"](name)",
      "const linked = process._linkedBinding; linked(name)",
      "const { _linkedBinding: linked } = process; linked(name)",
      "process.getBuiltinModule(name)",
      "process[\"getBuiltinModule\"](name)",
      "const builtin = process.getBuiltinModule; builtin(name)",
      "const { getBuiltinModule: builtin } = process; builtin(name)",
    ];

    for (const source of forms) {
      expect(detectDangerousBackendCapabilities(source, ALL_OPT_INS)).toContain(
        "dangerous process API usage",
      );
    }
  });

  test("covers dns, http2, and inspector module maps across loader syntax", () => {
    const modules = [
      ["dns", "direct socket module access"],
      ["dns/promises", "direct socket module access"],
      ["node:dns", "direct socket module access"],
      ["node:dns/promises", "direct socket module access"],
      ["http2", "direct socket module access"],
      ["node:http2", "direct socket module access"],
      ["inspector", "debugger module access"],
      ["node:inspector", "debugger module access"],
      ["inspector/promises", "debugger module access"],
      ["node:inspector/promises", "debugger module access"],
    ] as const;

    for (const [specifier, label] of modules) {
      const quoted = JSON.stringify(specifier);
      for (const source of [
        `import * as loaded from ${quoted}; void loaded;`,
        `await import(${quoted});`,
        `require(${quoted});`,
      ]) {
        expect(detectDangerousBackendCapabilities(source), `${specifier}: ${source}`).toContain(label);
      }
    }
  });

  test("hard-blocks bun:jsc across static, dynamic, default, named, and require forms", () => {
    expect(BLOCKED_MODULE_SPECIFIER_LABELS.get("bun:jsc")).toBe("module loading");

    const sources = [
      `import "bun:jsc";`,
      `await import("bun:jsc");`,
      `import jsc from "bun:jsc"; void jsc;`,
      `import { compile } from "bun:jsc"; void compile;`,
      `require("bun:jsc");`,
    ];
    for (const source of sources) {
      expect(
        detectDangerousBackendCapabilities(source, ALL_OPT_INS),
        `install scanner: ${source}`,
      ).toContain("module loading");
      expect(
        detectSerializedHandlerModuleAccess(source),
        `serialized handler scanner: ${source}`,
      ).toEqual(["module loading"]);
    }
  });

  test("does not false-positive safe Bun computation or unrelated require receivers", () => {
    const safe = String.raw`
      const digest = Bun.hash("stable");
      const now = Bun.nanoseconds();
      const object = { require(value) { return value; } };
      const moduleLike = { require(value) { return value; } };
      object.require(input);
      moduleLike.require(input);
      const prose = "Bun.spawn process.env.SECRET require('node:fs')";
      // Bun.file('/etc/passwd'); globalThis.fetch(url); process.binding(name)
      const unrelatedBun = { ["file"](value) { return value; }, ["spawn"](value) { return value; } };
      const unrelatedProcess = { ["binding"](value) { return value; }, env: { SECRET: "safe" } };
      const unrelatedGlobal = { ["fetch"](value) { return value; }, ["Worker"](value) { return value; } };
      const BunAlias = unrelatedBun;
      const processAlias = unrelatedProcess;
      const globalAlias = unrelatedGlobal;
      BunAlias.file(input); processAlias.binding(input); globalAlias.fetch(input);
      void digest; void now; void prose;
    `;
    expect(detectDangerousBackendCapabilities(safe)).toEqual([]);
  });
});

describe("safe runtime environment", () => {
  test("recognizes every credential-bearing key family while retaining ordinary paths", () => {
    const sensitiveKeys = [
      "LUMIVERSE_CONFIG",
      "AUTH_SECRET",
      "MY_SECRET",
      "DB_PASSWORD",
      "PRIVATE_KEY_PEM",
      "ENCRYPTION_KEYRING",
      "SERVICE_API_KEY",
      "ACCESS_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "USER_CREDENTIAL_FILE",
      "LOGIN_SESSION",
      "SIGNING_JWT",
      "BROWSER_COOKIE",
      "AUTH_BEARER",
      "AWS_ACCESS_KEY_ID",
      "DATABASE_URL",
      "POSTGRESQL_URL",
      "MONGODB_URL",
      "REDIS_URL",
      "HOME",
      "USERPROFILE",
      "SSH_AUTH_SOCK",
    ];
    for (const key of sensitiveKeys) expect(isSensitiveEnvironmentKey(key), key).toBe(true);

    const safe = buildSafeEnvironment({
      PATH: "/usr/bin",
      TMPDIR: "/tmp/lumiverse",
      HOME_PATH: "/safe/home-path",
      USERPROFILE_PATH: "/safe/profile-path",
      LUMIVERSE_CONFIG: "secret",
      AUTH_TOKEN: "secret",
      AWS_ACCESS_KEY_ID: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
      DATABASE_URL: "postgres://user:pass@example.test/db",
      HOME: "/private/home",
      USERPROFILE: "C:\\\\private\\\\profile",
      SSH_AUTH_SOCK: "/private/agent.sock",
      EMPTY: undefined,
    });

    expect(safe).toEqual({
      PATH: "/usr/bin",
      TMPDIR: "/tmp/lumiverse",
      HOME_PATH: "/safe/home-path",
      USERPROFILE_PATH: "/safe/profile-path",
    });
  });
});

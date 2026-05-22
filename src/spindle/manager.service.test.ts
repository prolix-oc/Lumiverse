import { describe, expect, test } from "bun:test";

import {
  bunInstallCmd,
  declaredCapabilitiesFromManifest,
  detectDangerousBackendCapabilities,
  PRIVILEGED_PERMISSIONS,
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

  test("does not flag empty-body Function probes (Zod / Cloudflare feature-detect)", () => {
    const samples = [
      `try { return new Function(""), true } catch { return false }`,
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
      `return /Function\\s*\\(/.test(x);`,
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
      expect(detectDangerousBackendCapabilities(code)).toContain(label);
    }
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
});

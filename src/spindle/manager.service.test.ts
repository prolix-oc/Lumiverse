import { describe, expect, test } from "bun:test";

import { bunInstallCmd, detectDangerousBackendCapabilities, PRIVILEGED_PERMISSIONS } from "./manager.service";

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

import { expect, test } from "bun:test";
import { npmCmd } from "./termux-cli.js";

test("keeps bare npm outside Termux-like runtimes", () => {
  expect(npmCmd(["cache", "clean", "--force"], {
    env: {},
    which: () => null,
    fileExists: () => false,
  })).toEqual(["npm", "cache", "clean", "--force"]);
});

test("uses the absolute npm CLI script on Termux when it is available", () => {
  const prefix = "/data/data/com.termux/files/usr";
  expect(npmCmd(["install", "--force"], {
    env: { LUMIVERSE_IS_TERMUX: "true", PREFIX: prefix },
    which: (name) => name === "node" ? `${prefix}/bin/node` : null,
    fileExists: (path) => path === `${prefix}/lib/node_modules/npm/bin/npm-cli.js`,
  })).toEqual([
    `${prefix}/bin/node`,
    `${prefix}/lib/node_modules/npm/bin/npm-cli.js`,
    "install",
    "--force",
  ]);
});

test("falls back to an absolute npm shim path when the CLI script is unavailable", () => {
  const prefix = "/data/data/com.termux/files/usr";
  expect(npmCmd(["cache", "clean"], {
    env: { LUMIVERSE_IS_PROOT: "true", PREFIX: prefix },
    which: (name) => name === "npm" ? `${prefix}/bin/npm` : null,
    fileExists: () => false,
  })).toEqual([
    `${prefix}/bin/npm`,
    "cache",
    "clean",
  ]);
});

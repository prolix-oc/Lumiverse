import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  inspectDependencyTree,
  planChangedDependencies,
  prepareDependencyInstall,
  restoreDependencyInstall,
  runWithServerStopped,
} from "./git-ops.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-git-ops-"));
  tempDirs.push(dir);
  return dir;
}

function writePackageJson(
  dir: string,
  packageNames: { dependencies?: string[]; devDependencies?: string[] },
): void {
  const manifest = {
    name: "runner-install-fixture",
    dependencies: Object.fromEntries((packageNames.dependencies ?? []).map((name) => [name, "1.0.0"])),
    devDependencies: Object.fromEntries((packageNames.devDependencies ?? []).map((name) => [name, "1.0.0"])),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

function installPackage(dir: string, packageName: string): void {
  mkdirSync(join(dir, "node_modules", ...packageName.split("/")), { recursive: true });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a manual install without a runner stamp", () => {
  const dir = makeTempDir();
  writePackageJson(dir, {
    dependencies: ["hono"],
    devDependencies: ["bun-types"],
  });
  installPackage(dir, "hono");
  installPackage(dir, "bun-types");

  expect(inspectDependencyTree(dir)).toEqual({
    hasNodeModules: true,
    hasStamp: false,
    missingPackages: [],
  });

  const prepared = prepareDependencyInstall(dir, "backend");
  expect(prepared.backupDir).toBeNull();
  expect(existsSync(join(dir, "node_modules", ".lumiverse-install-complete"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "hono"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "bun-types"))).toBe(true);
});

test("restores the previous dependency tree after a failed repair attempt", () => {
  const dir = makeTempDir();
  writePackageJson(dir, {
    dependencies: ["hono", "@types/node"],
  });
  installPackage(dir, "hono");

  const prepared = prepareDependencyInstall(dir, "backend");
  expect(prepared.backupDir).not.toBeNull();
  expect(existsSync(join(dir, "node_modules"))).toBe(false);

  mkdirSync(join(dir, "node_modules"), { recursive: true });
  installPackage(dir, "not-the-right-package");

  restoreDependencyInstall(dir, "backend", prepared);

  expect(existsSync(join(dir, "node_modules", "hono"))).toBe(true);
  expect(existsSync(join(dir, "node_modules", "@types", "node"))).toBe(false);
  expect(existsSync(join(dir, "node_modules", ".lumiverse-install-complete"))).toBe(false);
});

test("restarts the server after a stopped operation fails", async () => {
  const calls: string[] = [];

  await expect(runWithServerStopped(
    "test operation",
    async () => { calls.push("stop"); },
    async () => { calls.push("start"); },
    async () => {
      calls.push("operation");
      throw new Error("build failed");
    },
  )).rejects.toThrow("build failed");

  expect(calls).toEqual(["stop", "operation", "start"]);
});

test("starts the server once after a stopped operation succeeds", async () => {
  const calls: string[] = [];

  await runWithServerStopped(
    "test operation",
    async () => { calls.push("stop"); },
    async () => { calls.push("start"); },
    async () => { calls.push("operation"); },
  );

  expect(calls).toEqual(["stop", "operation", "start"]);
});

test("repairs Termux native bindings before a source-only frontend rebuild", () => {
  expect(planChangedDependencies(["frontend/src/App.tsx"], true)).toEqual({
    installBackend: false,
    installFrontend: false,
    repairTermuxFrontendNativeDeps: true,
  });
});

test("does not duplicate the Termux binding repair after a frontend install", () => {
  expect(planChangedDependencies(["frontend/package.json"], true)).toEqual({
    installBackend: false,
    installFrontend: true,
    repairTermuxFrontendNativeDeps: false,
  });
});

test("does not repair frontend bindings for backend-only or non-Termux updates", () => {
  expect(planChangedDependencies(["src/main.ts"], true).repairTermuxFrontendNativeDeps).toBe(false);
  expect(planChangedDependencies(["frontend/src/App.tsx"], false).repairTermuxFrontendNativeDeps).toBe(false);
});

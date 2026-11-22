import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env";
import {
  assertSafeFrontendBundles,
  buildExtension,
  getFrontendBundlePath,
  getManifest,
  getWidgetFrontendBundlePath,
} from "./manager.service";
import { spawnAsync } from "./spawn-async";

const originalDataDir = env.dataDir;
let directory: string;
let repo: string;
const identifier = "published_build_probe";
const nativeUUID = `crypto.${"randomUUID"}()`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spindle-build-"));
  env.dataDir = directory;
  repo = join(directory, "extensions", identifier, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "spindle.json"), JSON.stringify({
    identifier, name: "Build probe", version: "1.0.0", author: "Test",
    entry_backend: "dist/backend.js", entry_frontend: "dist/frontend.js",
  }));
});

afterEach(() => {
  env.dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

async function publish(backend = "export const ready = true;", frontend = "export const ready = true;") {
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist/backend.js"), backend);
  writeFileSync(join(repo, "dist/frontend.js"), frontend);
  for (const args of [["init", "--quiet"], ["add", "dist"]]) {
    const result = await spawnAsync(["git", ...args], { cwd: repo });
    if (result.exitCode) throw new Error(result.stderr);
  }
}

function localDependency(name: string) {
  const path = join(directory, name);
  mkdirSync(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(path, "index.js"), `export const value = "${name}-installed";`);
  return `file:${path}`;
}

describe("extension published bundles", () => {
  test("installs a Palette-style release without resolving development tools", async () => {
    await publish();
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      devDependencies: { "unavailable-build-tool": "file:./missing-development-tool" },
    }));

    await buildExtension(identifier);

    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    expect(readFileSync(join(repo, "dist/backend.js"), "utf8")).toContain("ready = true");
  });

  test("continues to enforce backend capabilities when dependency installation is skipped", async () => {
    await publish("export const secret = process.env.SECRET;");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ devDependencies: {} }));

    await expect(buildExtension(identifier)).rejects.toThrow("blocked backend capabilities");
  });

  test("rejects published frontend UUID usage with the backend-style error and helper guidance", async () => {
    await publish(undefined, `export const id = ${nativeUUID};`);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ devDependencies: {} }));

    await expect(buildExtension(identifier)).rejects.toThrow(
      `Extension "${identifier}" uses blocked frontend capabilities: direct crypto.randomUUID API usage; use ctx.uuid.v4() or ctx.uuid.v7() instead for HTTP/LAN compatibility`,
    );
  });

  test("checks source-built frontend dependencies", async () => {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/dependency.ts"), `export const id = () => ${nativeUUID};`);
    writeFileSync(join(repo, "src/frontend.ts"), "export { id } from './dependency';");

    await expect(buildExtension(identifier)).rejects.toThrow("blocked frontend capabilities");
  });

  test("checks existing bundles even without source or tracked dist files", async () => {
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist/frontend.js"), `export const id = ${nativeUUID};`);

    await expect(buildExtension(identifier)).rejects.toThrow("blocked frontend capabilities");
  });

  test("rejects dedicated widget bundles during builds and startup validation", async () => {
    await publish();
    const manifest = { ...await getManifest(identifier), entry_frontend_widget: "dist/widget.js" };
    writeFileSync(join(repo, "spindle.json"), JSON.stringify(manifest));
    writeFileSync(join(repo, "dist/widget.js"), `export const id = ${nativeUUID};`);

    await expect(buildExtension(identifier)).rejects.toThrow("blocked frontend capabilities");
    await expect(assertSafeFrontendBundles(identifier, manifest)).rejects.toThrow("blocked frontend capabilities");
    await expect(getWidgetFrontendBundlePath(identifier)).rejects.toThrow("blocked frontend capabilities");
  });

  test("rechecks installed frontend bundles and invalidates cached scan results after edits", async () => {
    await publish();
    const path = join(repo, "dist/frontend.js");
    expect(await getFrontendBundlePath(identifier)).toBe(path);
    const manifest = await getManifest(identifier);

    writeFileSync(path, `export const id = ${nativeUUID};`);
    await expect(getFrontendBundlePath(identifier)).rejects.toThrow("blocked frontend capabilities");
    await expect(assertSafeFrontendBundles(identifier, manifest)).rejects.toThrow("blocked frontend capabilities");

    writeFileSync(path, "export function setup(ctx) { return ctx.uuid.v4(); }");
    expect(await getFrontendBundlePath(identifier)).toBe(path);
    await assertSafeFrontendBundles(identifier, manifest);
  });

  test("allows frontend helpers alongside backend UUIDs and hashing", async () => {
    await publish(
      `import { createHash } from "node:crypto"; export const hash = createHash("sha256").update(${nativeUUID}).digest("hex");`,
      "export function setup(ctx) { crypto.getRandomValues(new Uint8Array(16)); return ctx.uuid.v4(); }",
    );
    await buildExtension(identifier);
  });

  test("installs runtime dependencies of a published release and omits development tools", async () => {
    await publish();
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      dependencies: { "runtime-fixture": localDependency("runtime-fixture") },
      devDependencies: { "unused-build-tool": localDependency("unused-build-tool") },
    }));

    await buildExtension(identifier);

    expect(existsSync(join(repo, "node_modules/runtime-fixture/index.js"))).toBe(true);
    expect(existsSync(join(repo, "node_modules/unused-build-tool"))).toBe(false);
  });

  test("source releases still install development dependencies and compile their entries", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      devDependencies: { "source-fixture": localDependency("source-fixture") },
    }));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/backend.ts"), "export const ready: boolean = true;");
    writeFileSync(join(repo, "src/frontend.ts"), "export { value } from 'source-fixture';");

    await buildExtension(identifier);

    expect(existsSync(join(repo, "node_modules/source-fixture/index.js"))).toBe(true);
    expect(readFileSync(join(repo, "dist/frontend.js"), "utf8")).toContain("source-fixture-installed");
    expect(readFileSync(join(repo, "dist/backend.js"), "utf8")).toContain("ready");
  });

  test("dependency failures include an exit status alongside command output", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      dependencies: { "unavailable-runtime": "file:./missing-runtime" },
    }));

    await expect(buildExtension(identifier)).rejects.toThrow(/Dependency install failed:[\s\S]*bun install exited with code [1-9]/);
  });
});

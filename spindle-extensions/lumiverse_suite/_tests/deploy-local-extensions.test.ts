import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const deployScriptPath = join(import.meta.dir, "../../../scripts/deploy-local-extensions.ts");
const hasDeployScript = existsSync(deployScriptPath);

const deployLocalExtensions = hasDeployScript
  ? (await import("../../../scripts/deploy-local-extensions")).deployLocalExtensions
  : (() => Promise.resolve({ ok: true } as any));

const IDENTIFIER = "lumiverse_suite";
const PERMISSIONS = [
  "generation",
  "chats",
  "characters",
  "app_manipulation",
  "ui_panels",
  "world_books",
];

const workspaces: string[] = [];

function workspace(): string {
  // macOS exposes the temporary directory through /var while realpath resolves
  // it through /private/var. Keep the fixture on the same canonical spelling as
  // the production containment checks so a valid child is not mistaken for an
  // escape from its project root.
  const path = realpathSync(mkdtempSync(join(tmpdir(), "lumiverse-deploy-test-")));
  workspaces.push(path);
  return path;
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      version: "1.0.0",
      name: "Lumiverse Suite",
      identifier: IDENTIFIER,
      author: "Lumiverse contributors",
      github: "https://github.com/prolix-oc/Lumiverse",
      homepage: "https://github.com/prolix-oc/Lumiverse",
      description: "The unified Lumiverse productivity and interface feature suite.",
      dev_mode: true,
      permissions: PERMISSIONS,
      entry_frontend: "dist/frontend.js",
      minimum_lumiverse_version: "0.1.0",
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

function writeSuite(sourceRoot: string, manifestText = manifest()): string {
  const suite = join(sourceRoot, IDENTIFIER);
  mkdirSync(join(suite, "src"), { recursive: true });
  writeFileSync(join(suite, "spindle.json"), manifestText);
  writeFileSync(join(suite, "src", "index.ts"), "export {};\n");
  return suite;
}

function destination(projectRoot: string): string {
  return join(projectRoot, "data", "extensions", IDENTIFIER, "repo");
}

function snapshot(path: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (current: string) => {
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: current, onlyFiles: true })) {
      files.set(entry, Buffer.from(readFileSync(join(current, entry))));
    }
  };
  if (existsSync(path)) visit(path);
  return files;
}

async function deploy(projectRoot: string, sourceRoot: string, options: DeployOptions = {}) {
  return deployLocalExtensions({
    projectRoot,
    source: join(sourceRoot, IDENTIFIER),
    destination: destination(projectRoot),
    ...options,
  });
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(!hasDeployScript)("deploy-local-extensions", () => {
  test("requires literal JSON dev_mode true", async () => {
    const root = workspace();
    const source = join(root, "source");

    for (const [name, text] of [
      ["missing", manifest({ dev_mode: undefined })],
      ["false", manifest({ dev_mode: false })],
      ["string", manifest({ dev_mode: "true" })],
      ["camel", manifest({ dev_mode: undefined, devMode: true })],
      ["kebab", manifest({ dev_mode: undefined, "dev-mode": true })],
    ] as const) {
      const fixture = join(source, name);
      writeSuite(fixture, text);
      await expect(deploy(root, fixture)).rejects.toThrow(/dev_mode/i);
      expect(existsSync(destination(root))).toBe(false);
    }
  });

  test("requires HTTPS github and homepage manifest fields", async () => {
    const root = workspace();
    const source = join(root, "source");

    for (const [field, value] of [
      ["github", undefined],
      ["homepage", undefined],
      ["github", "http://github.com/prolix-oc/Lumiverse"],
      ["homepage", "http://github.com/prolix-oc/Lumiverse"],
      ["github", "not-a-url"],
      ["homepage", "not-a-url"],
    ] as const) {
      const fixture = join(source, `${field}-${value === undefined ? "missing" : "invalid"}`);
      writeSuite(fixture, manifest({ [field]: value }));
      await expect(deploy(root, fixture)).rejects.toThrow(new RegExp(`${field}.*HTTPS`, "i"));
      expect(existsSync(destination(root))).toBe(false);
    }
  });

  test("scans suite source for raw geometry and accepts only an immediate justification", async () => {
    const root = workspace();
    const source = join(root, "source");
    for (const [name, body] of [
      ["window", "const width = window.innerWidth;\n"],
      ["globalThis", "const width = globalThis.innerWidth;\n"],
      ["nested-globalThis-window", "const width = globalThis.window.innerWidth;\n"],
      ["bounding-rect", "const rect = element.getBoundingClientRect();\n"],
    ] as const) {
      const fixture = join(source, name);
      const suite = writeSuite(fixture);
      writeFileSync(join(suite, "src", "index.ts"), body);
      await expect(deploy(root, fixture)).rejects.toThrow(/banned raw geometry|H6/i);
      expect(existsSync(destination(root))).toBe(false);
    }

    const justifiedRoot = workspace();
    const justifiedSource = join(justifiedRoot, "source");
    const justifiedSuite = writeSuite(justifiedSource);
    const justified = "// lumiverse-geometry-justification: legacy host fallback is intentionally isolated\n"
      + "const width = globalThis.window.innerWidth;\n";
    writeFileSync(join(justifiedSuite, "src", "index.ts"), justified);
    await deploy(justifiedRoot, justifiedSource);
    expect(readFileSync(join(destination(justifiedRoot), "src", "index.ts"), "utf8")).toBe(justified);

    const delayedRoot = workspace();
    const delayedSource = join(delayedRoot, "source");
    const delayedSuite = writeSuite(delayedSource);
    writeFileSync(
      join(delayedSuite, "src", "index.ts"),
      "// lumiverse-geometry-justification: this is no longer immediate\n\nconst width = globalThis.window.innerWidth;\n",
    );
    await expect(deploy(delayedRoot, delayedSource)).rejects.toThrow(/banned raw geometry|H6/i);
    expect(existsSync(destination(delayedRoot))).toBe(false);
  });

  test("rejects every install target other than the sole suite", async () => {
    const root = workspace();
    const source = join(root, "source");
    writeSuite(source);

    await expect(deploy(root, source, { source: join(source, "quick_toolbar") })).rejects.toThrow(
      /only.*lumiverse_suite/i,
    );
    await expect(deploy(root, source, { destination: join(root, "data", "extensions", "quick_toolbar", "repo") })).rejects.toThrow(
      /only.*lumiverse_suite/i,
    );
  });

  test("rejects source links, source-tree links, and linked destination components", async () => {
    const root = workspace();
    const source = join(root, "source");
    const outside = join(root, "outside");
    const suite = writeSuite(source);
    mkdirSync(outside, { recursive: true });

    const linkedSource = join(root, "linked-source");
    mkdirSync(linkedSource, { recursive: true });
    symlinkSync(suite, join(linkedSource, IDENTIFIER), "junction");
    await expect(deploy(root, linkedSource)).rejects.toThrow(/link|reparse|canonical/i);

    symlinkSync(outside, join(suite, "linked-child"), "junction");
    await expect(deploy(root, source)).rejects.toThrow(/link|reparse|canonical/i);
    rmSync(join(suite, "linked-child"), { recursive: true, force: true });

    mkdirSync(join(root, "data"), { recursive: true });
    symlinkSync(outside, join(root, "data", "extensions"), "junction");
    await expect(deploy(root, source)).rejects.toThrow(/link|reparse|canonical/i);
    expect(existsSync(join(outside, IDENTIFIER))).toBe(false);
  });

  test("rejects canonical-path escapes and invalid identity or permission declarations", async () => {
    const root = workspace();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });

    const escapeSource = join(root, "escape-source");
    const suite = writeSuite(escapeSource);
    symlinkSync(outside, join(suite, "escaped"), "junction");
    await expect(deploy(root, escapeSource)).rejects.toThrow(/escape|link|canonical/i);

    const badIdentifier = join(root, "bad-identifier");
    writeSuite(badIdentifier, manifest({ identifier: "quick_toolbar" }));
    await expect(deploy(root, badIdentifier)).rejects.toThrow(/identifier/i);

    const badPermissions = join(root, "bad-permissions");
    writeSuite(badPermissions, manifest({ permissions: ["generation"] }));
    await expect(deploy(root, badPermissions)).rejects.toThrow(/permission/i);
  });

  test("filters dependency and VCS directories from the deployed tree", async () => {
    const root = workspace();
    const source = join(root, "source");
    const suite = writeSuite(source);
    for (const directory of ["node_modules", ".git", ".svn", ".hg", ".jj"]) {
      mkdirSync(join(suite, directory), { recursive: true });
      writeFileSync(join(suite, directory, "sentinel"), directory);
    }

    await deploy(root, source);
    const repo = destination(root);
    expect(readFileSync(join(repo, "src", "index.ts"), "utf8")).toBe("export {};\n");
    for (const directory of ["node_modules", ".git", ".svn", ".hg", ".jj"]) {
      expect(existsSync(join(repo, directory))).toBe(false);
    }
  });

  test("preserves authored, sibling, and outer-worktree sentinels on malformed input", async () => {
    const root = workspace();
    const source = join(root, "source");
    writeSuite(source, manifest({ dev_mode: false }));
    const live = destination(root);
    const sibling = join(root, "data", "extensions", "sibling");
    const outer = join(root, "outer-worktree-sentinel");
    mkdirSync(live, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(live, "authored-sentinel"), "authored");
    writeFileSync(join(sibling, "sibling-sentinel"), "sibling");
    writeFileSync(outer, "outer");
    const beforeLive = snapshot(live);
    const beforeSibling = snapshot(sibling);
    const beforeOuter = readFileSync(outer);

    await expect(deploy(root, source)).rejects.toThrow(/dev_mode/i);
    expect(snapshot(live)).toEqual(beforeLive);
    expect(snapshot(sibling)).toEqual(beforeSibling);
    expect(readFileSync(outer)).toEqual(beforeOuter);
  });

  test("replaces the deployed repository without overlaying stale files", async () => {
    const root = workspace();
    const source = join(root, "source");
    writeSuite(source);
    const live = destination(root);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "authored-sentinel"), "stale");

    await deploy(root, source);

    expect(existsSync(join(live, "authored-sentinel"))).toBe(false);
    expect(readFileSync(join(live, "src", "index.ts"), "utf8")).toBe("export {};\n");
    const parentEntries = [...new Bun.Glob("*").scanSync({ cwd: dirname(live), onlyFiles: false })];
    expect(parentEntries.filter((entry) => basename(entry).includes("stage") || basename(entry).includes("backup"))).toEqual([]);
    expect(lstatSync(live).isDirectory()).toBe(true);
  });
});

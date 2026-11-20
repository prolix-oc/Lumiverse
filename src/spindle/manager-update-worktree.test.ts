import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "../env";
import {
  assertOwnedExtensionGitRoot,
  switchBranch,
  update,
} from "./manager.service";

const originalDataDir = env.dataDir;
const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "lumiverse-manager-worktree-"));
  workspaces.push(path);
  return path;
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function initGitRoot(path: string): void {
  mkdirSync(path, { recursive: true });
  runGit(path, ["init"]);
  runGit(path, ["config", "user.email", "n10-test@example.invalid"]);
  runGit(path, ["config", "user.name", "N10 test"]);
  runGit(path, ["config", "commit.gpgsign", "false"]);
}

function writeManifest(
  repo: string,
  identifier: string,
  devMode?: unknown,
): void {
  const manifest: Record<string, unknown> = {
    identifier,
    version: "1.0.0",
    name: "N10 worktree test",
    author: "N10 test",
    github: "https://github.com/example/n10-worktree-test",
    homepage: "https://example.invalid/n10-worktree-test",
    permissions: [],
  };
  if (devMode !== undefined) manifest.dev_mode = devMode;
  writeFileSync(join(repo, "spindle.json"), `${JSON.stringify(manifest)}\n`);
}

function extensionRepo(dataDir: string, identifier: string, devMode?: unknown): string {
  const repo = join(dataDir, "extensions", identifier, "repo");
  mkdirSync(repo, { recursive: true });
  writeManifest(repo, identifier, devMode);
  return repo;
}

function expectSentinel(path: string, expected: string): void {
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(expected);
}

afterEach(() => {
  env.dataDir = originalDataDir;
  for (const path of workspaces.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe.serial("manager Git-root confinement", () => {
  test("rejects a repo with no .git before update or switch mutations", async () => {
    const dataDir = workspace();
    env.dataDir = dataDir;
    const repo = extensionRepo(dataDir, "n10_missing_git");
    const sentinel = join(repo, "untracked-sentinel.txt");
    writeFileSync(sentinel, "keep\n");

    await expect(update("n10_missing_git")).rejects.toThrow(/Git root confinement/);
    await expect(switchBranch("n10_missing_git", "main")).rejects.toThrow(
      /Git root confinement/,
    );
    expectSentinel(sentinel, "keep\n");
  });

  test("rejects an extension nested in an outer Git worktree before any mutator", async () => {
    const dataDir = workspace();
    env.dataDir = dataDir;
    initGitRoot(dataDir);

    const repo = extensionRepo(dataDir, "n10_outer_repo");
    const tracked = join(repo, "tracked-sentinel.txt");
    const untracked = join(repo, "untracked-sentinel.txt");
    writeFileSync(tracked, "committed\n");
    runGit(dataDir, ["add", "."]);
    runGit(dataDir, ["commit", "-m", "sentinels"]);
    writeFileSync(tracked, "modified\n");
    writeFileSync(untracked, "keep\n");

    await expect(update("n10_outer_repo")).rejects.toThrow(/does not equal Git root/);
    await expect(switchBranch("n10_outer_repo", "main")).rejects.toThrow(
      /does not equal Git root/,
    );

    expectSentinel(tracked, "modified\n");
    expectSentinel(untracked, "keep\n");
  });

  test("keeps the explicit dev_mode true update bypass without a Git root", async () => {
    const dataDir = workspace();
    env.dataDir = dataDir;
    extensionRepo(dataDir, "n10_dev_mode", true);

    let error: unknown;
    try {
      await update("n10_dev_mode");
    } catch (caught) {
      error = caught;
    }

    // There is no database in this isolated fixture. Reaching that point,
    // rather than the N10 guard, proves dev_mode skipped all Git mutation
    // checks; the fixture has no src/dist path that could issue read-only Git.
    expect(String(error ?? "")).not.toMatch(/Git root confinement/);
  });

  test("rejects dev_mode branch switching before any Git operation", async () => {
    const dataDir = workspace();
    env.dataDir = dataDir;
    extensionRepo(dataDir, "n10_dev_mode_switch", true);

    await expect(switchBranch("n10_dev_mode_switch", "main")).rejects.toThrow(
      /Cannot switch branches for dev_mode extension/,
    );
  });

  test("still guards missing, false, and malformed dev_mode values", async () => {
    const cases: Array<[string, unknown | undefined]> = [
      ["missing", undefined],
      ["false", false],
      ["string", "true"],
    ];

    for (const [suffix, devMode] of cases) {
      const dataDir = workspace();
      env.dataDir = dataDir;
      extensionRepo(dataDir, `n10_${suffix}`, devMode);
      await expect(update(`n10_${suffix}`)).rejects.toThrow(/Git root confinement/);
    }
  });

  test("accepts a standalone Git root and a canonical directory link to it", async () => {
    const root = workspace();
    const repo = join(root, "standalone");
    initGitRoot(repo);

    expect(await assertOwnedExtensionGitRoot(repo)).toBe(realpathSync.native(repo));

    const alias = join(root, "standalone-alias");
    try {
      symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error: any) {
      if (error?.code === "EPERM" || error?.code === "EACCES") return;
      throw error;
    }

    expect(await assertOwnedExtensionGitRoot(alias)).toBe(realpathSync.native(repo));

    const outer = join(root, "outer");
    initGitRoot(outer);
    const nested = join(outer, "nested");
    mkdirSync(nested, { recursive: true });
    const nestedAlias = join(root, "nested-alias");
    symlinkSync(nested, nestedAlias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertOwnedExtensionGitRoot(nestedAlias)).rejects.toThrow(
      /does not equal Git root/,
    );
  });

  test.skipIf(process.platform !== "win32")(
    "compares Windows Git roots case-insensitively after realpath resolution",
    async () => {
      const root = workspace();
      const repo = join(root, "CaseSensitiveAlias");
      initGitRoot(repo);
      expect(await assertOwnedExtensionGitRoot(repo.toUpperCase())).toBe(
        realpathSync.native(repo),
      );
    },
  );
});

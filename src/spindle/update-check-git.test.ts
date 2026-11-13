import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOwnGitRepositoryPath,
  isOwnGitRepositoryPathAsync,
  resetGitRepositoryToRemoteHead,
} from "./git-repository";
import { spawnAsync } from "./spawn-async";
import { probeGitRepositoryForUpdate } from "./update-check-git";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-extension-update-"));
  tempDirs.push(dir);
  return dir;
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const proc = await spawnAsync(["git", ...args], {
    cwd,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${proc.stderr}`,
    );
  }
  return proc.stdout.trim();
}

async function commit(cwd: string, message: string): Promise<void> {
  await runGit(cwd, "add", ".");
  await runGit(
    cwd,
    "-c",
    "user.name=Lumiverse Test",
    "-c",
    "user.email=lumiverse@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  );
}

async function createRemoteFixture(): Promise<{
  source: string;
  clone: string;
}> {
  const root = makeTempDir();
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const clone = join(root, "clone");

  mkdirSync(remote);
  mkdirSync(source);
  await runGit(remote, "init", "--bare");
  await runGit(source, "init", "-b", "main");
  writeFileSync(join(source, "spindle.json"), '{"version":"1.0.0"}');
  await commit(source, "initial");
  await runGit(source, "remote", "add", "origin", remote);
  await runGit(source, "push", "-u", "origin", "main");
  await runGit(root, "clone", "--branch", "main", remote, clone);

  return { source, clone };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension update Git probe", () => {
  test("reports current and then detects a changed remote HEAD", async () => {
    const { source, clone } = await createRemoteFixture();

    expect(isOwnGitRepositoryPath(clone)).toBe(true);
    expect(await isOwnGitRepositoryPathAsync(clone)).toBe(true);
    const current = await probeGitRepositoryForUpdate(clone);
    expect(current.status).toBe("current");

    writeFileSync(join(source, "spindle.json"), '{"version":"1.1.0"}');
    await commit(source, "release 1.1.0");
    await runGit(source, "push", "origin", "main");

    const update = await probeGitRepositoryForUpdate(clone);
    expect(update.status).toBe("update");
    if (update.status === "update") {
      expect(update.localCommit).not.toBe(update.remoteCommit);
      expect(update.branch).toBe("main");
    }

    writeFileSync(join(clone, "local-only.txt"), "local commit");
    await commit(clone, "local-only change");
    writeFileSync(join(clone, "untracked.txt"), "untracked");

    await resetGitRepositoryToRemoteHead(clone, "Test extension");

    expect(await runGit(clone, "rev-parse", "HEAD")).toBe(
      await runGit(source, "rev-parse", "HEAD"),
    );
    expect(readFileSync(join(clone, "spindle.json"), "utf8")).toBe(
      '{"version":"1.1.0"}',
    );
    expect(existsSync(join(clone, "local-only.txt"))).toBe(false);
    expect(existsSync(join(clone, "untracked.txt"))).toBe(false);
    expect((await probeGitRepositoryForUpdate(clone)).status).toBe("current");
  });

  test("does not inherit a parent Lumiverse-style repository", async () => {
    const parent = makeTempDir();
    mkdirSync(join(parent, ".git"));
    const localExtension = join(parent, "data", "extensions", "local", "repo");
    mkdirSync(localExtension, { recursive: true });

    expect(isOwnGitRepositoryPath(localExtension)).toBe(false);
    expect(await isOwnGitRepositoryPathAsync(localExtension)).toBe(false);
    await expect(probeGitRepositoryForUpdate(localExtension)).resolves.toEqual({
      status: "skipped",
      reason: "not-own-git-repository",
    });
  });
});

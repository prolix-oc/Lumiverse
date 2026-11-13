import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverStaleGitIndexLock, resolveGitIndexLock } from "./git-index-lock";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-git-lock-"));
  roots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("resolves a normal repository index lock", () => {
  const root = repository();
  expect(resolveGitIndexLock(root)).toBe(join(root, ".git", "index.lock"));
});

test("resolves a worktree .git pointer", () => {
  const root = repository();
  rmSync(join(root, ".git"), { recursive: true });
  const gitDir = join(root, "metadata", "worktrees", "example");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: metadata/worktrees/example\n");
  expect(resolveGitIndexLock(root)).toBe(join(gitDir, "index.lock"));
});

test("recovers an old lock when no Git process is running", async () => {
  const root = repository();
  const lock = join(root, ".git", "index.lock");
  writeFileSync(lock, "stale");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const result = await recoverStaleGitIndexLock(root, {
    minimumAgeMs: 30_000,
    hasRunningGitProcess: async () => false,
  });

  expect(result.status).toBe("recovered");
  expect(() => readFileSync(lock)).toThrow();
});

test("preserves a lock while Git is running", async () => {
  const root = repository();
  const lock = join(root, ".git", "index.lock");
  writeFileSync(lock, "active");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const result = await recoverStaleGitIndexLock(root, {
    hasRunningGitProcess: async () => true,
  });

  expect(result.status).toBe("active");
  expect(readFileSync(lock, "utf8")).toBe("active");
});

test("preserves a recent lock even when the process scan is clear", async () => {
  const root = repository();
  const lock = join(root, ".git", "index.lock");
  writeFileSync(lock, "recent");

  const result = await recoverStaleGitIndexLock(root, {
    minimumAgeMs: 30_000,
    hasRunningGitProcess: async () => false,
  });

  expect(result.status).toBe("recent");
  expect(readFileSync(lock, "utf8")).toBe("recent");
});

test("does not remove a lock replaced during process inspection", async () => {
  const root = repository();
  const lock = join(root, ".git", "index.lock");
  writeFileSync(lock, "first");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const result = await recoverStaleGitIndexLock(root, {
    hasRunningGitProcess: async () => {
      rmSync(lock);
      writeFileSync(lock, "replacement");
      return false;
    },
  });

  expect(result.status).toBe("changed");
  expect(readFileSync(lock, "utf8")).toBe("replacement");
});


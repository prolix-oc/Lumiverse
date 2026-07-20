import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDataDirectory } from "./data-directory";

let workDir: string | undefined;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function makeWorkDir(): string {
  workDir = mkdtempSync(join(tmpdir(), "lumiverse-data-directory-test-"));
  return workDir;
}

describe("ensureDataDirectory", () => {
  test("creates a missing directory, including missing parents", () => {
    const dataDir = join(makeWorkDir(), "nested", "data");

    ensureDataDirectory(dataDir);

    expect(statSync(dataDir).isDirectory()).toBe(true);
  });

  test("accepts an existing directory without changing it", () => {
    const dataDir = join(makeWorkDir(), "data");
    ensureDataDirectory(dataDir);

    ensureDataDirectory(dataDir);

    expect(statSync(dataDir).isDirectory()).toBe(true);
  });

  test("reports a conflicting file with actionable guidance", () => {
    const dataDir = join(makeWorkDir(), "data");
    writeFileSync(dataDir, "not a directory");

    expect(() => ensureDataDirectory(dataDir)).toThrow(
      `DATA_DIR "${dataDir}" already exists but is not a directory`,
    );
    expect(existsSync(dataDir)).toBe(true);
  });
});

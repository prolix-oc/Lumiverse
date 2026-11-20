import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SOURCE_ROOTS = [
  join(ROOT, "src"),
  join(ROOT, "frontend", "src"),
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
const QUEUE_MICROTASK_RE = /\bqueueMicrotask\s*\(/;

function collectOffenders(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectOffenders(fullPath, acc);
      continue;
    }

    const dot = entry.lastIndexOf(".");
    const ext = dot >= 0 ? entry.slice(dot) : "";
    if (!SOURCE_EXTENSIONS.has(ext) || TEST_FILE_RE.test(entry)) continue;

    const source = readFileSync(fullPath, "utf8");
    if (QUEUE_MICROTASK_RE.test(source)) {
      acc.push(relative(ROOT, fullPath));
    }
  }
}

describe("queueMicrotask usage", () => {
  test("production code uses explicit low-priority schedulers instead", () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      collectOffenders(root, offenders);
    }
    expect(offenders).toEqual([]);
  });
});

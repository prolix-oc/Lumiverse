import { expect, test } from "bun:test";
import { spawnAsync } from "./spawn-async.js";

test("enforces a native subprocess timeout promptly", async () => {
  const timeoutMs = 100;
  const startedAt = performance.now();

  const result = await spawnAsync(
    [process.execPath, "-e", "await Bun.sleep(10_000)"],
    { timeoutMs },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.timedOut).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});

test("preserves an early non-zero exit instead of misreporting a timeout", async () => {
  const result = await spawnAsync(
    [process.execPath, "-e", "console.error('compiler failed'); process.exit(7)"],
    { timeoutMs: 10_000 },
  );

  expect(result.exitCode).toBe(7);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toContain("compiler failed");
});

test("does not misreport an early signal termination as a timeout", async () => {
  const result = await spawnAsync(
    [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
    { timeoutMs: 10_000 },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.timedOut).toBe(false);
});

test("does not wait for descendants holding inherited output pipes", async () => {
  const timeoutMs = 100;
  const descendantLifetimeMs = 2_000;
  const childProgram = [
    "Bun.spawn({",
    `  cmd: [process.execPath, \"-e\", \"await Bun.sleep(${descendantLifetimeMs})\"],`,
    '  stdout: "inherit",',
    '  stderr: "inherit",',
    "});",
    `await Bun.sleep(${descendantLifetimeMs});`,
  ].join("\n");
  const startedAt = performance.now();

  const result = await spawnAsync(
    [process.execPath, "-e", childProgram],
    { timeoutMs },
  );

  expect(result.timedOut).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("mirrors subprocess output while retaining the captured result", async () => {
  const chunks: Array<{ source: "stdout" | "stderr"; text: string }> = [];
  const result = await spawnAsync(
    [process.execPath, "-e", "console.log('building'); console.error('compiling')"],
    { onOutput: (source, text) => chunks.push({ source, text }) },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("building");
  expect(result.stderr).toContain("compiling");
  expect(chunks.some((chunk) => chunk.source === "stdout" && chunk.text.includes("building"))).toBe(true);
  expect(chunks.some((chunk) => chunk.source === "stderr" && chunk.text.includes("compiling"))).toBe(true);
});

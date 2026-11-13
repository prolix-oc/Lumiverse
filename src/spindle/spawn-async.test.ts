import { describe, expect, test } from "bun:test";

import { spawnAsync } from "./spawn-async";

describe("spawnAsync", () => {
  test("enforces and reports a subprocess timeout", async () => {
    const timeoutMs = 100;
    const startedAt = performance.now();

    const result = await spawnAsync(
      [process.execPath, "-e", "await Bun.sleep(10_000)"],
      { timeoutMs }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("preserves an early non-zero exit instead of misreporting a timeout", async () => {
    const result = await spawnAsync(
      [process.execPath, "-e", "console.error('command failed'); process.exit(7)"],
      { timeoutMs: 10_000 }
    );

    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("command failed");
  });

  test("does not misreport an early signal termination as a timeout", async () => {
    const result = await spawnAsync(
      [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      { timeoutMs: 10_000 }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.signalCode).toBe("SIGTERM");
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
      { timeoutMs }
    );

    expect(result.timedOut).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

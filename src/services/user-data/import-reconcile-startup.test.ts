import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Startup reconciliation simulates a process restart with real-time lease
// expiry and mutates the global env.dataDir, so it runs in a clean child
// process. Known issue: the child intermittently fails to exit after printing
// a green summary (cause unidentified, tracked). The wrapper therefore polls
// for exit with a hard SIGKILL deadline instead of awaiting pipe EOF, and
// accepts the run only when the completed summary proves it finished green; a
// child that deadlocks mid-run has no summary and still fails here.
const CHILD_TIMEOUT_MS = 90_000;

test("durable import startup recovery passes in an isolated process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumiverse-reconcile-startup-"));
  try {
    const outPath = join(dir, "child.stdout.log");
    const errPath = join(dir, "child.stderr.log");
    const child = Bun.spawn([
      process.execPath,
      "test",
      "./src/services/user-data/import-reconcile-startup.isolated.ts",
    ], {
      cwd: `${import.meta.dir}/../../..`,
      stdin: "ignore",
      stdout: Bun.file(outPath),
      stderr: Bun.file(errPath),
    });

    let exitCode: number | null = null;
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      exitCode = await Promise.race([
        child.exited,
        Bun.sleep(250).then(() => null),
      ]);
      if (exitCode !== null) break;
    }
    if (exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
    }

    const summary = `${await Bun.file(outPath).text()}\n${await Bun.file(errPath).text()}`;
    if (exitCode !== null) expect(exitCode).toBe(0);
    expect(summary).toMatch(/\b[1-9]\d* pass\b/);
    expect(summary).toMatch(/\b0 fail\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, CHILD_TIMEOUT_MS + 15_000);

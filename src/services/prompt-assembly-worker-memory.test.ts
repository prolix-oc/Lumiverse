import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("real assembly workers receive warm Cortex context and preserve recall during regeneration", async () => {
  // A separate process sets DATA_DIR before imports so both isolates share a
  // disposable on-disk database without disturbing other tests' module state.
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../../tests/fixtures/memory-prompt-worker.ts")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, stderr + stdout).toBe(0);
  expect(stdout).toContain("memory worker integration passed");
}, 30_000);

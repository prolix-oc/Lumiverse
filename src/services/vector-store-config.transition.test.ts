import { expect, test } from "bun:test";

test("vector-store config transition races pass in an isolated module graph", async () => {
  const child = Bun.spawn([
    process.execPath,
    "test",
    "./src/services/vector-store-config.transition.isolated.ts",
  ], {
    cwd: `${import.meta.dir}/../..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const summary = `${stdout}\n${stderr}`;
  expect(exitCode).toBe(0);
  expect(summary).toMatch(/1 pass/);
  expect(summary).toMatch(/0 fail/);
}, 15_000);

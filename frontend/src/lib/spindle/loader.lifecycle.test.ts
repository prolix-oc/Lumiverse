import { expect, test } from 'bun:test'

// This fixture replaces placement/UI modules through Bun's process-global mock registry.
// A child process keeps those mocks from poisoning the real helper suites in full runs.

test('frontend extension lifecycle cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/loader.lifecycle.isolated.ts',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`Isolated lifecycle tests failed:\n${stdout}\n${stderr}`)
  }
  expect(exitCode).toBe(0)
  expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/)
}, 15_000)

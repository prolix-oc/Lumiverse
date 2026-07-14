import { expect, test } from 'bun:test'

// The isolated companion uses Bun's process-global mock registry. Keep those
// mocks from poisoning the real preset-editor-helper suite in combined runs.
test('placement helper cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/spindle/placement-helper.isolated.ts',
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
    throw new Error(`Isolated placement-helper tests failed:\n${stdout}\n${stderr}`)
  }
  expect(exitCode).toBe(0)
  expect(`${stdout}\n${stderr}`).toMatch(/\b[1-9]\d* pass\b/)
}, 15_000)

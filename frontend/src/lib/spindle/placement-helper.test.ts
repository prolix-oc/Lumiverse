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
  // A real-clock watchdog is required because fake timers cannot terminate a child Bun process.
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const summary = `${stdout}\n${stderr}`
    const summaryLines = summary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+ (?:pass|fail|skip)$/.test(line))
    if (timedOut) {
      throw new Error(`Isolated placement-helper tests timed out after 10_000 ms:\n${summary}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated placement-helper tests failed with exit code ${exitCode}:\n${summary}`)
    }
    if (!summaryLines.every((line, index) => line === ['21 pass', '0 fail'][index]) || summaryLines.length !== 2) {
      throw new Error(`Isolated placement-helper tests reported unexpected counts: ${summaryLines.join(', ')}\n${summary}`)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(summaryLines).toEqual(['21 pass', '0 fail'])
    expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
    expect(summary).toMatch(/Ran 21 tests across 1 file/)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)

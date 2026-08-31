import { expect, test } from 'bun:test'

// The authority fixture installs a process-global store mock. Keep it in a
// child process so it cannot poison neighboring suites in a grouped run.
test('generation recovery authority cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/lib/generation-recovery.isolated.ts',
  ], {
    cwd: `${import.meta.dir}/../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // The child is an external process, so only a wall-clock watchdog can bound
  // a hang; deterministic fake timers cannot observe its exit.
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill()
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
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(summaryLines).toEqual(['20 pass', '0 fail'])
    expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
    expect(summary).toMatch(/Ran 20 tests across 1 file/)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)

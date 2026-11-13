import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./cssModuleRegistry.ts', import.meta.url)).text()

describe('CSS module registry Vite contract', () => {
  test('keeps component discovery as unconditional literal Vite macro calls', () => {
    expect(source).toContain("import.meta.glob('/src/**/*.module.css', { eager: false })")
    expect(source).toContain("import.meta.glob('/src/**/*.tsx', { eager: false })")
    expect(source).not.toContain('typeof import.meta.glob')
  })

  test('Vite expands the globs into a populated native component registry', async () => {
    const child = Bun.spawn([
      process.execPath,
      'test',
      './src/lib/cssModuleRegistry.vite.isolated.ts',
    ], {
      cwd: `${import.meta.dir}/../..`,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const watchdog = setTimeout(() => child.kill(9), 14_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = `${stdout}\n${stderr}`
      try {
        expect(exitCode).toBe(0)
        expect(output).toMatch(/\b1 pass\b/)
        expect(output).toMatch(/\b0 fail\b/)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Isolated Vite registry test failed (${detail}):\n${output}`)
      }
    } finally {
      clearTimeout(watchdog)
    }
  }, 15_000)
})

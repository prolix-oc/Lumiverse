import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skipIf(process.platform !== 'darwin')('Core Audio setup excludes hardware inputs and preserves mono and stereo tap buffers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lumiverse-coreaudio-test-'))
  try {
    const binary = join(directory, 'coreaudio-test')
    const fixture = new URL('./fixtures/system-audio-coreaudio.m', import.meta.url).pathname
    const compiled = Bun.spawnSync([
      'clang', '-fobjc-arc', '-fblocks', fixture, '-framework', 'Cocoa', '-framework', 'CoreAudio', '-o', binary,
    ])
    expect(compiled.stderr.toString()).toBe('')
    expect(compiled.exitCode).toBe(0)
    const result = Bun.spawnSync([binary])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('tap-only setup and callback checks passed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

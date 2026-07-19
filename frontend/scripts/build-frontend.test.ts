import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promoteFrontendBuild, recoverInterruptedBuild, resolveViteRuntime } from './build-frontend'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumiverse-frontend-build-'))
  tempDirs.push(dir)
  return dir
}

function writeBuild(dir: string, marker: string, complete = true): void {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), marker)
  writeFileSync(join(dir, 'assets', 'index.js'), marker)
  if (complete) writeFileSync(join(dir, 'sw.js'), marker)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('atomic frontend build promotion', () => {
  test('uses Android-aware Node to select native bindings on Termux', () => {
    expect(resolveViteRuntime(
      { LUMIVERSE_IS_TERMUX: 'true' },
      '/home/user/.bun/bin/bun',
      '/data/data/com.termux/files/usr/bin/node',
    )).toBe('/data/data/com.termux/files/usr/bin/node')
  })

  test('keeps Bun as the Vite runtime outside Termux-like environments', () => {
    expect(resolveViteRuntime({}, '/home/user/.bun/bin/bun', '/usr/bin/node'))
      .toBe('/home/user/.bun/bin/bun')
  })

  test('restores the previous bundle after an interrupted directory swap', () => {
    const root = makeTempDir()
    const staged = join(root, '.dist-build-stale')
    const backup = join(root, '.dist-backup-stale')
    const dist = join(root, 'dist')
    writeBuild(staged, 'partial')
    writeBuild(backup, 'old')

    recoverInterruptedBuild(root, dist)

    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  test('replaces dist only after the staged bundle validates', () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new')
    writeBuild(dist, 'old')

    promoteFrontendBuild(staged, dist, backup)

    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('new')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  test('preserves the existing dist when validation fails', () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new', false)
    writeBuild(dist, 'old')

    expect(() => promoteFrontendBuild(staged, dist, backup)).toThrow('missing sw.js')
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })
})

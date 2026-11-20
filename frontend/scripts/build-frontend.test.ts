import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { rename } from 'fs/promises'
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

function writeMappedBuild(dir: string): void {
  writeBuild(dir, 'new')
  const json = JSON.stringify({ imports: { '/assets/stable.js': '/assets/index.js' } })
  writeFileSync(join(dir, 'importmap.json'), json)
  for (const entry of ['index.html', 'widget.html']) {
    writeFileSync(join(dir, entry), `<script type="importmap">${json}</script>`)
  }
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

  test('restores the previous bundle after an interrupted directory swap', async () => {
    const root = makeTempDir()
    const staged = join(root, '.dist-build-stale')
    const backup = join(root, '.dist-backup-stale')
    const dist = join(root, 'dist')
    writeBuild(staged, 'partial')
    writeBuild(backup, 'old')

    await recoverInterruptedBuild(root, dist)

    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  test('replaces dist only after the staged bundle validates', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new')
    writeBuild(dist, 'old')

    await promoteFrontendBuild(staged, dist, backup)

    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('new')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  test('preserves the existing dist when validation fails', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new', false)
    writeBuild(dist, 'old')

    await expect(promoteFrontendBuild(staged, dist, backup)).rejects.toThrow('missing sw.js')
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  for (const missing of ['importmap.json', 'assets/index.js']) {
    test(`preserves the previous build when a mapped bundle lacks ${missing}`, async () => {
      const root = makeTempDir()
      const staged = join(root, 'staged')
      const dist = join(root, 'dist')
      writeMappedBuild(staged)
      writeBuild(dist, 'old')
      rmSync(join(staged, missing))
      await expect(promoteFrontendBuild(staged, dist, join(root, 'backup'))).rejects.toThrow('incomplete')
      expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    })
  }

  test('rejects a widget whose inline map belongs to a different build', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    writeMappedBuild(staged)
    writeFileSync(join(staged, 'widget.html'), '<script type="importmap">{"imports":{}}</script>')
    await expect(promoteFrontendBuild(staged, join(root, 'dist'), join(root, 'backup')))
      .rejects.toThrow('widget.html import map differs')
  })

  test('Windows fallback promotes assets, map, both HTML entries, then the worker', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeMappedBuild(staged)
    writeBuild(dist, 'old')
    const promoted: string[] = []
    const renamePath: typeof rename = async (source, destination) => {
      if (source === dist && destination === backup) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      promoted.push(destination.slice(dist.length + 1))
      return rename(source, destination)
    }
    await promoteFrontendBuild(staged, dist, backup, { platform: 'win32', renamePath, sleep: async () => {} })
    expect(promoted).toEqual(['assets/index.js', 'importmap.json', 'index.html', 'widget.html', 'sw.js'])
  })

  test('atomically copies files when a transient Windows lock blocks the directory rename', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new')
    writeBuild(dist, 'old')
    writeFileSync(join(dist, 'assets', 'old-hash.js'), 'old asset retained for active clients')

    const renamePath: typeof rename = async (source, destination) => {
      if (source === dist && destination === backup) {
        throw Object.assign(new Error('directory is in use'), { code: 'EPERM' })
      }
      return rename(source, destination)
    }

    await promoteFrontendBuild(staged, dist, backup, {
      platform: 'win32',
      renamePath,
      sleep: async () => {},
    })

    expect(readFileSync(join(dist, 'assets', 'index.js'), 'utf8')).toBe('new')
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('new')
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).toBe('new')
    expect(existsSync(join(dist, 'assets', 'old-hash.js'))).toBe(true)
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  test('leaves the live entry points unchanged when the Windows copy fallback fails', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new')
    writeBuild(dist, 'old')

    const renamePath: typeof rename = async (source, destination) => {
      if (source === dist && destination === backup) {
        throw Object.assign(new Error('directory is in use'), { code: 'EPERM' })
      }
      if (source.includes('assets/index.js.build-')) {
        throw Object.assign(new Error('file is in use'), { code: 'EPERM' })
      }
      return rename(source, destination)
    }

    await expect(promoteFrontendBuild(staged, dist, backup, {
      platform: 'win32',
      renamePath,
      sleep: async () => {},
    })).rejects.toThrow('file is in use')

    expect(readFileSync(join(dist, 'assets', 'index.js'), 'utf8')).toBe('old')
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).toBe('old')
  })

  test('does not copy over dist after a non-transient Windows rename error', async () => {
    const root = makeTempDir()
    const staged = join(root, 'staged')
    const dist = join(root, 'dist')
    const backup = join(root, 'backup')
    writeBuild(staged, 'new')
    writeBuild(dist, 'old')

    const renamePath: typeof rename = async (source, destination) => {
      if (source === dist && destination === backup) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
      return rename(source, destination)
    }

    await expect(promoteFrontendBuild(staged, dist, backup, {
      platform: 'win32',
      renamePath,
      sleep: async () => {},
    })).rejects.toThrow('disk full')

    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe('old')
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).toBe('old')
  })
})

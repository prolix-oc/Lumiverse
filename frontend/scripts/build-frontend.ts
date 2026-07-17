import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { basename, join, resolve } from 'path'

const REQUIRED_BUILD_FILES = ['index.html', 'sw.js'] as const

function assertUsableBuild(buildDir: string): void {
  for (const file of REQUIRED_BUILD_FILES) {
    const path = join(buildDir, file)
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Frontend build is incomplete: missing ${file}`)
    }
  }

  const assetsDir = join(buildDir, 'assets')
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory() || readdirSync(assetsDir).length === 0) {
    throw new Error('Frontend build is incomplete: assets directory is empty')
  }
}

export function recoverInterruptedBuild(frontendDir: string, distDir: string): void {
  const entries = readdirSync(frontendDir)
  const stagedDirs = entries
    .filter((name) => name.startsWith('.dist-build-'))
    .map((name) => join(frontendDir, name))
  const backupDirs = entries
    .filter((name) => name.startsWith('.dist-backup-'))
    .map((name) => join(frontendDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  // A process can be killed between moving dist aside and promoting the new
  // output. Restore the newest prior bundle before cleaning stale work dirs.
  if (!existsSync(distDir) && backupDirs.length > 0) {
    renameSync(backupDirs.shift()!, distDir)
  }

  for (const dir of [...stagedDirs, ...backupDirs]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Promote a validated Vite output directory without exposing a partial bundle.
 * The prior dist is restored if either rename fails.
 */
export function promoteFrontendBuild(stagedDir: string, distDir: string, backupDir: string): void {
  let movedPreviousBuild = false
  try {
    assertUsableBuild(stagedDir)

    if (existsSync(distDir)) {
      rmSync(backupDir, { recursive: true, force: true })
      renameSync(distDir, backupDir)
      movedPreviousBuild = true
    }

    renameSync(stagedDir, distDir)
  } catch (error) {
    if (!existsSync(distDir) && movedPreviousBuild && existsSync(backupDir)) {
      renameSync(backupDir, distDir)
      movedPreviousBuild = false
    }
    throw error
  } finally {
    rmSync(stagedDir, { recursive: true, force: true })
    if (!movedPreviousBuild || existsSync(distDir)) {
      rmSync(backupDir, { recursive: true, force: true })
    }
  }
}

async function buildFrontend(): Promise<void> {
  const frontendDir = resolve(import.meta.dir, '..')
  const nonce = `${process.pid}-${Date.now()}`
  const stagedDir = join(frontendDir, `.dist-build-${nonce}`)
  const backupDir = join(frontendDir, `.dist-backup-${nonce}`)
  const distDir = join(frontendDir, 'dist')
  const viteCli = join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js')

  recoverInterruptedBuild(frontendDir, distDir)
  rmSync(stagedDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })

  console.log(`Building frontend into ${basename(stagedDir)}...`)
  const proc = Bun.spawn([process.execPath, viteCli, 'build', '--outDir', stagedDir, '--emptyOutDir'], {
    cwd: frontendDir,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    rmSync(stagedDir, { recursive: true, force: true })
    throw new Error(`Vite build failed with exit code ${exitCode}`)
  }

  promoteFrontendBuild(stagedDir, distDir, backupDir)
  console.log('Frontend bundle validated and installed atomically.')
}

if (import.meta.main) {
  await buildFrontend()
}

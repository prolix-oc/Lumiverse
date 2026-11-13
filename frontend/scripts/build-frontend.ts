import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs'
import { rename } from 'fs/promises'
import { basename, dirname, join, relative, resolve } from 'path'

const REQUIRED_BUILD_FILES = ['index.html', 'sw.js'] as const

/**
 * Keep the Windows-only retry helper out of non-Windows frontend builds. In
 * particular, Docker copies only `frontend/` into its Linux build stage.
 */
type RenameRetryOptions = {
  platform?: NodeJS.Platform
  sleep?: (milliseconds: number) => Promise<void>
}

async function retryWindowsRename<T>(
  operation: () => Promise<T> | T,
  options: RenameRetryOptions = {},
): Promise<T> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return operation()

  const { retryWindowsRename: retry } = await import('../../scripts/windows-fs-retry')
  return retry(operation, options.sleep ? { platform, sleep: options.sleep } : { platform })
}

type PromoteFrontendBuildOptions = RenameRetryOptions & {
  renamePath?: typeof rename
}

function buildFilesInPromotionOrder(buildDir: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`Frontend build contains unsupported entry: ${path}`)
    }
  }
  visit(buildDir)

  const priority = (path: string): number => {
    const name = relative(buildDir, path).replaceAll('\\', '/')
    if (name === 'sw.js') return 3
    if (name.endsWith('.html')) return 2
    if (name === 'importmap.json') return 1
    return 0
  }
  return files.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
}

async function copyBuildOverLockedDirectory(
  stagedDir: string,
  distDir: string,
  renameWithRetry: (source: string, destination: string) => Promise<void>,
): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}`

  for (const source of buildFilesInPromotionOrder(stagedDir)) {
    const destination = join(distDir, relative(stagedDir, source))
    const temporary = `${destination}.build-${nonce}.tmp`
    mkdirSync(dirname(destination), { recursive: true })
    rmSync(temporary, { force: true })
    try {
      copyFileSync(source, temporary)
      await renameWithRetry(temporary, destination)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  assertUsableBuild(distDir)
}

export function resolveViteRuntime(
  env: Record<string, string | undefined> = process.env,
  bunExecPath = process.execPath,
  nodeExecPath: string | null = Bun.which('node'),
): string {
  const isTermuxLike = env.LUMIVERSE_IS_TERMUX === 'true' || env.LUMIVERSE_IS_PROOT === 'true'

  // The glibc Bun binary used on native Termux reports itself as Linux, while
  // Termux's Node runtime correctly reports Android. Vite/Rolldown selects its
  // native binding from that platform value, so preserve the pre-wrapper
  // `vite build` behavior and honor Vite's Node runtime on Termux-like hosts.
  return isTermuxLike ? nodeExecPath ?? 'node' : bunExecPath
}

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

  for (const entry of ['index.html', 'widget.html']) {
    const path = join(buildDir, entry)
    if (!existsSync(path)) continue
    const html = readFileSync(path, 'utf8')
    const maps = [...html.matchAll(/<script\b[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)]
    if (maps.length === 0) continue // Explicit compatibility build.
    const mapPath = join(buildDir, 'importmap.json')
    if (!existsSync(mapPath)) throw new Error('Frontend build is incomplete: missing importmap.json')
    const emitted = JSON.parse(readFileSync(mapPath, 'utf8'))
    for (const [, json] of maps) {
      const inline = JSON.parse(json)
      if (JSON.stringify(inline) !== JSON.stringify(emitted)) {
        throw new Error(`Frontend build is incomplete: ${entry} import map differs from importmap.json`)
      }
      if (!inline.imports || typeof inline.imports !== 'object') {
        throw new Error(`Frontend build is incomplete: invalid ${entry} import map`)
      }
      for (const target of Object.values(inline.imports)) {
        if (typeof target !== 'string' || !target.startsWith('/assets/')) {
          throw new Error(`Frontend build is incomplete: invalid import map target ${target}`)
        }
        const asset = resolve(buildDir, `.${target}`)
        if (!relative(assetsDir, asset).startsWith('..') && existsSync(asset) && statSync(asset).isFile()) continue
        throw new Error(`Frontend build is incomplete: missing import map asset ${target}`)
      }
    }
  }
}

export async function recoverInterruptedBuild(frontendDir: string, distDir: string): Promise<void> {
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
    const backupToRestore = backupDirs.shift()!
    await retryWindowsRename(() => rename(backupToRestore, distDir))
  }

  for (const dir of [...stagedDirs, ...backupDirs]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Promote a validated Vite output directory without exposing a partial bundle.
 * The prior dist is restored if either directory rename fails. When Windows
 * locks the live directory, files are replaced atomically with the entry
 * points promoted last so clients never observe an incomplete bundle.
 */
export async function promoteFrontendBuild(
  stagedDir: string,
  distDir: string,
  backupDir: string,
  options: PromoteFrontendBuildOptions = {},
): Promise<void> {
  let movedPreviousBuild = false
  const platform = options.platform ?? process.platform
  const renamePath = options.renamePath ?? rename
  const renameWithRetry = (source: string, destination: string): Promise<void> => retryWindowsRename(
    () => renamePath(source, destination),
    { platform, sleep: options.sleep },
  )
  try {
    assertUsableBuild(stagedDir)

    if (existsSync(distDir)) {
      rmSync(backupDir, { recursive: true, force: true })
      try {
        await renameWithRetry(distDir, backupDir)
        movedPreviousBuild = true
      } catch (error) {
        const isTransientLock = platform === 'win32'
          && (await import('../../scripts/windows-fs-retry')).isTransientWindowsRenameError(error)
        if (isTransientLock) {
          await copyBuildOverLockedDirectory(stagedDir, distDir, renameWithRetry)
          return
        }
        throw error
      }
    }

    await renameWithRetry(stagedDir, distDir)
  } catch (error) {
    if (!existsSync(distDir) && movedPreviousBuild && existsSync(backupDir)) {
      await renameWithRetry(backupDir, distDir)
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

  await recoverInterruptedBuild(frontendDir, distDir)
  rmSync(stagedDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })

  console.log(`Building frontend into ${basename(stagedDir)}...`)
  const proc = Bun.spawn([resolveViteRuntime(), viteCli, 'build', '--outDir', stagedDir, '--emptyOutDir'], {
    cwd: frontendDir,
    env: {
      ...process.env,
      VITE_BUILD_ID: `lumiverse-${Date.now()}`,
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    rmSync(stagedDir, { recursive: true, force: true })
    throw new Error(`Vite build failed with exit code ${exitCode}`)
  }

  await promoteFrontendBuild(stagedDir, distDir, backupDir)
  console.log('Frontend bundle validated and installed atomically.')
}

if (import.meta.main) {
  await buildFrontend()
}

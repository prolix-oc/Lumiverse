import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const FRONTEND_BUILD_STAMP = '.lumiverse-build.json'

/** Hash actual build inputs, including shared runtime sources outside frontend/. */
export function frontendBuildFingerprint(frontendDir: string): string {
  const root = resolve(frontendDir)
  const hash = createHash('sha256')
  const visit = (path: string): void => {
    hash.update(relative(root, path).replaceAll('\\', '/') + '\0')
    if (!existsSync(path)) { hash.update('missing\0'); return }
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name))
    } else {
      const bytes = readFileSync(path)
      hash.update(`${bytes.length}\0`).update(bytes).update('\0')
    }
  }
  for (const path of [
    'src', 'public', 'scripts', '../src/shared', '../src/utils', '../src/image-gen/image-input.ts',
    '../scripts/windows-fs-retry.ts', '../package.json', '../bun.lock',
  ]) {
    visit(resolve(root, path))
  }
  for (const name of readdirSync(root).sort()) {
    if (/^(?:.*\.(?:html|json|toml|[cm]?[jt]s)|bun\.lock|\.env(?:\..*)?)$/.test(name)
      && statSync(join(root, name)).isFile()) visit(join(root, name))
  }
  for (const name of ['LUMIVERSE_CHUNK_IMPORT_MAP', 'LUMIVERSE_REACT_COMPILER']) {
    hash.update(`${name}=${process.env[name] ?? ''}\0`)
  }
  return hash.digest('hex')
}

export function frontendBuildIsCurrent(frontendDir: string): boolean {
  try {
    const dist = join(frontendDir, 'dist')
    if (!['index.html', 'sw.js', 'assets'].every(name => existsSync(join(dist, name)))) return false
    const stamp = JSON.parse(readFileSync(join(dist, FRONTEND_BUILD_STAMP), 'utf8'))
    return stamp.inputHash === frontendBuildFingerprint(frontendDir)
  } catch {
    return false
  }
}

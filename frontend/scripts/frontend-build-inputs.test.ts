import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRONTEND_BUILD_STAMP, frontendBuildFingerprint, frontendBuildIsCurrent } from './frontend-build-inputs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'frontend-fingerprint-'))
  roots.push(root)
  const frontend = join(root, 'frontend')
  for (const path of ['frontend/src', 'src/shared', 'frontend/dist/assets']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(frontend, 'src/main.ts'), 'import shared from "../../src/shared/runtime"')
  writeFileSync(join(root, 'src/shared/runtime.ts'), 'export default 1')
  writeFileSync(join(frontend, 'dist/index.html'), 'old')
  writeFileSync(join(frontend, 'dist/sw.js'), 'old')
  const stamp = () => writeFileSync(join(frontend, 'dist', FRONTEND_BUILD_STAMP), JSON.stringify({ inputHash: frontendBuildFingerprint(frontend) }))
  return { root, frontend, stamp }
}

test('compares the last installed build to shared runtime changes without a Git diff', () => {
  const { root, frontend, stamp } = fixture()
  stamp()
  expect(frontendBuildIsCurrent(frontend)).toBe(true)
  writeFileSync(join(root, 'src/shared/runtime.ts'), 'export default 2')
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
  // Moving HEAD or retrying an update cannot consume an unsuccessful build.
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
  stamp()
  expect(frontendBuildIsCurrent(frontend)).toBe(true)
})

test('detects unstamped, damaged, or removed build output', () => {
  const { frontend, stamp } = fixture()
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
  stamp()
  writeFileSync(join(frontend, 'dist', FRONTEND_BUILD_STAMP), 'invalid')
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
  stamp()
  rmSync(join(frontend, 'dist/sw.js'))
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
})

test('ignores dist churn but detects new and deleted build inputs', () => {
  const { frontend, stamp } = fixture()
  stamp()
  writeFileSync(join(frontend, 'dist/assets/new.js'), 'output')
  expect(frontendBuildIsCurrent(frontend)).toBe(true)
  writeFileSync(join(frontend, 'vite.config.ts'), 'new config')
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
  stamp()
  rmSync(join(frontend, 'src/main.ts'))
  expect(frontendBuildIsCurrent(frontend)).toBe(false)
})

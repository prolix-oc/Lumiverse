import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// projectWorldInfoCaptureContext is unit-tested in isolation, so it stays green
// even when nothing calls it. These assert the wiring a branch merge can drop.
const read = (file: string): Promise<string> => readFile(join(import.meta.dir, file), 'utf8')

describe('world-info capture wiring', () => {
  test('worker-host projects captures into the interceptor context', async () => {
    const source = await read('./worker-host.ts')
    expect(source).toContain('from "./world-info-capture"')
    expect(source).toMatch(/const interceptorContext\s*=\s*projectWorldInfoCaptureContext\(/)
  })

  test('worker-runtime advertises the contracts extensions gate on', async () => {
    const source = await read('./worker-runtime.ts')
    const block = source.match(/contracts:\s*Object\.freeze\(\{([\s\S]*?)\}\)/)
    expect(block).not.toBeNull()
    expect(block![1]).toContain('worldInfoActivationCapture: 1')
    expect(block![1]).toContain('worldInfoRuntimePlacement: 1')
  })
})

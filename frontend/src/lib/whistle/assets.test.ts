import { describe, expect, test } from 'bun:test'
import { verifyWhistleAsset } from './assets'
import { WHISTLE_ASSETS } from './config'

describe('bundled Whistle assets', () => {
  for (const [name, asset] of Object.entries(WHISTLE_ASSETS)) {
    test(`${name} matches its pinned size and integrity hash`, async () => {
      const bytes = new Uint8Array(await Bun.file(new URL(`../../../public/${asset.path}`, import.meta.url)).arrayBuffer())
      await expect(verifyWhistleAsset(bytes, asset)).resolves.toBeUndefined()
      const corrupt = bytes.slice()
      corrupt[0] ^= 1
      await expect(verifyWhistleAsset(corrupt, asset)).rejects.toThrow('verified')
      await expect(verifyWhistleAsset(bytes.subarray(1), asset)).rejects.toThrow('incomplete')
    })
  }
})

import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const directory = dirname(require.resolve('deepmerge/package.json'))

// Exercise every distributed entry point so a bundler cannot bypass the patch.
for (const entry of ['dist/cjs.js', 'dist/umd.js']) {
  const merge = require(join(directory, entry)) as typeof import('deepmerge')
  describe(`deepmerge security patch: ${entry}`, () => {
    test('clones an untrusted target without invoking __proto__', () => {
      const target = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
      const result = merge(target, {})
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result.polluted).toBeUndefined()
      expect(Object.hasOwn(result, '__proto__')).toBe(true)
      expect(result.safe).toBe(1)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    test('keeps malicious source, nested and null-prototype values inert', () => {
      const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
      const nullPrototype = Object.assign(Object.create(null), payload)
      for (const result of [merge({}, payload), merge(nullPrototype, {}), merge({ nested: payload }, {}).nested,
        merge({}, { nested: nullPrototype }).nested]) {
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
        expect(result.polluted).toBeUndefined()
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    test('preserves symbols, arrays, dates and custom merging used by build configuration', () => {
      const symbol = Symbol('option')
      const date = new Date('2026-01-01T00:00:00Z')
      const result = merge({ [symbol]: { left: true }, list: [{ left: 1 }], date, options: { left: true } },
        { [symbol]: { right: true }, list: [{ right: 2 }], options: { right: true } })
      expect(result[symbol]).toEqual({ left: true, right: true })
      expect(result.list).toEqual([{ left: 1 }, { right: 2 }])
      expect(result.date).toBe(date)
      expect(result.options).toEqual({ left: true, right: true })
      expect(merge({ list: [1] }, { list: [2] }, { arrayMerge: (_target, source) => source })).toEqual({ list: [2] })
      expect(merge({ options: { left: true } }, { options: { right: true } }, {
        customMerge: key => key === 'options' ? () => ({ replaced: true }) : undefined,
      })).toEqual({ options: { replaced: true } })
    })
  })
}

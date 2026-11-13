import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { getHostSurfaceRenderer, registerHostSurfaceRenderer } from './host-surface-registry'

test('renderer cleanup permits module replacement while keeping duplicate ownership checks', () => {
  const renderer = () => createElement('div')
  const stopOld = registerHostSurfaceRenderer('character_card', renderer)
  expect(() => registerHostSurfaceRenderer('character_card', renderer)).toThrow('DUPLICATE_RENDERER')
  expect(getHostSurfaceRenderer('character_card')).toBe(renderer)
  stopOld()
  expect(getHostSurfaceRenderer('character_card')).toBeUndefined()
  const stopNew = registerHostSurfaceRenderer('character_card', renderer)
  try {
    stopOld()
    expect(getHostSurfaceRenderer('character_card')).toBe(renderer)
  } finally { stopNew() }
  expect(getHostSurfaceRenderer('character_card')).toBeUndefined()
})

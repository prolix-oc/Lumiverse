import { expect, test } from 'bun:test'
import type { NavigateFunction, NavigateOptions, To } from 'react-router'
import { installAppNavigation, navigateApp } from './app-navigation'

test('detached navigation forwards destinations, options, history deltas and completion', async () => {
  const calls: unknown[][] = []
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  const navigate: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
    calls.push([to, options])
    return completion
  }
  const stop = installAppNavigation(navigate)
  try {
    expect(navigateApp('/characters', { replace: true })).toBe(completion)
    expect(navigateApp({ pathname: '/chat/fixture', search: '?view=latest' })).toBe(completion)
    expect(navigateApp(-1)).toBe(completion)
    expect(calls).toEqual([
      ['/characters', { replace: true }],
      [{ pathname: '/chat/fixture', search: '?view=latest' }, undefined],
      [-1, undefined],
    ])
    finish()
    await completion
  } finally { stop() }
  expect(() => navigateApp('/')).toThrow('not initialized')
})

test('disposing an older navigation adapter leaves its replacement installed', () => {
  const stopOld = installAppNavigation(() => { throw new Error('obsolete adapter') })
  let destination: unknown
  const stopNew = installAppNavigation((to: To | number) => { destination = to })
  try {
    stopOld()
    navigateApp('/characters')
    expect(destination).toBe('/characters')
  } finally { stopNew() }
})

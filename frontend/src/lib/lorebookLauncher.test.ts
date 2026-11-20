import { beforeEach, describe, expect, mock, test } from 'bun:test'

const storeState = {
  extensions: [{ id: 'suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }],
  inputBarActions: [] as Array<{
    extensionId: string
    contributionId: string
    enabled: boolean
    externallyInvocable?: boolean
    payloadVersion?: number
    clickHandlers: Set<(payload: unknown) => void>
  }>,
  loreIndicatorSettings: { editorLaunchTarget: 'native' },
}

const useStore = (() => null) as unknown as { getState: () => typeof storeState }
useStore.getState = () => storeState
mock.module('@/store', () => ({ useStore }))

const { launchLorebookEditor } = await import('./lorebookLauncher')

describe('lorebook extension launcher', () => {
  beforeEach(() => {
    storeState.extensions[0].enabled = true
    storeState.inputBarActions = []
  })

  test('falls back only when the requested extension action is unavailable', () => {
    expect(launchLorebookEditor({ bookId: 'book-a', preferredTarget: 'full' })).toBe(false)
  })

  test('propagates a throwing extension handler instead of opening the native fallback', () => {
    storeState.inputBarActions = [{
      extensionId: 'suite',
      contributionId: 'lumiverse_suite.lorebook.open_enhanced',
      enabled: true,
      clickHandlers: new Set([() => { throw new Error('extension launch failed') }]),
    }]

    expect(() => launchLorebookEditor({ bookId: 'book-a', preferredTarget: 'full' }))
      .toThrow('extension launch failed')
  })

  test('does not invoke a retained action after its owner is disabled', () => {
    let calls = 0
    storeState.inputBarActions = [{
      extensionId: 'suite',
      contributionId: 'lumiverse_suite.lorebook.open_enhanced',
      enabled: true,
      clickHandlers: new Set([() => { calls += 1 }]),
    }]
    storeState.extensions[0].enabled = false

    expect(launchLorebookEditor({ bookId: 'book-a', preferredTarget: 'full' })).toBe(false)
    expect(calls).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import type { UISlice } from '@/types/store'
import { createUISlice } from './ui'
import { resolveCouncilTabId } from '@/lib/council-navigation'

describe('Council drawer redirects', () => {
  for (const [tab, view] of [['ooc', 'ooc'], ['feedback', 'feedback']] as const) {
    test(`${tab} opens Council's ${view} view`, () => {
      const store = createStore<UISlice>()(createUISlice)
      store.getState().openDrawer(tab)
      expect(store.getState().drawerOpen).toBe(true)
      expect(store.getState().drawerTab).toBe('council')
      expect(store.getState().councilView).toBe(view)
      store.getState().setCouncilView('setup')
      store.getState().setDrawerTab(tab)
      expect(store.getState().councilView).toBe(view)
      expect(store.getState().drawerTab).toBe('council')
    })
  }
  test('reopening Council preserves its view and unrelated tabs keep their IDs', () => {
    const store = createStore<UISlice>()(createUISlice)
    store.getState().openDrawer('ooc')
    store.getState().openDrawer('create')
    expect(store.getState().drawerTab).toBe('create')
    store.getState().openDrawer('council')
    expect(store.getState().councilView).toBe('ooc')
    store.getState().openDrawer('prompt')
    expect(store.getState().drawerTab).toBe('prompt')
    expect(store.getState().councilView).toBe('ooc')
    expect(resolveCouncilTabId('toString')).toBe('toString')
  })
})

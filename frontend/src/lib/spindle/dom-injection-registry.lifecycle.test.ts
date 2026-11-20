/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

type TestState = { messages: Array<{ id: string }> }
let state: TestState = { messages: [] }
const subscribers = new Set<(state: TestState, previous: TestState) => void>()
mock.module('@/store', () => ({ useStore: {
  getState: () => state,
  subscribe: (listener: (state: TestState, previous: TestState) => void) => {
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  },
} }))
const jsdom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: jsdom.window, document: jsdom.window.document,
  Element: jsdom.window.Element, HTMLElement: jsdom.window.HTMLElement, Node: jsdom.window.Node,
  MutationObserver: jsdom.window.MutationObserver, navigator: jsdom.window.navigator, localStorage: jsdom.window.localStorage })
const { createDOMHelper } = await import('./dom-helper')
const { replay, scheduleReplay } = await import('./dom-injection-registry')
const { getLiveRootRecords } = await import('./live-root-registry')
const extensionId = '00000000-0000-0000-0000-000000000091'
const helpers: ReturnType<typeof createDOMHelper>[] = []

function messages(ids: string[]) {
  const previous = state
  state = { messages: ids.map(id => ({ id })) }
  for (const subscriber of subscribers) subscriber(state, previous)
}
function mount(id: string) {
  const row = document.createElement('div')
  row.setAttribute('data-message-id', id)
  row.innerHTML = '<article><div class="scene">Scene content retained by the old message tree</div></article>'
  document.body.append(row)
  return row
}
function helper() {
  const result = createDOMHelper(extensionId, 'lifecycle_fixture')
  helpers.push(result)
  return result
}
afterEach(() => {
  messages([])
  for (const item of helpers.splice(0)) item.cleanup()
  document.body.replaceChildren()
})

describe('message injection lifecycle', () => {
  test('releases the helper root and detached message ancestry when navigating Home', () => {
    messages(['message-1'])
    const dom = helper()
    const row = mount('message-1')
    const wrapper = dom.inject(row, '<input value="tracker state">')
    row.remove()
    messages([])

    expect(getLiveRootRecords(extensionId)).toHaveLength(0)
    expect(wrapper.parentNode === null).toBe(true)
  })

  test('releases deleted messages while preserving virtualization state for remaining messages', () => {
    messages(['deleted', 'kept'])
    const dom = helper()
    const removedRow = mount('deleted')
    const keptRow = mount('kept')
    const removed = dom.inject(removedRow, '<span>Removed tracker</span>')
    const kept = dom.inject(keptRow, '<input value="original">')
    kept.querySelector('input')!.value = 'edited draft'
    removedRow.remove()
    keptRow.remove()
    messages(['kept'])
    const remounted = mount('kept')
    replay('kept', remounted)

    expect(removed.parentNode === null).toBe(true)
    expect(getLiveRootRecords(extensionId).map(record => record.root === kept)).toEqual([true])
    expect(kept.parentNode === remounted).toBe(true)
    expect(kept.querySelector('input')!.value).toBe('edited draft')
  })

  test('a queued replay cannot recreate an injection after its message leaves the store', async () => {
    messages(['message-1'])
    const dom = helper()
    const oldRow = mount('message-1')
    dom.inject(oldRow, '<span>Tracker</span>')
    oldRow.remove()
    const fresh = mount('message-1')
    scheduleReplay('message-1', fresh)
    messages([])
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(fresh.querySelector('[data-spindle-inj-id]') === null).toBe(true)
    expect(getLiveRootRecords(extensionId)).toHaveLength(0)
  })

  test('explicit uninject remains idempotent after the host retires the message', () => {
    messages(['message-1'])
    const dom = helper()
    const wrapper = dom.inject(mount('message-1'), '<span>Tracker</span>')
    messages([])
    dom.uninject(wrapper)
    dom.uninject(wrapper)
    const fresh = mount('message-1')
    replay('message-1', fresh)

    expect(wrapper.parentNode === null).toBe(true)
    expect(fresh.querySelector('[data-spindle-inj-id]') === null).toBe(true)
    expect(getLiveRootRecords(extensionId)).toHaveLength(0)
  })
})

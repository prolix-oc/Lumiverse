import { afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import { installLorebookContentResizeTracking } from '../../src/modules/lorebook_workspace/content-resize'

let dom: JSDOM | undefined

class MockResizeObserver implements ResizeObserver {
  static readonly callbacks = new Map<Element, ResizeObserverCallback>()

  readonly callback: ResizeObserverCallback
  readonly observed = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    this.observed.add(target)
    MockResizeObserver.callbacks.set(target, this.callback)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
    MockResizeObserver.callbacks.delete(target)
  }

  disconnect(): void {
    for (const target of this.observed) MockResizeObserver.callbacks.delete(target)
    this.observed.clear()
  }

  static resize(target: Element, height: number): void {
    const callback = this.callbacks.get(target)
    if (!callback) throw new Error('textarea was not observed')
    callback([{
      target,
      contentRect: { height } as DOMRectReadOnly,
      borderBoxSize: [{ blockSize: height, inlineSize: 480 } as ResizeObserverSize],
    } as unknown as ResizeObserverEntry], {} as ResizeObserver)
  }
}

afterEach(() => {
  MockResizeObserver.callbacks.clear()
  dom?.window.close()
  dom = undefined
})

describe('lorebook workspace Content resize tracking', () => {
  test('moves the disclosure stack with the textarea and restores styles on teardown', () => {
    dom = new JSDOM(`<!doctype html><html><body>
      <div data-component="LorebookHalfScreenEditor">
        <div data-world-book-entry-editor="true" data-density="compact">
          <section data-world-book-identity-content="true">
            <div data-content-flex-region="true">
              <div><textarea></textarea></div>
            </div>
          </section>
        </div>
      </div>
    </body></html>`)
    const document = dom.window.document
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const wrapper = textarea.parentElement!
    const field = textarea.closest<HTMLElement>('[data-content-flex-region]')!
    const section = textarea.closest<HTMLElement>('[data-world-book-identity-content]')!
    const stop = installLorebookContentResizeTracking(document.body, {
      ResizeObserver: MockResizeObserver,
      MutationObserver: dom.window.MutationObserver,
      layoutElementRect: (element) => ({ height: element === wrapper ? 400 : 0 }),
    })

    MockResizeObserver.resize(textarea, 400)
    expect(section.dataset.contentUserSized).toBeUndefined()

    MockResizeObserver.resize(textarea, 260)
    expect(section.dataset.contentUserSized).toBe('true')
    expect(section.style.flex).toBe('0 0 auto')
    expect(field.style.flex).toBe('0 0 auto')
    expect(wrapper.style.height).toBe('260px')
    expect(wrapper.style.flex).toBe('0 0 260px')

    MockResizeObserver.resize(textarea, 220)
    expect(wrapper.style.height).toBe('220px')

    stop()
    expect(section.dataset.contentUserSized).toBeUndefined()
    expect(section.style.flex).toBe('')
    expect(field.style.flex).toBe('')
    expect(wrapper.style.height).toBe('')
    expect(wrapper.style.flex).toBe('')
  })

  test('follows the native inline textarea height without host geometry or an outer mount marker', async () => {
    dom = new JSDOM(`<!doctype html><html><body>
      <div data-world-book-entry-editor="true" data-density="compact">
        <section data-world-book-identity-content="true">
          <div data-content-flex-region="true">
            <div><textarea></textarea></div>
          </div>
        </section>
      </div>
    </body></html>`)
    const document = dom.window.document
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const wrapper = textarea.parentElement!
    const section = textarea.closest<HTMLElement>('[data-world-book-identity-content]')!
    const stop = installLorebookContentResizeTracking(document.body, {
      ResizeObserver: MockResizeObserver,
      MutationObserver: dom.window.MutationObserver,
    })

    textarea.style.height = '272px'
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0))

    expect(section.dataset.contentUserSized).toBe('true')
    expect(wrapper.style.height).toBe('272px')
    expect(wrapper.style.flex).toBe('0 0 272px')

    textarea.style.height = '220px'
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0))
    expect(wrapper.style.height).toBe('220px')

    stop()
    expect(wrapper.style.height).toBe('')
    expect(wrapper.style.flex).toBe('')
  })
})

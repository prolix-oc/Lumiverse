import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  act,
  createElement,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(
  '<!doctype html><html><body></body></html>',
  {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  },
)

const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalElement = globalThis.Element
const originalHTMLElement = globalThis.HTMLElement
const originalNode = globalThis.Node
const originalEvent = globalThis.Event
const originalMouseEvent = globalThis.MouseEvent
const originalDOMParser = globalThis.DOMParser
const originalNavigator = globalThis.navigator
const originalFetch = globalThis.fetch

mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({
    isOpen,
    children,
  }: {
    isOpen: boolean
    children: ReactNode
  }) =>
    isOpen
      ? createElement(
          'div',
          { 'data-testid': 'guide-modal' },
          children,
        )
      : null,
}))

mock.module('@/components/shared/CloseButton', () => ({
  CloseButton: ({
    onClick,
  }: {
    onClick: () => void
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick,
        'aria-label': 'Close',
      },
      'Close',
    ),
}))

let GuideViewer:
  typeof import('./GuideViewer').GuideViewer

beforeAll(async () => {
  const domWindow =
    dom.window as unknown as Window & typeof globalThis

  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    MouseEvent: domWindow.MouseEvent,
    DOMParser: domWindow.DOMParser,
  })

  Object.defineProperty(
    globalThis,
    'navigator',
    {
      configurable: true,
      value: domWindow.navigator,
    },
  )

  ;(
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean
    }
  ).IS_REACT_ACT_ENVIRONMENT = true

  ;({ GuideViewer } = await import('./GuideViewer'))
})

afterAll(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    document: originalDocument,
    Element: originalElement,
    HTMLElement: originalHTMLElement,
    Node: originalNode,
    Event: originalEvent,
    MouseEvent: originalMouseEvent,
    DOMParser: originalDOMParser,
    fetch: originalFetch,
  })

  Object.defineProperty(
    globalThis,
    'navigator',
    {
      configurable: true,
      value: originalNavigator,
    },
  )
})

async function waitForText(
  container: HTMLElement,
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) {
      return
    }

    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, 0),
      )
    })
  }

  throw new Error(
    `Timed out waiting for "${text}". ` +
      `Rendered: ${container.textContent}`,
  )
}

describe('GuideViewer builtin navigation', () => {
  test(
    'allows internal navigation but resets when the builtin guide changes',
    async () => {
      const responses = [
        [
          '# CHARACTERS ROOT BODY',
          '',
          '[Open child](child.md#details)',
        ].join('\n'),
        '# CHARACTERS CHILD BODY\n\n## Details',
        '# REGEX ROOT BODY',
      ]

      const requestedUrls: string[] = []

      globalThis.fetch = (async (input) => {
        if (String(input).endsWith('/catalog')) return Response.json([])
        requestedUrls.push(String(input))

        const markdown = responses.shift()

        if (!markdown) {
          throw new Error(
            `Unexpected guide request: ${String(input)}`,
          )
        }

        return new Response(markdown, {
          status: 200,
          headers: {
            'Content-Type': 'text/markdown',
          },
        })
      }) as typeof fetch

      const container =
        document.createElement('div')

      document.body.append(container)

      const root = createRoot(container)

      try {
        await act(async () => {
          root.render(
            createElement(GuideViewer, {
              isOpen: true,
              onClose: () => {},
              guide: {
                kind: 'builtin',
                path: 'characters/index.md',
              },
              title: 'Characters',
            }),
          )
        })

        await waitForText(
          container,
          'CHARACTERS ROOT BODY',
        )

        const childLink =
          container.querySelector('a')

        expect(childLink).not.toBeNull()
        expect(childLink?.getAttribute('href')).toBe(
          '/guides/characters/child/#details',
        )
        expect(childLink?.getAttribute('href')).not.toContain(
          '.md',
        )

        await act(async () => {
          childLink!.dispatchEvent(
            new dom.window.MouseEvent(
              'click',
              {
                bubbles: true,
                cancelable: true,
              },
            ),
          )
        })

        await waitForText(
          container,
          'CHARACTERS CHILD BODY',
        )

        expect(container.textContent).not.toContain(
          'CHARACTERS ROOT BODY',
        )
        expect(container.querySelector('#details')).not.toBeNull()
        const tabs = container.querySelector('[aria-label="Open guide pages"]')!
        expect(tabs.querySelectorAll('button[aria-controls]')).toHaveLength(2)

        await act(async () => {
          root.render(
            createElement(GuideViewer, {
              isOpen: true,
              onClose: () => {},
              guide: {
                kind: 'builtin',
                path: 'customization/regex-scripts.md',
              },
              title: 'Regex',
            }),
          )
        })

        await waitForText(
          container,
          'REGEX ROOT BODY',
        )

        expect(container.textContent).not.toContain(
          'CHARACTERS CHILD BODY',
        )

        expect(requestedUrls).toHaveLength(3)
      } finally {
        await act(async () => {
          root.unmount()
        })

        container.remove()
      }
    },
  )
})

function click(scope: ParentNode, label: string) {
  const button = Array.from(scope.querySelectorAll('button')).find(
    (element) => element.getAttribute('aria-label') === label || element.textContent === label,
  )
  if (!button) throw new Error('Button not found: ' + label)
  return act(async () => button.click())
}

test('keeps local extension tabs through display changes and widget minimize', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const fetchSpy = mock(async () => { throw new Error('Extension pages should be local') })
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  const scrollSpy = mock(() => {})
  const oldScroll = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scrollSpy

  try {
    await act(async () => root.render(createElement(GuideViewer, {
      isOpen: true,
      onClose: () => {},
      title: 'Extension docs',
      guide: {
        kind: 'markdown',
        markdown: '# Extension home\n\n[Open setup](setup/start.md#details)\n\n[Missing page](unlisted.md)',
        pages: [
          { path: 'setup/start.md', title: 'Setup', markdown: '# Setup guide\n\n## Details\n\n[Return home](../index.md)' },
          { path: 'reference.md', markdown: '# Reference\n\nAbout delegated processing.' },
        ],
      },
    })))

    expect(Array.from(container.querySelectorAll('a[href]')).map((a) => a.textContent)).toEqual(['Open setup'])
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href]')!.click())
    expect(container.textContent).toContain('Setup guide')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    await click(container, 'Guide navigation')
    expect(container.querySelector('nav')?.hidden).toBe(true)
    await click(container, 'Half-dock view')
    expect(document.querySelector('[role="region"]')?.textContent).toContain('Setup guide')
    await click(document, 'Zoom in')
    expect(document.querySelector('[aria-label^="Reset reading zoom"]')?.textContent).toBe('110%')
    await click(document, 'Widget view')
    await click(document, 'Minimize guide widget')
    expect(document.querySelector('[role="region"]')).toBeNull()
    await click(document, 'Expand guide reader: Extension docs')
    expect(document.querySelector('[role="region"]')?.textContent).toContain('Setup guide')
    expect(document.querySelector('[aria-label^="Reset reading zoom"]')?.textContent).toBe('110%')
    const tabs = document.querySelector('[aria-label="Open guide pages"]')!
    await click(tabs, 'Extension docs')
    expect(document.querySelector('[role="region"]')?.textContent).toContain('Extension home')
    await click(tabs, 'Setup')
    await click(tabs, 'Close Setup tab')
    expect(tabs.querySelectorAll('button[aria-controls]')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Back to previous guide"]')?.disabled).toBe(true)
    expect(document.querySelector('[role="region"]')?.textContent).toContain('Extension home')
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    HTMLElement.prototype.scrollIntoView = oldScroll
    globalThis.fetch = originalFetch
  }
})

test('ignores a late document response after navigating back', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const child = Promise.withResolvers<Response>()
  let childSignal: AbortSignal | null | undefined
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/catalog')) return Response.json([])
    if (url.endsWith(btoa('child.md').replace(/=+$/, ''))) {
      childSignal = init?.signal
      return child.promise
    }
    return new Response('# Home document\n\n[Child](child.md)')
  }) as typeof fetch

  try {
    await act(async () => root.render(createElement(GuideViewer, {
      isOpen: true,
      onClose: () => {},
      title: 'Guides',
      guide: { kind: 'builtin', path: 'index.md' },
    })))
    await waitForText(container, 'Home document')
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href]')!.click())
    expect(childSignal?.aborted).toBe(false)
    await click(container, 'Back to previous guide')
    expect(childSignal?.aborted).toBe(true)

    await act(async () => child.resolve(new Response('# Late child response')))
    expect(container.textContent).toContain('Home document')
    expect(container.textContent).not.toContain('Late child response')
  } finally {
    child.resolve(new Response(''))
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  }
})

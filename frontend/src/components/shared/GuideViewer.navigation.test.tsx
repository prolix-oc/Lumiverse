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
        '# CHARACTERS CHILD BODY',
        '# REGEX ROOT BODY',
      ]

      const requestedUrls: string[] = []

      globalThis.fetch = (async (input) => {
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

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type {
  DecisionConnection,
  DecisionConnectionInput,
  DecisionProviderInfo,
} from '@/api/decisions'

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  localStorage: { configurable: true, value: dom.window.localStorage },
  sessionStorage: { configurable: true, value: dom.window.sessionStorage },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLButtonElement: { configurable: true, value: dom.window.HTMLButtonElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  Node: { configurable: true, value: dom.window.Node },
  Event: { configurable: true, value: dom.window.Event },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
})

dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof dom.window.matchMedia

const providerCatalog: DecisionProviderInfo[] = [
  {
    id: 'jev',
    name: 'Jev',
    protocols: ['openai', 'cloudflare'],
    presets: [
      {
        id: 'jev-cloud',
        name: 'Jev Cloud',
        url: 'https://jev.example/v1',
        model: 'jev-1',
        protocol: 'openai',
      },
    ],
  },
]

function makeConnection(
  id: string,
  overrides: Partial<DecisionConnection> = {},
): DecisionConnection {
  return {
    id,
    name: id,
    provider: 'jev',
    gateway: 'jev-cloud',
    protocol: 'openai',
    api_url: 'https://jev.example/v1',
    model: `${id}-model`,
    account_id: '',
    is_default: false,
    has_api_key: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

// Test-controlled replacement for the real REST client. Only this module is
// mocked so the manager and its shared components render for real.
let connectionList: DecisionConnection[] = []
let presetsError: Error | null = null
let listError: Error | null = null
let testResponse: { success: boolean; message: string } = {
  success: true,
  message: 'Connection is working.',
}
let testError: Error | null = null

const recorded = {
  presets: 0,
  list: 0,
  create: [] as DecisionConnectionInput[],
  update: [] as Array<[string, Partial<DecisionConnectionInput>]>,
  duplicate: [] as string[],
  setDefault: [] as string[],
  test: [] as string[],
  delete: [] as string[],
}

mock.module('@/api/decisions', () => ({
  decisionsApi: {
    evaluate: async () => {
      throw new Error('decisionsApi.evaluate is not exercised by this test')
    },
    presets: async () => {
      recorded.presets += 1
      if (presetsError) throw presetsError
      return { providers: providerCatalog }
    },
    previewModels: async () => ({ models: [], model_labels: {} }),
    list: async () => {
      recorded.list += 1
      if (listError) throw listError
      return { data: connectionList }
    },
    create: async (input: DecisionConnectionInput) => {
      recorded.create.push(input)
      return makeConnection('created')
    },
    update: async (id: string, input: Partial<DecisionConnectionInput>) => {
      recorded.update.push([id, input])
      return makeConnection(id)
    },
    duplicate: async (id: string) => {
      recorded.duplicate.push(id)
      return makeConnection(`${id}-copy`)
    },
    setDefault: async (id: string) => {
      recorded.setDefault.push(id)
      return makeConnection(id, { is_default: true })
    },
    test: async (id: string) => {
      recorded.test.push(id)
      if (testError) throw testError
      return testResponse
    },
    delete: async (id: string) => {
      recorded.delete.push(id)
    },
  },
}))

let createRoot: typeof CreateRoot
let DecisionConnectionManager: () => ReactNode
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountManager(): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(<DecisionConnectionManager />)
    await Promise.resolve()
  })
  await flushEffects()

  return host
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  )
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
  await flushEffects()
}

async function openActionsMenu(host: HTMLDivElement, index = 0) {
  const triggers = host.querySelectorAll<HTMLButtonElement>('button[aria-label="More actions"]')
  const trigger = triggers[index]
  if (!trigger) throw new Error(`No actions trigger at index ${index}`)
  await click(trigger)
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

beforeAll(async () => {
  // Dynamic imports are intentional: JSDOM globals and the API mock must be
  // installed before the component (and its shared children) load.
  //
  // A bare i18next instance is initialized so shared children such as
  // ConfirmationModal can call useTranslation without a "no instance" warning.
  // `@/i18n` itself is not used here because it relies on Vite's
  // `import.meta.glob`, and `react-i18next` is deliberately NOT module-mocked:
  // bun:test's `mock.module` is process-global and would leak into other files.
  const { default: i18next } = await import('i18next')
  const { initReactI18next } = await import('react-i18next')
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: {},
      lng: 'en',
      fallbackLng: 'en',
      defaultNS: 'common',
      ns: ['common'],
    })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: DecisionConnectionManager } = await import('./DecisionConnectionManager'))
})

beforeEach(() => {
  connectionList = []
  presetsError = null
  listError = null
  testError = null
  testResponse = { success: true, message: 'Connection is working.' }
  recorded.presets = 0
  recorded.list = 0
  recorded.create = []
  recorded.update = []
  recorded.duplicate = []
  recorded.setDefault = []
  recorded.test = []
  recorded.delete = []
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
})

describe('DecisionConnectionManager', () => {
  test('renders the loaded providers and connections and enables creation', async () => {
    connectionList = [
      makeConnection('primary', { is_default: true }),
      makeConnection('backup'),
    ]

    const host = await mountManager()

    expect(recorded.presets).toBe(1)
    expect(recorded.list).toBe(1)
    expect(host.textContent).toContain('primary')
    expect(host.textContent).toContain('backup')
    expect(host.textContent).toContain('primary-model')

    const createButton = buttonByText(host, 'New Decision Connection')
    expect(createButton).toBeDefined()
    expect(createButton?.disabled).toBe(false)
  })

  test('shows the empty state when the user has no connections', async () => {
    const host = await mountManager()

    expect(host.textContent).toContain('No connections configured.')
    expect(host.querySelector('button[title="Set as default"]')).toBeNull()
  })

  test('surfaces an initial load failure and keeps creation disabled without providers', async () => {
    listError = new Error('Decision service unavailable')

    const host = await mountManager()

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Decision service unavailable',
    )
    expect(buttonByText(host, 'New Decision Connection')?.disabled).toBe(true)
  })

  test('makes a non-default connection the default but never re-defaults the active one', async () => {
    connectionList = [
      makeConnection('primary', { is_default: true }),
      makeConnection('backup'),
    ]

    const host = await mountManager()

    const setDefaultButton = host.querySelector<HTMLButtonElement>(
      'button[title="Set as default"]',
    )
    expect(setDefaultButton).not.toBeNull()
    if (!setDefaultButton) throw new Error('Set-as-default control was not rendered')
    await click(setDefaultButton)
    expect(recorded.setDefault).toEqual(['backup'])

    const defaultLabeled = host.querySelector<HTMLButtonElement>(
      'button[title="Default connection"]',
    )
    expect(defaultLabeled).not.toBeNull()
    if (!defaultLabeled) throw new Error('Default connection control was not rendered')
    await click(defaultLabeled)
    expect(recorded.setDefault).toEqual(['backup'])
  })

  test('reports a successful connection test and a failed one as a status message', async () => {
    connectionList = [makeConnection('primary')]

    const host = await mountManager()
    await openActionsMenu(host)

    const testItem = buttonByText(document.body, 'Test connection')
    expect(testItem).toBeDefined()
    if (!testItem) throw new Error('Test connection menu item was not rendered')
    await click(testItem)

    expect(recorded.test).toEqual(['primary'])
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Connection is working.')

    testError = new Error('Provider rejected the key')
    await openActionsMenu(host)
    const retryItem = buttonByText(document.body, 'Test connection')
    if (!retryItem) throw new Error('Test connection menu item was not rendered on retry')
    await click(retryItem)

    expect(recorded.test).toEqual(['primary', 'primary'])
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Provider rejected the key')
  })

  test('duplicates a connection from the actions menu and refreshes the list', async () => {
    connectionList = [makeConnection('primary')]

    const host = await mountManager()
    expect(recorded.list).toBe(1)

    await openActionsMenu(host)
    const duplicateItem = buttonByText(document.body, 'Duplicate')
    expect(duplicateItem).toBeDefined()
    if (!duplicateItem) throw new Error('Duplicate menu item was not rendered')
    await click(duplicateItem)

    expect(recorded.duplicate).toEqual(['primary'])
    expect(recorded.list).toBe(2)
  })

  test('deletes only after the confirmation modal is confirmed', async () => {
    connectionList = [makeConnection('primary')]

    const host = await mountManager()
    await openActionsMenu(host)

    const deleteItem = buttonByText(document.body, 'Delete')
    expect(deleteItem).toBeDefined()
    if (!deleteItem) throw new Error('Delete menu item was not rendered')
    await click(deleteItem)

    expect(recorded.delete).toEqual([])

    const confirmButton = buttonByText(document.body, 'Delete')
    expect(confirmButton).toBeDefined()
    if (!confirmButton) throw new Error('Delete confirmation was not rendered')
    await click(confirmButton)

    expect(recorded.delete).toEqual(['primary'])
    expect(recorded.list).toBe(2)
  })

  test('opens the create form and only submits once a name and key are present', async () => {
    const host = await mountManager()

    const createButton = buttonByText(host, 'New Decision Connection')
    if (!createButton) throw new Error('Create control was not rendered')
    await click(createButton)

    const nameInput = host.querySelector<HTMLInputElement>('input[placeholder="Connection name"]')
    const keyInput = host.querySelector<HTMLInputElement>('input[placeholder="Enter API key"]')
    const submitButton = buttonByText(host, 'Create')
    expect(nameInput).not.toBeNull()
    expect(keyInput).not.toBeNull()
    expect(submitButton).toBeDefined()
    // A new connection is unsaveable until both the name and a key exist.
    expect(submitButton?.disabled).toBe(true)

    await act(async () => {
      if (nameInput) setInputValue(nameInput, '  Work decisions  ')
      await Promise.resolve()
    })
    expect(buttonByText(host, 'Create')?.disabled).toBe(true)

    await act(async () => {
      if (keyInput) setInputValue(keyInput, 'sk-test')
      await Promise.resolve()
    })
    const enabledSubmit = buttonByText(host, 'Create')
    expect(enabledSubmit?.disabled).toBe(false)

    if (!enabledSubmit) throw new Error('Create control was not enabled')
    await click(enabledSubmit)

    expect(recorded.create).toHaveLength(1)
    expect(recorded.create[0]).toMatchObject({
      name: 'Work decisions',
      provider: 'jev',
      gateway: 'jev-cloud',
      api_key: 'sk-test',
    })
    expect(recorded.list).toBe(2)
  })
})

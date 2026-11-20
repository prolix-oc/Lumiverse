import { afterEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import type { ConnectionProfile } from '@/types/api'
import type { ConnectionPlacement } from '@/lib/connectionPlacement'
import type { ConnectionAccount } from '@/hooks/useConnectionAccount'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import('react-dom/client')
const requests: { provider: string; id: string; resolve(value: unknown): void; reject(error: unknown): void }[] = []
const request = (provider: string, id: string) => new Promise((resolve, reject) => requests.push({ provider, id, resolve, reject }))
const translate = (key: string) => key
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
mock.module('@/hooks/useConnectionLibrary', () => ({ saveConnectionFolder() {} }))
mock.module('@/lib/dndUiScale', () => ({ useScaledSortable: () => ({ attributes: {}, listeners: {}, setNodeRef() {}, style: {}, isDragging: false }) }))
mock.module('./ConnectionForm', () => ({ default: () => null }))
mock.module('../image-gen-connections/ImageGenConnectionForm', () => ({ default: () => null }))
mock.module('../image-gen-connections/ComfyWorkflowEditor', () => ({ ComfyWorkflowEditor: () => null }))
mock.module('./ConnectionItem.module.css', () => ({ default: {} }))
mock.module('@/components/shared/ProviderIcon.module.css', () => ({ default: {} }))
mock.module('@/api/openrouter', () => ({ buildOpenRouterOAuthCallbackUrl: () => '', openrouterApi: { credits: (id: string) => request('openrouter', id) } }))
mock.module('@/api/nanogpt', () => ({ buildNanoGptOAuthCallbackUrl: () => '', nanoGptApi: { account: (id: string) => request('nanogpt', id) } }))
mock.module('@/api/image-gen-connections', () => ({ imageGenConnectionsApi: { nanogptUsage: (id: string) => request('imageGen', id) } }))
const { useConnectionAccount } = await import('@/hooks/useConnectionAccount')
const { default: ConnectionItem } = await import('./ConnectionItem')
const { default: ImageGenConnectionItem } = await import('../image-gen-connections/ImageGenConnectionItem')

function profile(id: string, provider = 'openrouter'): ConnectionProfile {
  return { id, name: id, provider, model: 'test', api_url: '', metadata: {}, has_api_key: true,
    preset_id: null, is_default: false, created_at: 1, updated_at: 1 }
}
const credits = (remaining: number) => ({ label: null, limit: 100, limit_remaining: remaining,
  limit_reset: null, usage: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0, is_free_tier: false })
const nanoAccount = { balance: { usd_balance: 42, nano_balance: null }, subscription: null, paygo: null, errors: {} }
let account: ConnectionAccount
let root: Root | undefined
let host: HTMLDivElement
function Owner({ active, placements, kind }: { active: ConnectionProfile; placements: ConnectionPlacement[]; kind: 'llm' | 'imageGen' }) {
  const current = useConnectionAccount(active, kind)
  useEffect(() => { account = current }, [current])
  return <>{placements.map(placement => kind === 'llm'
    ? <ConnectionItem key={placement} placement={placement} account={current}
        profile={active} providers={[]} isActive onSelect={() => {}} onUpdate={() => {}} onDuplicate={() => {}} onDelete={() => {}} />
    : <ImageGenConnectionItem key={placement} placement={placement}
        nanoGptUsage={current.nanoGptUsage} nanoGptUsageLoading={current.loading} onRefreshNanoGptUsage={current.refresh}
        profile={{ ...active, default_parameters: {} }} providers={[]} isActive
        onSelect={() => {}} onUpdate={() => {}} onDuplicate={() => {}} onDelete={() => {}} />)}</>
}
async function render(active: ConnectionProfile, placements: ConnectionPlacement[] = ['list', 'recent'], kind: 'llm' | 'imageGen' = 'llm') {
  if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) }
  await act(async () => root!.render(<Owner active={active} placements={placements} kind={kind} />))
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove(); root = undefined; requests.length = 0
})

for (const provider of ['openrouter', 'nanogpt']) {
  test(`${provider}: canonical, recent and preview rows share reads and refresh results`, async () => {
    const active = profile('one', provider)
    await render(active)
    expect(requests).toHaveLength(1)
    await act(async () => requests[0].resolve(provider === 'openrouter' ? credits(42) : nanoAccount))
    await render(active, ['list', 'recent', 'preview'])
    expect(requests).toHaveLength(1)
    expect(host.textContent!.match(/\$42\.00/g)).toHaveLength(3)
    await act(async () => { void account.refresh() })
    expect(requests).toHaveLength(2)
    expect(account.loading).toBe(true)
    await act(async () => requests[1].resolve(provider === 'openrouter' ? credits(7) : { ...nanoAccount, balance: { usd_balance: 7 } }))
    expect(host.textContent!.match(/\$7\.00/g)).toHaveLength(3)
  })
}

test('a late response from the previous connection cannot replace the active account', async () => {
  await render(profile('old'))
  await render(profile('new'))
  expect(requests.map(value => value.id)).toEqual(['old', 'new'])
  await act(async () => requests[1].resolve(credits(7)))
  await act(async () => requests[0].resolve(credits(42)))
  expect(account.credits?.limit_remaining).toBe(7)
  expect(host.textContent).not.toContain('$42.00')
})

test('profile changes reload account data and removing credentials hides previous data', async () => {
  const active = profile('one')
  await render(active)
  await act(async () => requests[0].resolve(credits(42)))
  await render({ ...active, updated_at: 2 })
  expect(requests).toHaveLength(2)
  expect(account.credits).toBeNull()
  await render({ ...active, has_api_key: false })
  await act(async () => requests[1].resolve(credits(7)))
  expect(account.credits).toBeNull()
  expect(account.loading).toBe(false)
  expect(requests).toHaveLength(2)
})

test('errors settle loading and a manual retry updates all placements', async () => {
  await render(profile('one', 'nanogpt'))
  await act(async () => requests[0].reject(new Error('Account unavailable')))
  expect(account.loading).toBe(false)
  expect(account.error).toBe('Account unavailable')
  await act(async () => { void account.refresh() })
  await act(async () => requests[1].resolve(nanoAccount))
  expect(account.error).toBeNull()
  expect(account.nanoGptAccount).toEqual(nanoAccount)
})

test('failed OpenRouter refresh clears the stale balance in every placement', async () => {
  await render(profile('one'))
  await act(async () => requests[0].resolve(credits(42)))
  await act(async () => { void account.refresh() })
  await act(async () => requests[1].reject(new Error('Expired key')))
  expect(account.loading).toBe(false)
  expect(account.credits).toBeNull()
  expect(host.textContent).not.toContain('$42.00')
})

test('NanoGPT image placements share usage and refresh without retaining failed or outdated results', async () => {
  const active = profile('image', 'nanogpt')
  const usage = { active: true, allowOverage: false, dailyInputTokens: null, weeklyInputTokens: null,
    dailyImages: { used: 8, remaining: 42, percentUsed: 16, resetAt: null, limit: 50 },
    period: { currentPeriodEnd: null }, state: 'active', graceUntil: null }
  await render(active, ['list', 'recent'], 'imageGen')
  expect(requests.map(value => value.provider)).toEqual(['imageGen'])
  await act(async () => requests[0].resolve(usage))
  await render(active, ['list', 'recent', 'preview'], 'imageGen')
  expect(requests).toHaveLength(1)
  expect(host.textContent!.match(/42 \/ 50/g)).toHaveLength(3)
  await act(async () => { void account.refresh() })
  await act(async () => requests[1].resolve({ ...usage, dailyImages: { ...usage.dailyImages, remaining: 7 } }))
  expect(host.textContent!.match(/7 \/ 50/g)).toHaveLength(3)
  await act(async () => { void account.refresh() })
  await act(async () => requests[2].reject(new Error('Unavailable')))
  expect(account.nanoGptUsage).toBeNull()
  expect(host.textContent).not.toContain('7 / 50')
  await act(async () => { void account.refresh() })
  await render(profile('other', 'nanogpt'), ['list', 'recent'], 'imageGen')
  await act(async () => requests[3].resolve(usage))
  expect(account.nanoGptUsage).toBeNull()
  expect(account.loading).toBe(true)
})

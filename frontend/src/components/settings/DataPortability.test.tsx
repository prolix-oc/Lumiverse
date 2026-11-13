import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const startImport = mock(async () => ({ jobId: 'restore-job' }))
const getImportStatus = mock()
const getImportJobs = mock(async () => ({ jobs: [] as { jobId: string; status: string }[] }))
const resumeImport = mock(async () => ({ jobId: 'restore-job' }))
const skipTicket = mock(async () => ({}))
const refresh = mock(async () => {})
const exportUrl = mock((_vectors: boolean, _extensions: boolean) => 'about:blank')
const prepareSecretsExport = mock(async (_vectors: boolean, _extensions: boolean) => { throw new Error('prepare failed') })
const t = (key: string, args?: Record<string, unknown>) => args ? `${key} ${JSON.stringify(args)}` : key
mock.module('@/store', () => ({ useStore: { getState: () => ({ user: { id: 'owner' } }) } }))
mock.module('@/lib/import-recovery', () => ({ pendingImportJob: () => null, trackImportJob() {} }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {} } }))
mock.module('@/api/user-data', () => ({ userDataApi: { startImport, getImportStatus, skipTicket, getImportJobs, resumeImport, exportUrl, prepareSecretsExport } }))
mock.module('@/hooks/useAppInit', () => ({ refreshAppDataAfterImport: refresh }))
mock.module('@/store/slices/settings', () => ({ flushSettingsNow: async () => {} }))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}))
const { default: DataPortability } = await import('./DataPortability')
let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previous: Record<string, unknown>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Reflect.get(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  jest.useFakeTimers()
  startImport.mockClear()
  skipTicket.mockClear()
  refresh.mockClear()
  getImportStatus.mockReset()
  getImportJobs.mockReset().mockResolvedValue({ jobs: [] })
  resumeImport.mockClear()
  exportUrl.mockClear()
  prepareSecretsExport.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  jest.useRealTimers()
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}
async function start() {
  await act(async () => { root.render(<DataPortability />) })
  const input = host.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['zip'], 'backup.lvbak')] })
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  await click('dataPortability.uploadImport')
}
async function tick() {
  await act(async () => { jest.advanceTimersByTime(1000) })
}
const status = (state: string) => ({ jobId: 'restore-job', status: state, summary: { characters: { imported: 1, skipped: 0 } }, fileSummary: {}, manifest: { secretsCount: 1 } })

function checkbox(key: string): HTMLInputElement {
  return Array.from(host.querySelectorAll('label')).find(node => node.textContent?.includes(`dataPortability.${key}`))!
    .querySelector('input[type=checkbox]')!
}

test.each([false, true])('extension files default off and selection %s reaches the streaming export', async selected => {
  await act(async () => { root.render(<DataPortability />) })
  const input = checkbox('includeExtensionData')
  expect(input.checked).toBe(false)
  if (selected) await act(async () => { input.click() })
  host.querySelector('a')!.click = () => {}
  await click('dataPortability.downloadArchive')
  expect(exportUrl).toHaveBeenCalledWith(true, selected)
  expect(prepareSecretsExport).not.toHaveBeenCalled()
})

test.each([false, true])('extension files selection %s also reaches the secrets export', async selected => {
  await act(async () => { root.render(<DataPortability />) })
  if (selected) await act(async () => { checkbox('includeExtensionData').click() })
  await act(async () => { checkbox('includeSecrets').click() })
  await click('dataPortability.downloadArchive')
  expect(prepareSecretsExport).toHaveBeenCalledWith(true, selected)
  expect(exportUrl).not.toHaveBeenCalled()
})

test('polls beyond the old one-shot delay and refreshes imported data without WebSocket events', async () => {
  getImportStatus.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(status('running')).mockResolvedValueOnce(status('running')).mockResolvedValue(status('complete'))
  await start()
  await tick(); await tick(); await tick()
  expect(refresh).not.toHaveBeenCalled()
  await tick()
  expect(refresh).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).toContain('dataPortability.importComplete')
  await tick()
  expect(getImportStatus).toHaveBeenCalledTimes(4)
})

test('recovers the ticket prompt and completion through polling alone', async () => {
  getImportStatus.mockResolvedValueOnce(status('awaiting_ticket')).mockResolvedValue(status('complete'))
  await start()
  await tick()
  await click('dataPortability.skipApiKeys')
  expect(skipTicket).toHaveBeenCalledWith('restore-job')
  await tick()
  expect(refresh).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).not.toContain('dataPortability.ticketPrompt')
})


test('recovers extraction progress and its byte-based bar without WebSocket events', async () => {
  getImportStatus.mockResolvedValue({
    ...status('running'),
    progress: { phase: 'extracting', processed: 10, total: 100, bytesProcessed: 2 * 1024 ** 3, bytesTotal: 8 * 1024 ** 3 },
  })
  await start()
  expect(host.textContent).not.toContain('dataPortability.verifying')
  await tick()
  expect(getImportStatus).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).toContain('dataPortability.extracting {"done":"2.00","total":"8.00"}')
  expect(host.textContent).toContain('10/100')
  expect(host.querySelector('[style*="width: 25%"]')).not.toBeNull()
})

test('discovers and resumes a retained archive without selecting or uploading a file', async () => {
  getImportJobs.mockResolvedValue({ jobs: [{ jobId: 'restore-job', status: 'interrupted' }] })
  getImportStatus.mockResolvedValueOnce(status('interrupted')).mockResolvedValue(status('complete'))
  await act(async () => { root.render(<DataPortability />) })
  await tick()
  expect(host.textContent).toContain('dataPortability.resumeHint')
  await click('dataPortability.resumeImport')
  expect(resumeImport).toHaveBeenCalledWith('restore-job')
  expect(startImport).not.toHaveBeenCalled()
  await tick()
  expect(refresh).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).toContain('dataPortability.importComplete')
})

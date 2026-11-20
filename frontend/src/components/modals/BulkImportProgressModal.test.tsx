import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { ApiError, RequestTimeoutError } from '@/api/client'
import type { Character, CharacterImportJob } from '@/types/api'
import modals from '@/i18n/locales/en/modals.json'
import common from '@/i18n/locales/en/common.json'

const createImportJob = mock()
const uploadImportJobFile = mock()
const startImportJob = mock()
const getImportJob = mock()
const cancelImportJob = mock()
const onComplete = mock()

mock.module('@/api/characters', () => ({
  charactersApi: { createImportJob, uploadImportJobFile, startImportJob, getImportJob, cancelImportJob },
}))
mock.module('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const bundle = namespace === 'modals' ? modals : common
      const value = key.split('.').reduce<any>((node, part) => node?.[part], bundle) ?? key
      return value.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(values?.[name] ?? ''))
    },
  }),
}))
mock.module('@/components/shared/ModalShell', () => ({
  ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
mock.module('@/components/shared/CloseButton', () => ({
  CloseButton: ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>Close</button>,
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))
mock.module('@/components/shared/Toggle', () => ({ Toggle: { Checkbox: () => null } }))

const { default: BulkImportProgressModal } = await import('./BulkImportProgressModal')

const files = Array.from({ length: 136 }, (_, index) => new File(['png'], `card-${index}.png`, { type: 'image/png' }))

function snapshot(status: CharacterImportJob['status'], processed: number, error?: string): CharacterImportJob {
  return {
    jobId: 'job-1',
    status,
    total: files.length,
    uploaded: files.length,
    processed,
    results: files.slice(0, processed).map((file, index) => ({
      filename: file.name,
      success: true,
      character: { id: `character-${index}`, name: `Character ${index}` } as Character,
    })),
    summary: { total: files.length, imported: processed, skipped: 0, failed: 0 },
    error,
  }
}

let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previousGlobals: Record<string, unknown>

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previousGlobals = Object.fromEntries(
    ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Reflect.get(globalThis, key)]),
  )
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  jest.useFakeTimers()
  createImportJob.mockReset().mockResolvedValue(snapshot('accepting', 0))
  uploadImportJobFile.mockReset().mockResolvedValue(snapshot('accepting', 0))
  startImportJob.mockReset().mockResolvedValue(snapshot('processing', 0))
  getImportJob.mockReset().mockResolvedValue(snapshot('complete', files.length))
  cancelImportJob.mockReset().mockResolvedValue(snapshot('cancelled', 0))
  onComplete.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  jest.useRealTimers()
  dom.window.close()
  for (const [key, value] of Object.entries(previousGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
})

async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}

async function start() {
  await act(async () => {
    root.render(<BulkImportProgressModal isOpen files={files} onComplete={onComplete} onClose={() => {}} />)
  })
  await click('Start Import')
}

async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms) })
}

describe('BulkImportProgressModal', () => {
  test.each([
    ['network failure', new TypeError('Failed to fetch')],
    ['timeout', new RequestTimeoutError('/status', 30_000)],
    ['request timeout', new ApiError(408, 'Request Timeout')],
    ['rate limit', new ApiError(429, 'Too Many Requests')],
    ['server failure', new ApiError(503, 'Service Unavailable')],
  ])('recovers from a %s at 10/136 without cancelling the import', async (_label, error) => {
    getImportJob
      .mockResolvedValueOnce(snapshot('processing', 10))
      .mockRejectedValueOnce(error)

    await start()
    expect(host.textContent).toContain('10/136')
    await advance(250)

    expect(cancelImportJob).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Reconnecting')
    expect(host.textContent).not.toContain('Import Complete')
    expect(host.textContent).toContain('10/136')

    await advance(1000)
    expect(host.textContent).toContain('Import Complete')
    expect(host.textContent).toContain('136/136')
    expect(uploadImportJobFile).toHaveBeenCalledTimes(136)
    expect(startImportJob).toHaveBeenCalledTimes(1)
    expect(cancelImportJob).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toHaveLength(136)
  })

  test('shows a permanent status failure and retains partial imports', async () => {
    getImportJob
      .mockResolvedValueOnce(snapshot('processing', 10))
      .mockRejectedValueOnce(new ApiError(404, 'Not Found', { error: 'Character import job not found' }))

    await start()
    await advance(250)

    expect(host.textContent).toContain('Import Interrupted')
    expect(host.textContent).not.toContain('Import Complete')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Character import job not found')
    expect(host.textContent).toContain('10/136')
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toHaveLength(10)
    expect(cancelImportJob).not.toHaveBeenCalled()
  })

  test('shows a server job error even after some files succeeded', async () => {
    getImportJob.mockResolvedValueOnce(snapshot('error', 10, 'Import worker failed'))
    await start()

    expect(host.textContent).toContain('Import Interrupted')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Import worker failed')
    expect(host.textContent).toContain('10/136')
    expect(onComplete.mock.calls[0][0]).toHaveLength(10)
  })

  test('labels a cancelled job accurately and retains completed imports', async () => {
    getImportJob.mockResolvedValueOnce(snapshot('cancelled', 10))
    await start()

    expect(host.textContent).toContain('Import Cancelled')
    expect(host.textContent).not.toContain('Import Complete')
    expect(host.textContent).toContain('10/136')
    expect(onComplete.mock.calls[0][0]).toHaveLength(10)
  })

  test('an upload failure does not claim every selected file was processed', async () => {
    uploadImportJobFile.mockResolvedValueOnce(snapshot('accepting', 0)).mockRejectedValueOnce(new Error('Upload failed'))
    await start()

    expect(host.textContent).toContain('Import Interrupted')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Upload failed')
    expect(host.textContent).toContain('1/136')
    expect(startImportJob).not.toHaveBeenCalled()
    expect(cancelImportJob).toHaveBeenCalledWith('job-1')
  })

  test('keeps reconnecting with capped backoff and resets the delay after recovery', async () => {
    getImportJob.mockResolvedValueOnce(snapshot('processing', 10))
    for (let index = 0; index < 6; index++) getImportJob.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    getImportJob.mockResolvedValueOnce(snapshot('processing', 20)).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await start()
    await advance(250)
    for (const delay of [1000, 2000, 4000, 5000, 5000, 5000]) {
      const calls = getImportJob.mock.calls.length
      expect(host.textContent).toContain('Reconnecting')
      expect(host.textContent).not.toContain('Import Complete')
      await advance(delay - 1)
      expect(getImportJob).toHaveBeenCalledTimes(calls)
      await advance(1)
      expect(getImportJob).toHaveBeenCalledTimes(calls + 1)
    }
    expect(host.textContent).toContain('20/136')
    expect(host.textContent).not.toContain('Reconnecting')
    await advance(250)
    expect(host.textContent).toContain('Reconnecting')
    await advance(1000)

    expect(host.textContent).toContain('136/136')
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(cancelImportJob).not.toHaveBeenCalled()
  })

  test('can cancel while reconnecting without resuming status requests', async () => {
    getImportJob.mockResolvedValueOnce(snapshot('processing', 10)).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await start()
    await advance(250)
    await click('Cancel')
    await advance(1000)

    expect(cancelImportJob).toHaveBeenCalledWith('job-1')
    expect(getImportJob).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Import Cancelled')
    expect(host.textContent).not.toContain('Import Complete')
    expect(onComplete.mock.calls[0][0]).toHaveLength(10)
  })

  test('does not start processing when cancelled during the final upload', async () => {
    let finishUpload!: () => void
    uploadImportJobFile.mockImplementation(async (_jobId: string, index: number) => {
      if (index === files.length - 1) await new Promise<void>((resolve) => { finishUpload = resolve })
      return snapshot('accepting', 0)
    })
    await start()
    expect(uploadImportJobFile).toHaveBeenCalledTimes(136)
    await click('Cancel')
    await act(async () => { finishUpload() })

    expect(startImportJob).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Import Cancelled')
  })

  test('rejects a premature complete status instead of displaying Done', async () => {
    getImportJob.mockResolvedValueOnce(snapshot('complete', 10))
    await start()

    expect(host.textContent).toContain('Import Interrupted')
    expect(host.textContent).not.toContain('Import Complete')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('before all selected files were processed')
    expect(onComplete.mock.calls[0][0]).toHaveLength(10)
  })

  test('finishes a fully processed batch with per-file failures and skipped duplicates', async () => {
    const complete = snapshot('complete', files.length)
    complete.results[4] = { filename: files[4].name, success: false, error: 'Invalid PNG card' }
    complete.results[5].skipped = true
    getImportJob.mockResolvedValueOnce(complete)
    await start()

    expect(host.textContent).toContain('Import Complete')
    expect(host.textContent).toContain('136/136')
    expect(host.textContent).toContain('Invalid PNG card')
    expect(host.textContent).toContain('1 failed')
    expect(host.textContent).toContain('1 skipped')
    expect(onComplete.mock.calls[0][0]).toHaveLength(134)
  })
})

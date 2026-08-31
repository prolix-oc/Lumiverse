import { afterEach, describe, expect, test } from 'bun:test'
import { userDataApi } from './user-data'
import { USER_DATA_LIMITS, UserDataProtocolError } from '@/types/user-data'

type FakeUpload = { addEventListener: (event: string, handler: (progress: unknown) => void) => void }

class FakeXmlHttpRequest {
  static sendCount = 0
  static constructCount = 0
  readonly upload: FakeUpload = { addEventListener: () => {} }
  status = 201
  statusText = 'Created'
  responseText = JSON.stringify({ jobId: 'job-size-boundary', status: 'queued' })
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXmlHttpRequest.constructCount += 1
  }

  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    FakeXmlHttpRequest.sendCount += 1
    queueMicrotask(() => this.onload?.())
  }
}

const originalXmlHttpRequest = globalThis.XMLHttpRequest
const originalFetch = globalThis.fetch

afterEach(() => {
  FakeXmlHttpRequest.sendCount = 0
  FakeXmlHttpRequest.constructCount = 0
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: originalXmlHttpRequest,
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: originalFetch,
  })
})

describe('user-data upload bounds', () => {
  test('accepts the exact archive size cap and sends once', async () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: FakeXmlHttpRequest,
    })

    const file = { size: USER_DATA_LIMITS.maxArchiveUploadBytes } as File
    await expect(userDataApi.startImport(file)).resolves.toEqual({ jobId: 'job-size-boundary', status: 'queued' })
    expect(FakeXmlHttpRequest.sendCount).toBe(1)
    expect(FakeXmlHttpRequest.constructCount).toBe(1)
  })

  test('rejects cap plus one before constructing a request', async () => {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: FakeXmlHttpRequest,
    })

    const file = { size: USER_DATA_LIMITS.maxArchiveUploadBytes + 1 } as File
    // bun's rejects modifier supports toThrow/toMatchObject/toBe/toBeInstanceOf,
    // not toSatisfy; assert the rejection shape with the supported pair instead.
    await expect(userDataApi.startImport(file)).rejects.toBeInstanceOf(UserDataProtocolError)
    await expect(userDataApi.startImport(file)).rejects.toMatchObject({ code: 'size' })
    expect(FakeXmlHttpRequest.constructCount).toBe(0)
    expect(FakeXmlHttpRequest.sendCount).toBe(0)
  })
})

describe('user-data export prepare', () => {
  test('posts the opt-in secret request and normalizes the closed prepare response', async () => {
    const ticket = {
      kind: 'lumiverse-decryption-ticket' as const,
      version: 1 as const,
      archiveId: 'archive-prepare',
      issuer: 'lumiverse' as const,
      issuerInstance: 'instance-source',
      issuedAt: 1_700_000_000,
      algorithm: 'AES-256-GCM' as const,
      keyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      secretsHash: 'a'.repeat(64),
    }
    const routeResponse = {
      archiveId: 'archive-prepare',
      archiveUrl: '/api/v1/user-data/export/archive/archive-prepare',
      archiveFilename: 'lumiverse-user-archive.lvbak',
      ticketFilename: 'lumiverse-user-archive.ticket.json',
      ticket,
      secretsCount: 3,
      unreachableSecrets: [],
    }
    let captured: { input: RequestInfo | URL; init?: RequestInit } | null = null
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { input, init }
        return new Response(JSON.stringify(routeResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    await expect(userDataApi.prepareSecretsExport(false)).resolves.toEqual(routeResponse)
    expect(captured?.input).toBe('/api/v1/user-data/export/prepare')
    expect(captured?.init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      includeVectors: false,
      includeSecrets: true,
    })
  })

  test('classifies transport failure without importing an import-start reason', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => { throw new Error('prepare offline') },
    })

    let failure: unknown = null
    try {
      await userDataApi.prepareSecretsExport(true)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ body: { code: 'network', error: 'prepare offline' } })
    expect((failure as { body: { code: string } }).body.code).not.toBe('import_start_failed')
  })
})

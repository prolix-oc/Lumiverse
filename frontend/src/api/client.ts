import { activeTab } from '@/lib/active-tab'
import { isExpiredSessionResponse, signalInvalidAuthSession } from './session-lifecycle'
import { invalidateSharedReads } from '@/lib/shared-read'
import { beginApiRead } from '@/lib/displayPerformance'

export const BASE_URL = import.meta.env.VITE_API_BASE || '/api/v1'

/** Default timeout for API requests (30s). Prevents the UI from locking
 *  indefinitely when the server hangs on slow operations (embedding calls,
 *  vector search, etc.). Individual callers can override via `options.timeout`. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Render a timeout in the largest unit that still reads naturally, so a
 * five-minute ceiling does not report itself as 300000ms.
 */
function formatTimeout(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = ms / 60_000
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}min`
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: any
  ) {
    super(`${status} ${statusText}`)
    this.name = 'ApiError'
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    public url: string,
    public timeoutMs: number
  ) {
    super(`Request timed out after ${formatTimeout(timeoutMs)}`)
    this.name = 'RequestTimeoutError'
  }
}

export interface RequestOptions {
  /** Override the default request timeout in milliseconds. 0 = no timeout. */
  timeout?: number
  /** Externally provided AbortSignal (e.g. from a cancel button). */
  signal?: AbortSignal
}

function buildSignal(options?: RequestOptions): { signal: AbortSignal; cleanup: () => void; timeoutMs: number } {
  activeTab.assertActive()
  const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const onInactive = () => controller.abort(activeTab.signal.reason)
  activeTab.signal.addEventListener('abort', onInactive, { once: true })

  // If the caller provided their own signal, abort when it does
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason)
    } else {
      const onAbort = () => controller.abort(options.signal!.reason)
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
  }

  return {
    signal: controller.signal,
    timeoutMs,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      activeTab.signal.removeEventListener('abort', onInactive)
    },
  }
}

function maybeWrapTimeoutError(error: unknown, url: string, signal: AbortSignal, timeoutMs: number): Error | unknown {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason as { name?: string } | undefined
  const timedOut = signal.aborted && reason?.name === 'TimeoutError'
  if (timedOut) {
    return new RequestTimeoutError(url, timeoutMs)
  }
  return error
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: any
    try {
      body = await res.json()
    } catch {
      body = await res.text().catch(() => null)
    }
    if (isExpiredSessionResponse(res.status, body)) signalInvalidAuthSession()
    throw new ApiError(res.status, res.statusText, body)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function get<T>(path: string, params?: Record<string, any>, options?: RequestOptions): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const finish = beginApiRead(path)
  let failed = true
  try {
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      // Database reads must be fresh after a restore in persistent WebViews.
      cache: 'no-store',
      credentials: 'include',
      signal,
    })
    const result = await handleResponse<T>(res)
    failed = false
    return result
  } catch (error) {
    throw maybeWrapTimeoutError(error, url.toString(), signal, timeoutMs)
  } finally {
    finish(failed)
    cleanup()
  }
}

export async function post<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

export async function put<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

export async function del<T>(path: string, options?: RequestOptions): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

export async function patch<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

export async function getBlob(path: string, params?: Record<string, any>, options?: RequestOptions): Promise<Blob> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  try {
    const res = await fetch(url.toString(), { credentials: 'include', signal })
    if (!res.ok) {
      let body: any
      try { body = await res.json() } catch { body = null }
      if (isExpiredSessionResponse(res.status, body)) signalInvalidAuthSession()
      throw new ApiError(res.status, res.statusText, body)
    }
    return res.blob()
  } catch (error) {
    throw maybeWrapTimeoutError(error, url.toString(), signal, timeoutMs)
  } finally {
    cleanup()
  }
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] ?? null
}

export async function postBlob(path: string, body?: any, options?: RequestOptions): Promise<Blob> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/octet-stream',
      },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    if (!res.ok) {
      let responseBody: any
      try { responseBody = await res.json() } catch { responseBody = await res.text().catch(() => null) }
      if (isExpiredSessionResponse(res.status, responseBody)) signalInvalidAuthSession()
      throw new ApiError(res.status, res.statusText, responseBody)
    }
    const blob = await res.blob()
    const filename = parseContentDispositionFilename(res.headers.get('Content-Disposition'))
    return filename ? new File([blob], filename, { type: blob.type }) : blob
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function upload<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: formData,
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

/**
 * Upload a Blob/File as the request body without multipart encoding. This lets
 * the server consume the HTTP stream directly instead of asking Bun's
 * multipart parser to materialize every selected file in memory.
 */
export async function uploadRaw<T>(
  path: string,
  body: Blob,
  options?: RequestOptions & { contentType?: string },
): Promise<T> {
  invalidateSharedReads()
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': options?.contentType || body.type || 'application/octet-stream',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body,
      signal,
    })
    return await handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    invalidateSharedReads()
    cleanup()
  }
}

export function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  invalidateSharedReads()
  return new Promise((resolve, reject) => {
    activeTab.assertActive()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    xhr.withCredentials = true

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      })
    }

    xhr.onload = () => {
      invalidateSharedReads()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid JSON response'))
        }
      } else {
        let body: any
        try { body = JSON.parse(xhr.responseText) } catch { body = xhr.responseText }
        if (isExpiredSessionResponse(xhr.status, body)) signalInvalidAuthSession()
        reject(new ApiError(xhr.status, xhr.statusText, body))
      }
    }

    const onInactive = () => xhr.abort()
    activeTab.signal.addEventListener('abort', onInactive, { once: true })
    xhr.onloadend = () => {
      invalidateSharedReads()
      activeTab.signal.removeEventListener('abort', onInactive)
    }
    xhr.onabort = () => reject(activeTab.signal.reason ?? new DOMException('Upload cancelled', 'AbortError'))
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(formData)
  })
}

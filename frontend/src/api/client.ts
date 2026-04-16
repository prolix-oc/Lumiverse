export const BASE_URL = import.meta.env.VITE_API_BASE || '/api/v1'

/** Default timeout for API requests (30s). Prevents the UI from locking
 *  indefinitely when the server hangs on slow operations (embedding calls,
 *  vector search, etc.). Individual callers can override via `options.timeout`. */
const DEFAULT_TIMEOUT_MS = 30_000

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
    super(`Request timed out after ${timeoutMs}ms`)
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
  const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()

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
    cleanup: () => { if (timer) clearTimeout(timer) },
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
  try {
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
      signal,
    })
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url.toString(), signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function post<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
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
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function put<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
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
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function del<T>(path: string, options?: RequestOptions): Promise<T> {
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
      signal,
    })
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function patch<T>(path: string, body?: any, options?: RequestOptions): Promise<T> {
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
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
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
      throw new ApiError(res.status, res.statusText, body)
    }
    return res.blob()
  } catch (error) {
    throw maybeWrapTimeoutError(error, url.toString(), signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export async function upload<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
  const { signal, cleanup, timeoutMs } = buildSignal(options)
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: formData,
      signal,
    })
    return handleResponse<T>(res)
  } catch (error) {
    throw maybeWrapTimeoutError(error, url, signal, timeoutMs)
  } finally {
    cleanup()
  }
}

export function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
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
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid JSON response'))
        }
      } else {
        let body: any
        try { body = JSON.parse(xhr.responseText) } catch { body = xhr.responseText }
        reject(new ApiError(xhr.status, xhr.statusText, body))
      }
    }

    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(formData)
  })
}

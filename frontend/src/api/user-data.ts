import { ApiError, BASE_URL, get, post } from './client'
import {
  normalizeUserDataApiFailure,
  normalizeUserDataCommand,
  normalizeUserDataExportPrepare,
  normalizeUserDataJob,
  normalizeUserDataJobId,
  normalizeUserDataStartImport,
  parseDecryptionTicket,
  USER_DATA_LIMITS,
  UserDataProtocolError,
  type DecryptionTicket,
  type UserDataCommandResponse,
  type UserDataExportPrepareResponse,
  type UserDataJob,
  type UserDataStartImportResponse,
} from '@/types/user-data'

export type { DecryptionTicket, UserDataCommandResponse, UserDataExportPrepareResponse, UserDataJob, UserDataStartImportResponse }

export type ExportPrepareResponse = UserDataExportPrepareResponse

export interface TicketSubmissionResponse { accepted: true }

/** Compatibility name for the canonical bounded status projection. */
export type ImportJobStatus = UserDataJob

function apiFailure(error: unknown, fallback: Parameters<typeof normalizeUserDataApiFailure>[1] = 'network'): Error {
  const failure = normalizeUserDataApiFailure(error, fallback)
  const wrapped = new Error(failure.message || failure.code)
  Object.assign(wrapped, { body: { code: failure.code, error: failure.message, message: failure.message } })
  return wrapped
}

export const userDataApi = {
  exportUrl(includeVectors: boolean): string {
    return `${BASE_URL}/user-data/export?includeVectors=${includeVectors ? '1' : '0'}`
  },

  async prepareSecretsExport(includeVectors: boolean): Promise<ExportPrepareResponse> {
    try {
      return normalizeUserDataExportPrepare(await post<unknown>('/user-data/export/prepare', { includeVectors, includeSecrets: true }))
    } catch (error) {
      throw apiFailure(error)
    }
  },
  /** Parse ticket input exactly once before it crosses the API boundary. */
  async submitTicket(jobId: string, ticketInput: unknown): Promise<TicketSubmissionResponse> {
    const routeJobId = normalizeUserDataJobId(jobId)
    const ticket = parseDecryptionTicket(ticketInput)
    try {
      const result = await post<unknown>(`/user-data/import/${encodeURIComponent(routeJobId)}/ticket`, ticket)
      const normalized = normalizeUserDataCommand(result)
      if (!normalized.accepted) throw apiFailure(normalized.failure, 'ticket_submission_failed')
      return { accepted: true }
    } catch (error) {
      throw apiFailure(error, 'ticket_submission_failed')
    }
  },

  async skipTicket(jobId: string): Promise<{ skipped: boolean }> {
    const routeJobId = normalizeUserDataJobId(jobId)
    try {
      const normalized = normalizeUserDataCommand(await post<unknown>(`/user-data/import/${encodeURIComponent(routeJobId)}/skip-ticket`))
      if (!normalized.accepted || normalized.status === 'too_late' || normalized.status === 'not_found') {
        throw apiFailure(normalized.failure, 'ticket_gate_conflict')
      }
      return { skipped: true }
    } catch (error) {
      throw apiFailure(error, 'ticket_gate_conflict')
    }
  },

  async startImport(file: File, onProgress?: (percent: number) => void): Promise<UserDataStartImportResponse> {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > USER_DATA_LIMITS.maxArchiveUploadBytes) {
      throw new UserDataProtocolError('size', 'archive upload exceeds the supported size limit')
    }
    const { promise, resolve, reject } = Promise.withResolvers<UserDataStartImportResponse>()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}/user-data/import`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))))
      })
    }
    xhr.onload = () => {
      let body: unknown
      try { body = JSON.parse(xhr.responseText) } catch { body = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(normalizeUserDataStartImport(body)) } catch (error) { reject(error) }
        return
      }
      reject(apiFailure(new ApiError(xhr.status, xhr.statusText, body), 'upload_failed'))
    }
    xhr.onerror = () => reject(apiFailure(new Error('Network error during upload'), 'network'))
    xhr.onabort = () => reject(apiFailure(new Error('Upload cancelled'), 'cancelled'))
    xhr.send(file)
    return promise
  },

  async getImportStatus(jobId: string): Promise<ImportJobStatus> {
    const routeJobId = normalizeUserDataJobId(jobId)
    try {
      const response = await get<unknown>(`/user-data/import/${encodeURIComponent(routeJobId)}/status`)
      return normalizeUserDataJob(response)
    } catch (error) {
      if (error instanceof UserDataProtocolError) throw error
      throw apiFailure(error, 'network')
    }
  },

  async cancelImport(jobId: string): Promise<{ status: 'cancelled' | 'cancelling' | 'cleanup_pending' | 'too_late' | 'not_found' }> {
    const routeJobId = normalizeUserDataJobId(jobId)
    try {
      const result = normalizeUserDataCommand(await post<unknown>(`/user-data/import/${encodeURIComponent(routeJobId)}/cancel`))
      if (result.status !== 'cancelled' && result.status !== 'cancelling' && result.status !== 'cleanup_pending' && result.status !== 'too_late' && result.status !== 'not_found') {
        throw apiFailure(result.failure, 'malformed_response')
      }
      return { status: result.status }
    } catch (error) {
      if (error instanceof UserDataProtocolError) throw error
      throw apiFailure(error, 'network')
    }
  },
}

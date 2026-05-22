import { BASE_URL, get, post } from './client'

export interface DecryptionTicket {
  kind: 'lumiverse-decryption-ticket'
  version: 1
  archiveId: string
  issuer: 'lumiverse'
  issuerInstance: string | null
  issuedAt: number
  algorithm: 'AES-256-GCM'
  keyB64: string
  secretsHash: string
}

export interface ExportPrepareResponse {
  archiveId: string
  archiveUrl: string
  archiveFilename: string
  ticketFilename: string | null
  ticket: DecryptionTicket | null
  secretsCount: number
  /** Secret keys the source instance couldn't decrypt — excluded from the export. */
  unreachableSecrets: string[]
}

export interface TicketSubmissionResponse {
  accepted: true
  wasReused: boolean
  previouslyConsumedAt: number | null
  uses: number
}

export interface ImportJobStatus {
  jobId: string
  status: 'queued' | 'awaiting_ticket' | 'running' | 'complete' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt: number | null
  manifest: {
    schemaVersion: number
    exportedAt: number
    archiveId: string
    producerVersion: string | null
    includeVectors: boolean
    embeddingConfig: { provider: string | null; model: string | null; dimension: number | null }
    counts: Record<string, number>
    missingFiles: string[]
    hasEncryptedSecrets?: boolean
    secretsCount?: number
  } | null
  summary: Record<string, { imported: number; skipped: number }>
  fileSummary: Record<string, number>
  error: string | null
}

export const userDataApi = {
  /** Returns the URL the browser can navigate to / GET for a streamed export
   *  without API keys. */
  exportUrl(includeVectors: boolean): string {
    return `${BASE_URL}/user-data/export?includeVectors=${includeVectors ? '1' : '0'}`
  },

  /** Prepare a secrets-bearing export. Returns the ticket JSON (to download
   *  out-of-band) and the URL to stream the archive from. */
  prepareSecretsExport(includeVectors: boolean): Promise<ExportPrepareResponse> {
    return post('/user-data/export/prepare', { includeVectors, includeSecrets: true })
  },

  /** Submit the parsed ticket JSON to a job awaiting one. */
  submitTicket(jobId: string, ticket: DecryptionTicket): Promise<TicketSubmissionResponse> {
    return post(`/user-data/import/${jobId}/ticket`, ticket)
  },

  /** Resume an awaiting-ticket import without restoring secrets. */
  skipTicket(jobId: string): Promise<{ skipped: boolean }> {
    return post(`/user-data/import/${jobId}/skip-ticket`)
  },

  /**
   * Upload an archive as the raw request body. Returns { jobId } once the
   * upload is staged. Progress reports come over the WebSocket.
   */
  async startImport(file: File, onProgress?: (percent: number) => void): Promise<{ jobId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE_URL}/user-data/import`)
      xhr.withCredentials = true
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')

      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
        })
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText))
          } catch (err) {
            reject(new Error('Server returned invalid JSON: ' + (err as Error).message))
          }
        } else {
          let body: any
          try { body = JSON.parse(xhr.responseText) } catch { body = xhr.responseText }
          reject(new Error(body?.error || `Upload failed (${xhr.status})`))
        }
      }
      xhr.onerror = () => reject(new Error('Network error during upload'))
      xhr.send(file)
    })
  },

  getImportStatus(jobId: string): Promise<ImportJobStatus> {
    return get(`/user-data/import/${jobId}/status`)
  },

  cancelImport(jobId: string): Promise<{ cancelled: boolean; status: string }> {
    return post(`/user-data/import/${jobId}/cancel`)
  },
}

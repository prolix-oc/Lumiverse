import { ttsApi } from '@/api/tts'
import { isQwenTtsProvider } from '@/lib/qwenTts'
import type { TtsConnectionProfile } from '@/types/api'

export interface SynthesizedTtsSegment {
  data: ArrayBuffer
  mime: string
}

interface ParsedSseEvent {
  event: string
  data: string
}

interface StreamAudioPayload {
  kind: 'bytes' | 'audio_file'
  mimeType?: string
  base64: string
}

type StreamingPreference = Pick<TtsConnectionProfile, 'provider' | 'default_parameters'>

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

function parseSseEventBlock(block: string): ParsedSseEvent | null {
  const lines = block.replace(/\r/g, '').split('\n')
  let event = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message'
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (event === 'message' && dataLines.length === 0) return null
  return {
    event,
    data: dataLines.join('\n'),
  }
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const clone = response.clone()
    const json = await clone.json().catch(() => null)
    if (json && typeof json.error === 'string' && json.error.trim()) return json.error.trim()
  } catch {
    // Fall through to text.
  }

  const text = await response.text().catch(() => '')
  return text.trim() || response.statusText || `TTS error ${response.status}`
}

async function synthesizeBuffered(
  connectionId: string,
  text: string,
  options?: {
    voice?: string
    model?: string
    speed?: number
    outputFormat?: string
    signal?: AbortSignal
    onPlayableSegment?: (segment: SynthesizedTtsSegment) => void
  },
): Promise<SynthesizedTtsSegment[]> {
  const response = await ttsApi.synthesize(connectionId, text, options)
  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }

  const segment: SynthesizedTtsSegment = {
    data: await response.arrayBuffer(),
    mime: response.headers.get('content-type') || 'audio/mpeg',
  }
  if (segment.data.byteLength === 0) return []
  options?.onPlayableSegment?.(segment)
  return [segment]
}

async function synthesizeStreamed(
  connectionId: string,
  text: string,
  options?: {
    voice?: string
    model?: string
    speed?: number
    outputFormat?: string
    signal?: AbortSignal
    onPlayableSegment?: (segment: SynthesizedTtsSegment) => void
  },
): Promise<SynthesizedTtsSegment[]> {
  const response = await ttsApi.synthesizeStream(connectionId, text, options)
  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }
  if (!response.body) {
    throw new Error('No response body for streaming TTS')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDone = false
  const byteChunks: Uint8Array[] = []
  let byteMimeType = response.headers.get('x-audio-mime-type') || 'audio/mpeg'
  const segments: SynthesizedTtsSegment[] = []

  const handleEvent = (event: ParsedSseEvent) => {
    if (event.event === 'done') {
      sawDone = true
      return
    }

    if (event.event === 'error') {
      let message = event.data.trim()
      try {
        const parsed = JSON.parse(event.data) as { error?: string }
        if (typeof parsed?.error === 'string' && parsed.error.trim()) {
          message = parsed.error.trim()
        }
      } catch {
        // Keep the raw event payload.
      }
      throw new Error(message || 'Streaming TTS failed')
    }

    if (event.event !== 'audio') return

    let payload: StreamAudioPayload
    try {
      payload = JSON.parse(event.data) as StreamAudioPayload
    } catch {
      throw new Error('Malformed streaming audio payload')
    }

    if (!payload.base64) return
    const bytes = base64ToUint8Array(payload.base64)
    if (payload.kind === 'audio_file') {
      const segment: SynthesizedTtsSegment = {
        data: toArrayBuffer(bytes),
        mime: payload.mimeType || 'audio/wav',
      }
      segments.push(segment)
      options?.onPlayableSegment?.(segment)
      return
    }

    byteMimeType = payload.mimeType || byteMimeType
    byteChunks.push(bytes)
  }

  try {
    while (!sawDone) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseEventBlock(block)
        if (event) handleEvent(event)
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer += decoder.decode().replace(/\r/g, '')
    if (!sawDone && buffer.trim()) {
      const event = parseSseEventBlock(buffer)
      if (event) handleEvent(event)
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  if (byteChunks.length > 0) {
    const segment: SynthesizedTtsSegment = {
      data: toArrayBuffer(concatUint8Arrays(byteChunks)),
      mime: byteMimeType,
    }
    segments.push(segment)
    options?.onPlayableSegment?.(segment)
  }

  if (segments.length === 0 && !sawDone) {
    throw new Error('TTS stream ended before any audio arrived')
  }

  return segments
}

export function shouldUseStreamingEndpoint(profile: StreamingPreference | null | undefined): boolean {
  if (!profile) return false
  const explicit = profile.default_parameters?.use_streaming_endpoint
  if (typeof explicit === 'boolean') return explicit
  return isQwenTtsProvider(profile.provider)
}

export async function synthesizeTtsSegments(
  connectionId: string,
  text: string,
  options?: {
    profile?: StreamingPreference | null
    voice?: string
    model?: string
    speed?: number
    outputFormat?: string
    signal?: AbortSignal
    onPlayableSegment?: (segment: SynthesizedTtsSegment) => void
  },
): Promise<SynthesizedTtsSegment[]> {
  if (shouldUseStreamingEndpoint(options?.profile)) {
    return synthesizeStreamed(connectionId, text, options)
  }
  return synthesizeBuffered(connectionId, text, options)
}

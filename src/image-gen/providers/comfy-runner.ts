import { openWebSocket } from "./ws-helpers"
import { parseProviderErrorBody, readBoundedText } from "../../utils/provider-errors"

export interface ComfyRunnerOptions {
  label: string
  // Sent as Cookie header on every HTTP + WS call. Used for SwarmUI's
  // /ComfyBackendDirect proxy when the instance is auth-gated.
  cookie?: string
  wsTimeoutMs?: number
}

export type ComfyStreamEvent =
  | { type: "progress"; step: number; totalSteps: number }
  | { type: "executing"; nodeId: string }
  | { type: "preview"; imageBase64: string }

export interface ComfyRunnerResult {
  imageDataUrl: string
}

interface ComfyImageResult {
  filename: string
  subfolder: string
  type: string
}

function buildHeaders(cookie?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) }
  if (cookie) h.Cookie = cookie
  return h
}

export function buildComfyImageViewUrl(baseUrl: string, image: ComfyImageResult): string {
  return `${baseUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`
}

/**
 * Upload a source image to ComfyUI's input directory so a LoadImage node can
 * reference it by filename (img2img). Stock ComfyUI's LoadImage cannot accept
 * base64 inline, so the image must be uploaded first via `POST /upload/image`.
 *
 * Returns the server-assigned `{ name, subfolder }` — ComfyUI may rename on
 * collision, so callers must use the returned name, not the one they sent.
 */
export async function uploadComfyImage(
  baseUrl: string,
  image: { data: string; mimeType?: string; filename?: string },
  opts: { cookie?: string; signal?: AbortSignal },
): Promise<{ name: string; subfolder: string }> {
  baseUrl = baseUrl.replace(/\/+$/, "")
  const bytes = Buffer.from(image.data, "base64")
  const mime = image.mimeType || "image/png"
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png"
  const filename = image.filename || `lumiverse-init-${crypto.randomUUID()}.${ext}`

  const form = new FormData()
  form.append("image", new Blob([bytes], { type: mime }), filename)
  form.append("type", "input")
  form.append("overwrite", "true")

  const res = await fetch(`${baseUrl}/upload/image`, {
    method: "POST",
    headers: opts.cookie ? { Cookie: opts.cookie } : undefined,
    body: form,
    signal: opts.signal,
  })

  if (!res.ok) {
    const rawBody = await readBoundedText(res)
    const parsed = parseProviderErrorBody(rawBody)
    const detail = parsed.detail || parsed.code || String(res.status)
    throw new Error(`ComfyUI rejected image upload: ${detail}`)
  }

  const data = (await res.json()) as { name?: string; subfolder?: string }
  if (!data?.name) throw new Error("ComfyUI /upload/image returned no filename")
  return { name: data.name, subfolder: typeof data.subfolder === "string" ? data.subfolder : "" }
}

export function findFirstComfyImageResult(
  outputs: Record<string, any> | null | undefined,
): ComfyImageResult | null {
  if (!outputs || typeof outputs !== "object") return null
  for (const nodeOutput of Object.values(outputs) as any[]) {
    if (!Array.isArray(nodeOutput?.images) || nodeOutput.images.length === 0) continue
    const image = nodeOutput.images[0]
    if (!image || typeof image.filename !== "string") continue
    return {
      filename: image.filename,
      subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
      type: typeof image.type === "string" ? image.type : "output",
    }
  }
  return null
}

function logOutputsShape(label: string, outputs: Record<string, any>, promptId: string): void {
  try {
    const summary: Record<string, { keys: string[]; imageCount: number; imageShape?: any }> = {}
    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      const keys = nodeOutput && typeof nodeOutput === "object" ? Object.keys(nodeOutput) : []
      const images = Array.isArray(nodeOutput?.images) ? nodeOutput.images : []
      summary[nodeId] = {
        keys,
        imageCount: images.length,
        ...(images.length > 0 && images[0] ? { imageShape: Object.keys(images[0]) } : {}),
      }
    }
    console.error(
      "[%s] No image found in outputs. promptId=%s nodeCount=%d outputShape=%j",
      label, promptId, Object.keys(outputs).length, summary,
    )
  } catch {
    console.error("[%s] No image found in outputs and failed to log shape. promptId=%s", label, promptId)
  }
}

export async function* executeComfyWorkflowStream(
  baseUrl: string,
  workflow: Record<string, any>,
  signal: AbortSignal | undefined,
  opts: ComfyRunnerOptions,
): AsyncGenerator<ComfyStreamEvent, ComfyRunnerResult, unknown> {
  const { label, cookie } = opts
  // Trailing slashes on user-provided apiUrl cause `//ws`, `//prompt`, etc.
  // The WS handshake then returns a normal HTTP response and Bun reports
  // "Expected 101 status code". Strip once at the boundary.
  baseUrl = baseUrl.replace(/\/+$/, "")
  const clientId = crypto.randomUUID()

  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`
  console.debug("[%s] Opening WS to %s (clientId=%s)", label, wsUrl, clientId)
  const ws = await openWebSocket(wsUrl, {
    label,
    timeoutMs: opts.wsTimeoutMs ?? 15_000,
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  console.debug("[%s] WS connected (clientId=%s)", label, clientId)

  const queueRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: buildHeaders(cookie, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal,
  })

  if (!queueRes.ok) {
    ws.close()
    const rawBody = await readBoundedText(queueRes)
    const parsed = parseProviderErrorBody(rawBody)
    const detail = parsed.detail || parsed.code || String(queueRes.status)
    throw new Error(`${label} rejected workflow: ${detail}`)
  }

  const queueData = (await queueRes.json()) as { prompt_id: string }
  const promptId = queueData.prompt_id
  console.debug("[%s] Prompt queued (promptId=%s, clientId=%s)", label, promptId, clientId)

  const abortHandler = () => {
    fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: buildHeaders(cookie),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  signal?.addEventListener("abort", abortHandler, { once: true })

  try {
    for await (const event of wsEventStream(ws, promptId, signal)) {
      if (event.type === "complete") {
        break
      } else if (event.type === "error") {
        throw new Error(`${label} execution error: ${event.message}`)
      } else if (event.type === "progress") {
        yield { type: "progress", step: event.value, totalSteps: event.max }
      } else if (event.type === "executing") {
        yield { type: "executing", nodeId: event.nodeId }
      } else if (event.type === "preview") {
        yield { type: "preview", imageBase64: event.imageBase64 }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler)
    ws.close()
  }

  console.debug("[%s] Fetching history for promptId=%s", label, promptId)
  const historyRes = await fetch(`${baseUrl}/history/${promptId}`, {
    headers: buildHeaders(cookie),
    signal,
  })
  if (!historyRes.ok) {
    throw new Error(`${label} history fetch failed: ${historyRes.status}`)
  }

  const history = (await historyRes.json()) as Record<string, any>
  const outputs = history[promptId]?.outputs
  if (!outputs) {
    const historyKeys = Object.keys(history)
    const entryKeys = history[promptId] ? Object.keys(history[promptId]) : []
    console.error("[%s] No outputs in history. promptId=%s, historyKeys=%j, entryKeys=%j", label, promptId, historyKeys, entryKeys)
    throw new Error(`No outputs in ${label} history`)
  }

  const imageResult = findFirstComfyImageResult(outputs)
  if (!imageResult) {
    logOutputsShape(label, outputs, promptId)
    throw new Error(`No image output found in ${label} results`)
  }
  console.debug("[%s] Found image result: filename=%s subfolder=%s type=%s", label, imageResult.filename, imageResult.subfolder, imageResult.type)

  const imageUrl = buildComfyImageViewUrl(baseUrl, imageResult)
  const imageRes = await fetch(imageUrl, { headers: buildHeaders(cookie), signal })
  if (!imageRes.ok) throw new Error(`Failed to fetch ${label} output image: ${imageRes.status}`)

  const imageBuffer = await imageRes.arrayBuffer()
  const base64 = Buffer.from(imageBuffer).toString("base64")
  const mimeType = imageRes.headers.get("content-type") || "image/png"
  return { imageDataUrl: `data:${mimeType};base64,${base64}` }
}

export async function executeComfyWorkflow(
  baseUrl: string,
  workflow: Record<string, any>,
  signal: AbortSignal | undefined,
  opts: ComfyRunnerOptions,
): Promise<ComfyRunnerResult> {
  const gen = executeComfyWorkflowStream(baseUrl, workflow, signal, opts)
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

type WsEvent =
  | { type: "progress"; value: number; max: number }
  | { type: "executing"; nodeId: string }
  | { type: "preview"; imageBase64: string }
  | { type: "complete" }
  | { type: "error"; message: string }

async function* wsEventStream(
  ws: WebSocket,
  promptId: string,
  signal?: AbortSignal,
): AsyncGenerator<WsEvent, void, unknown> {
  const queue: WsEvent[] = []
  let resolve: (() => void) | null = null
  let done = false

  const enqueue = (event: WsEvent) => {
    queue.push(event)
    if (resolve) {
      resolve()
      resolve = null
    }
  }

  ws.addEventListener("message", (evt) => {
    if (typeof evt.data === "string") {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === "execution_cached" && msg.data?.prompt_id === promptId) {
          // tracking only, no event surfaced
        } else if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
          enqueue({ type: "progress", value: msg.data.value, max: msg.data.max })
        } else if (msg.type === "executing" && msg.data?.prompt_id === promptId) {
          if (msg.data.node === null) {
            enqueue({ type: "complete" })
          } else {
            enqueue({ type: "executing", nodeId: String(msg.data.node) })
          }
        } else if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
          enqueue({ type: "error", message: msg.data.exception_message || "Execution error" })
        }
      } catch {
        // malformed JSON — ignore
      }
    } else {
      // Binary preview frame. ComfyUI prefixes with an 8-byte header
      // describing the image format/encoding; we strip it and surface PNG.
      const buffer = Buffer.from(evt.data as ArrayBuffer)
      const imageData = buffer.subarray(8)
      const base64 = imageData.toString("base64")
      enqueue({ type: "preview", imageBase64: `data:image/png;base64,${base64}` })
    }
  })

  ws.addEventListener("close", () => {
    done = true
    if (resolve) {
      resolve()
      resolve = null
    }
  })

  signal?.addEventListener("abort", () => {
    done = true
    if (resolve) {
      resolve()
      resolve = null
    }
  })

  while (!done) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { resolve = r })
    }
    while (queue.length > 0) {
      const event = queue.shift()!
      yield event
      if (event.type === "complete" || event.type === "error") {
        return
      }
    }
  }
}

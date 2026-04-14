import type { ImageProvider } from "../provider"
import type { ImageProviderCapabilities, ImageParameterSchemaMap } from "../param-schema"
import type { ImageGenRequest, ImageGenResponse } from "../types"

const PARAMETERS: ImageParameterSchemaMap = {}

interface ComfyImageResult {
  filename: string
  subfolder?: string
  type?: string
}

export class ComfyUIImageProvider implements ImageProvider {
  readonly name = "comfyui"
  readonly displayName = "ComfyUI"

  readonly capabilities: ImageProviderCapabilities = {
    parameters: PARAMETERS,
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:8188",
  }

  async generate(
    _apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): Promise<ImageGenResponse> {
    const baseUrl = apiUrl || this.capabilities.defaultUrl

    const workflow = request.parameters?.workflow
    if (!workflow || typeof workflow !== "object") {
      throw new Error("ComfyUI provider requires a pre-built workflow in parameters.workflow")
    }

    // Generate a client_id for tracking this generation
    const clientId = crypto.randomUUID()

    // Connect WebSocket for progress before queuing, so we don't miss early events
    const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`
    console.debug("[ComfyUI] Opening WS to %s (clientId=%s)", wsUrl, clientId)
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        console.debug("[ComfyUI] WS connected (clientId=%s)", clientId)
        resolve()
      })
      ws.addEventListener("error", (e) => reject(new Error(`ComfyUI WebSocket error: ${e}`)))
      setTimeout(() => reject(new Error("ComfyUI WebSocket connection timeout")), 10000)
    })

    // Queue the prompt
    const queueRes = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: request.signal,
    })

    if (!queueRes.ok) {
      ws.close()
      const errorBody = await queueRes.text()
      throw new Error("ComfyUI rejected workflow: " + errorBody)
    }

    const queueData = (await queueRes.json()) as { prompt_id: string }
    const promptId = queueData.prompt_id
    console.debug("[ComfyUI] Prompt queued (promptId=%s, clientId=%s)", promptId, clientId)

    // Wait for execution to complete via WebSocket events
    try {
      for await (const event of this.wsEvents(ws, promptId, request.signal)) {
        if (event.type === "complete") {
          break
        } else if (event.type === "error") {
          throw new Error(`ComfyUI execution error: ${event.message}`)
        }
        // progress and preview events are consumed but not surfaced (no streaming in generate())
      }
    } finally {
      ws.close()
    }

    // Fetch the generated image from history
    console.debug("[ComfyUI] Fetching history for promptId=%s", promptId)
    const historyRes = await fetch(`${baseUrl}/history/${promptId}`, { signal: request.signal })
    if (!historyRes.ok) {
      throw new Error(`ComfyUI history fetch failed: ${historyRes.status}`)
    }

    const history = (await historyRes.json()) as Record<string, any>
    const outputs = history[promptId]?.outputs
    if (!outputs) {
      const historyKeys = Object.keys(history)
      const entryKeys = history[promptId] ? Object.keys(history[promptId]) : []
      console.error("[ComfyUI] No outputs in history. promptId=%s, historyKeys=%j, entryKeys=%j", promptId, historyKeys, entryKeys)
      throw new Error("No outputs in ComfyUI history")
    }

    const imageResult = findFirstComfyImageResult(outputs)
    if (!imageResult) {
      logOutputsShape(outputs, promptId)
      throw new Error("No image output found in ComfyUI results")
    }
    console.debug("[ComfyUI] Found image result: filename=%s subfolder=%s type=%s", imageResult.filename, imageResult.subfolder, imageResult.type)

    // Fetch the image data
    const imageUrl = buildComfyImageViewUrl(baseUrl, imageResult)
    const imageRes = await fetch(imageUrl, { signal: request.signal })
    if (!imageRes.ok) throw new Error(`Failed to fetch ComfyUI output image: ${imageRes.status}`)

    const imageBuffer = await imageRes.arrayBuffer()
    const base64 = Buffer.from(imageBuffer).toString("base64")
    const mimeType = imageRes.headers.get("content-type") || "image/png"
    const imageDataUrl = `data:${mimeType};base64,${base64}`

    return {
      imageDataUrl,
      model: request.model || "comfyui-workflow",
      provider: this.name,
    }
  }

  async *generateStream(
    _apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): AsyncGenerator<
    { step?: number; totalSteps?: number; preview?: string; nodeId?: string },
    ImageGenResponse,
    unknown
  > {
    const baseUrl = apiUrl || this.capabilities.defaultUrl!

    const workflow = request.parameters?.workflow
    if (!workflow || typeof workflow !== "object") {
      throw new Error("ComfyUI provider requires a pre-built workflow in parameters.workflow")
    }

    const clientId = crypto.randomUUID()
    const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", (e) => reject(new Error(`ComfyUI WebSocket error: ${e}`)))
      setTimeout(() => reject(new Error("ComfyUI WebSocket connection timeout")), 10000)
    })

    const queueRes = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: request.signal,
    })

    if (!queueRes.ok) {
      ws.close()
      const errorBody = await queueRes.text()
      throw new Error("ComfyUI rejected workflow: " + errorBody)
    }

    const queueData = (await queueRes.json()) as { prompt_id: string }
    const promptId = queueData.prompt_id
    console.debug("[ComfyUI] [stream] Prompt queued (promptId=%s, clientId=%s)", promptId, clientId)

    try {
      for await (const event of this.wsEventsWithNodes(ws, promptId, request.signal)) {
        if (event.type === "complete") {
          break
        } else if (event.type === "error") {
          throw new Error(`ComfyUI execution error: ${event.message}`)
        } else if (event.type === "progress") {
          yield { step: event.value, totalSteps: event.max }
        } else if (event.type === "executing") {
          yield { nodeId: event.nodeId }
        } else if (event.type === "preview") {
          yield { preview: event.imageBase64 }
        }
      }
    } finally {
      ws.close()
    }

    console.debug("[ComfyUI] [stream] Fetching history for promptId=%s", promptId)
    const historyRes = await fetch(`${baseUrl}/history/${promptId}`, { signal: request.signal })
    if (!historyRes.ok) {
      throw new Error(`ComfyUI history fetch failed: ${historyRes.status}`)
    }

    const history = (await historyRes.json()) as Record<string, any>
    const outputs = history[promptId]?.outputs
    if (!outputs) {
      const historyKeys = Object.keys(history)
      const entryKeys = history[promptId] ? Object.keys(history[promptId]) : []
      console.error("[ComfyUI] [stream] No outputs in history. promptId=%s, historyKeys=%j, entryKeys=%j", promptId, historyKeys, entryKeys)
      throw new Error("No outputs in ComfyUI history")
    }

    const imageResult = findFirstComfyImageResult(outputs)
    if (!imageResult) {
      logOutputsShape(outputs, promptId)
      throw new Error("No image output found in ComfyUI results")
    }
    console.debug("[ComfyUI] [stream] Found image result: filename=%s subfolder=%s type=%s", imageResult.filename, imageResult.subfolder, imageResult.type)

    const imageUrl = buildComfyImageViewUrl(baseUrl, imageResult)
    const imageRes = await fetch(imageUrl, { signal: request.signal })
    if (!imageRes.ok) throw new Error(`Failed to fetch ComfyUI output image: ${imageRes.status}`)

    const imageBuffer = await imageRes.arrayBuffer()
    const base64 = Buffer.from(imageBuffer).toString("base64")
    const mimeType = imageRes.headers.get("content-type") || "image/png"

    return {
      imageDataUrl: `data:${mimeType};base64,${base64}`,
      model: request.model || "comfyui-workflow",
      provider: this.name,
    }
  }

  async validateKey(_apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${apiUrl || this.capabilities.defaultUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(_apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    try {
      const baseUrl = apiUrl || this.capabilities.defaultUrl
      const res = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return []

      const data = (await res.json()) as any
      const checkpoints: string[] =
        data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []

      return checkpoints.map((name) => ({
        id: name,
        label: name.replace(/\.[^.]+$/, ""), // Strip file extension for display
      }))
    } catch {
      return []
    }
  }

  private async *wsEventsWithNodes(
    ws: WebSocket,
    promptId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<
    | { type: "progress"; value: number; max: number }
    | { type: "executing"; nodeId: string }
    | { type: "preview"; imageBase64: string }
    | { type: "complete" }
    | { type: "error"; message: string }
  > {
    const queue: Array<any> = []
    let resolve: (() => void) | null = null
    let done = false

    const enqueue = (event: any) => {
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
            console.debug("[ComfyUI] [stream] execution_cached nodes=%j (promptId=%s)", msg.data.nodes, promptId)
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
          // ignore malformed JSON
        }
      } else {
        const buffer = Buffer.from(evt.data as ArrayBuffer)
        const imageData = buffer.subarray(8)
        const base64 = imageData.toString("base64")
        enqueue({ type: "preview", imageBase64: `data:image/png;base64,${base64}` })
      }
    })

    ws.addEventListener("close", (e) => {
      console.debug("[ComfyUI] [stream] WS closed (code=%s, reason=%s, promptId=%s)", (e as any).code, (e as any).reason, promptId)
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

  /**
   * Internal async generator that yields parsed WebSocket events from ComfyUI.
   */
  private async *wsEvents(
    ws: WebSocket,
    promptId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<
    | { type: "progress"; value: number; max: number }
    | { type: "preview"; imageBase64: string }
    | { type: "complete" }
    | { type: "error"; message: string }
  > {
    const queue: Array<any> = []
    let resolve: (() => void) | null = null
    let done = false

    const enqueue = (event: any) => {
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
            console.debug("[ComfyUI] execution_cached nodes=%j (promptId=%s)", msg.data.nodes, promptId)
          } else if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
            enqueue({ type: "progress", value: msg.data.value, max: msg.data.max })
          } else if (msg.type === "executing" && msg.data?.prompt_id === promptId) {
            if (msg.data.node === null) {
              enqueue({ type: "complete" })
            }
          } else if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
            enqueue({ type: "error", message: msg.data.exception_message || "Execution error" })
          }
        } catch {
          // ignore malformed JSON
        }
      } else {
        // Binary data = preview image
        const buffer = Buffer.from(evt.data as ArrayBuffer)
        // ComfyUI sends 8 bytes of header before the image data
        const imageData = buffer.subarray(8)
        const base64 = imageData.toString("base64")
        enqueue({ type: "preview", imageBase64: `data:image/png;base64,${base64}` })
      }
    })

    ws.addEventListener("close", (e) => {
      console.debug("[ComfyUI] WS closed (code=%s, reason=%s, promptId=%s)", (e as any).code, (e as any).reason, promptId)
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
}

/**
 * Log a summary of the ComfyUI output shape when no image is found.
 */
function logOutputsShape(outputs: Record<string, any>, promptId: string): void {
  try {
    const summary: Record<string, { keys: string[]; imageCount: number; imageShape?: any }> = {}
    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      const keys = nodeOutput && typeof nodeOutput === "object" ? Object.keys(nodeOutput) : []
      const images = Array.isArray(nodeOutput?.images) ? nodeOutput.images : []
      summary[nodeId] = {
        keys,
        imageCount: images.length,
        ...(images.length > 0 && images[0]
          ? { imageShape: Object.keys(images[0]) }
          : {}),
      }
    }
    console.error(
      "[ComfyUI] No image found in outputs. promptId=%s nodeCount=%d outputShape=%j",
      promptId,
      Object.keys(outputs).length,
      summary,
    )
  } catch {
    console.error("[ComfyUI] No image found in outputs and failed to log shape. promptId=%s", promptId)
  }
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

export function buildComfyImageViewUrl(
  baseUrl: string,
  image: ComfyImageResult,
): string {
  return `${baseUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`
}

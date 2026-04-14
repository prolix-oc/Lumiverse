import type { ImageProvider } from "../provider"
import type { ImageProviderCapabilities, ImageParameterSchemaMap } from "../param-schema"
import type { ImageGenRequest, ImageGenResponse } from "../types"
import { applyRawOverride } from "../types"

const PARAMETERS: ImageParameterSchemaMap = {
  width: {
    type: "integer",
    min: 64,
    max: 4096,
    default: 1024,
    step: 64,
    description: "Image width in pixels",
  },
  height: {
    type: "integer",
    min: 64,
    max: 4096,
    default: 1024,
    step: 64,
    description: "Image height in pixels",
  },
  steps: {
    type: "integer",
    min: 1,
    max: 150,
    default: 20,
    description: "Number of sampling steps",
  },
  cfgScale: {
    type: "number",
    min: 1,
    max: 30,
    default: 7,
    step: 0.5,
    description: "Classifier-free guidance scale",
  },
  seed: {
    type: "integer",
    default: -1,
    description: "Random seed (-1 for random)",
    group: "advanced",
  },
  sampler: {
    type: "string",
    description: "Sampler name (e.g. euler, euler_ancestral, dpmpp_2m)",
    group: "advanced",
  },
  scheduler: {
    type: "string",
    description: "Scheduler name (e.g. normal, karras, sgm_uniform)",
    group: "advanced",
  },
  negativePrompt: {
    type: "string",
    description: "Negative prompt",
  },
  vae: {
    type: "string",
    description: "VAE model override (leave empty for default built-in VAE)",
    group: "models",
    modelSubtype: "vae",
  },
  clipLModel: {
    type: "string",
    description: "CLIP-L text encoder model, for SD3/Flux-style diffusion models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  clipGModel: {
    type: "string",
    description: "CLIP-G text encoder model, for SD3-style diffusion models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  t5XXLModel: {
    type: "string",
    description: "T5-XXL text encoder model, for SD3/Flux-style diffusion models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  qwenModel: {
    type: "string",
    description: "Qwen text encoder model, for OmniGen/QwenImage-style models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  mistralModel: {
    type: "string",
    description: "Mistral text encoder model, for Flux.2-style models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  gemmaModel: {
    type: "string",
    description: "Gemma text encoder model, for Lumina2/LTX2-style models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  llamaModel: {
    type: "string",
    description: "LLaMA text encoder model, for HiDream-style models",
    group: "models",
    modelSubtype: "text_encoders",
  },
  rawRequestOverride: {
    type: "string",
    description: "Raw JSON merged into the request body for advanced usage",
    group: "advanced",
  },
}

/** Cached SwarmUI session entry. */
interface SessionEntry {
  sessionId: string
  expiresAt: number
}

/** 25 minutes — SwarmUI sessions typically last 30. */
const SESSION_TTL_MS = 25 * 60 * 1000

export class SwarmUIImageProvider implements ImageProvider {
  readonly name = "swarmui"
  readonly displayName = "SwarmUI"

  readonly capabilities: ImageProviderCapabilities = {
    parameters: PARAMETERS,
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:7801",
  }

  // ── Session management ────────────────────────────────────────────────

  /**
   * In-memory session cache keyed by `baseUrl\0token`.
   * Sessions are re-fetched automatically on expiry or `invalid_session_id`.
   */
  private sessions = new Map<string, SessionEntry>()

  private sessionKey(baseUrl: string, token?: string): string {
    return `${baseUrl}\0${token ?? ""}`
  }

  private async getSession(
    baseUrl: string,
    token?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = this.sessionKey(baseUrl, token)
    const cached = this.sessions.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.sessionId

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers.Cookie = `swarm_token=${token}`

    const res = await fetch(`${baseUrl}/API/GetNewSession`, {
      method: "POST",
      headers,
      body: "{}",
      signal: signal ?? AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`SwarmUI session request failed: ${res.status} ${await res.text().catch(() => "")}`)
    }

    const data = (await res.json()) as Record<string, any>
    const sessionId = data.session_id
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("SwarmUI returned no session_id")
    }

    this.sessions.set(key, { sessionId, expiresAt: Date.now() + SESSION_TTL_MS })
    return sessionId
  }

  private invalidateSession(baseUrl: string, token?: string): void {
    this.sessions.delete(this.sessionKey(baseUrl, token))
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private baseUrl(apiUrl: string): string {
    return (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "")
  }

  private buildHeaders(token?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" }
    if (token) h.Cookie = `swarm_token=${token}`
    return h
  }

  /** Build the generation request body in SwarmUI's flat parameter format. */
  private buildBody(sessionId: string, request: ImageGenRequest): Record<string, any> {
    const p = request.parameters ?? {}

    const body: Record<string, any> = {
      session_id: sessionId,
      images: 1,
      prompt: request.prompt,
      model: request.model,
      // SwarmUI only honors explicit width/height when aspectratio is "Custom".
      // Otherwise the server derives dimensions from `sidelength` + the selected
      // aspect ratio preset (default "1:1") and our width/height are ignored.
      aspectratio: "Custom",
      width: Number(p.width) || 1024,
      height: Number(p.height) || 1024,
    }

    if (p.steps != null && Number.isFinite(Number(p.steps))) body.steps = Number(p.steps)
    if (p.cfgScale != null && Number.isFinite(Number(p.cfgScale))) body.cfgscale = Number(p.cfgScale)
    if (p.seed != null && Number.isFinite(Number(p.seed))) body.seed = Number(p.seed)
    if (p.sampler) body.sampler = String(p.sampler)
    if (p.scheduler) body.scheduler = String(p.scheduler)

    const neg = request.negativePrompt || p.negativePrompt
    if (neg) body.negativeprompt = String(neg)

    // Model component overrides (VAE, text encoders)
    // Parameter IDs match SwarmUI's CleanTypeName: lowercase-letters-only of the display name
    if (p.vae) body.vae = String(p.vae)
    if (p.clipLModel) body.cliplmodel = String(p.clipLModel)
    if (p.clipGModel) body.clipgmodel = String(p.clipGModel)
    if (p.t5XXLModel) body.txxlmodel = String(p.t5XXLModel)
    if (p.qwenModel) body.qwenmodel = String(p.qwenModel)
    if (p.mistralModel) body.mistralmodel = String(p.mistralModel)
    if (p.gemmaModel) body.gemmamodel = String(p.gemmaModel)
    if (p.llamaModel) body.llamamodel = String(p.llamaModel)

    return applyRawOverride(body, p.rawRequestOverride)
  }

  /** Fetch an image from a SwarmUI-relative path and return a data URL. */
  private async fetchImage(
    baseUrl: string,
    imagePath: string,
    token?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Already a data URL
    if (imagePath.startsWith("data:")) return imagePath

    const url = `${baseUrl}/${imagePath.replace(/^\/+/, "")}`
    const headers: Record<string, string> = {}
    if (token) headers.Cookie = `swarm_token=${token}`

    const res = await fetch(url, { headers, signal })
    if (!res.ok) {
      throw new Error(`Failed to fetch SwarmUI image: ${res.status}`)
    }

    const buf = await res.arrayBuffer()
    const base64 = Buffer.from(buf).toString("base64")
    const mime = res.headers.get("content-type") || "image/png"
    return `data:${mime};base64,${base64}`
  }

  // ── ImageProvider interface ───────────────────────────────────────────

  async generate(
    apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): Promise<ImageGenResponse> {
    const base = this.baseUrl(apiUrl)
    const token = apiKey || undefined

    let sessionId = await this.getSession(base, token, request.signal)
    let body = this.buildBody(sessionId, request)

    let res = await fetch(`${base}/API/GenerateText2Image`, {
      method: "POST",
      headers: this.buildHeaders(token),
      body: JSON.stringify(body),
      signal: request.signal,
    })

    // Retry once on invalid session
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (text.includes("invalid_session_id") || text.includes("Invalid session")) {
        this.invalidateSession(base, token)
        sessionId = await this.getSession(base, token, request.signal)
        body = this.buildBody(sessionId, request)
        res = await fetch(`${base}/API/GenerateText2Image`, {
          method: "POST",
          headers: this.buildHeaders(token),
          body: JSON.stringify(body),
          signal: request.signal,
        })
      }
      if (!res.ok) {
        throw new Error(`SwarmUI generation error ${res.status}: ${text || await res.text().catch(() => "Unknown")}`)
      }
    }

    const data = (await res.json()) as Record<string, any>

    if (data.error || data.error_id) {
      throw new Error(`SwarmUI error: ${data.error || data.error_id}`)
    }

    const images: string[] = Array.isArray(data.images) ? data.images : []
    if (images.length === 0) {
      throw new Error("SwarmUI returned no images")
    }

    const imageDataUrl = await this.fetchImage(base, images[0], token, request.signal)

    return {
      imageDataUrl,
      model: request.model || "unknown",
      provider: this.name,
    }
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): AsyncGenerator<
    { step?: number; totalSteps?: number; preview?: string; nodeId?: string },
    ImageGenResponse,
    unknown
  > {
    const base = this.baseUrl(apiUrl)
    const token = apiKey || undefined
    const sessionId = await this.getSession(base, token, request.signal)

    const wsUrl = base.replace(/^http/, "ws") + "/API/GenerateText2ImageWS"
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", (e) => reject(new Error(`SwarmUI WebSocket error: ${e}`)))
      setTimeout(() => reject(new Error("SwarmUI WebSocket connection timeout")), 15_000)
    })

    // Send the generation parameters as the initial message
    const body = this.buildBody(sessionId, request)
    ws.send(JSON.stringify(body))

    let imagePath: string | null = null

    try {
      for await (const event of this.wsEvents(ws, request.signal)) {
        if (event.type === "progress") {
          yield {
            step: event.step,
            totalSteps: event.totalSteps,
            preview: event.preview,
          }
        } else if (event.type === "image") {
          imagePath = event.path
        } else if (event.type === "error") {
          throw new Error(`SwarmUI generation error: ${event.message}`)
        } else if (event.type === "complete") {
          break
        }
      }
    } finally {
      ws.close()
    }

    if (!imagePath) {
      throw new Error("SwarmUI WebSocket completed without producing an image")
    }

    const imageDataUrl = await this.fetchImage(base, imagePath, token, request.signal)

    return {
      imageDataUrl,
      model: request.model || "unknown",
      provider: this.name,
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const base = this.baseUrl(apiUrl)
      await this.getSession(base, apiKey || undefined)
      return true
    } catch {
      return false
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    return this.fetchModelList(apiKey, apiUrl, { path: "", depth: 2, subtype: "Stable-Diffusion" })
  }

  async listModelsBySubtype(
    apiKey: string,
    apiUrl: string,
    subtype: string,
  ): Promise<Array<{ id: string; label: string }>> {
    switch (subtype) {
      case "vae":
        return this.fetchModelList(apiKey, apiUrl, { path: "", depth: 2, subtype: "VAE" })
      case "text_encoders":
        // Text encoders live in the text_encoders/ folder regardless of base model subtype
        return this.fetchModelList(apiKey, apiUrl, { path: "text_encoders", depth: 1, subtype: "" })
      default:
        return []
    }
  }

  private async fetchModelList(
    apiKey: string,
    apiUrl: string,
    query: { path: string; depth: number; subtype: string },
  ): Promise<Array<{ id: string; label: string }>> {
    try {
      const base = this.baseUrl(apiUrl)
      const token = apiKey || undefined
      const sessionId = await this.getSession(base, token)

      const body: Record<string, any> = {
        session_id: sessionId,
        path: query.path,
        depth: query.depth,
      }
      if (query.subtype) body.subtype = query.subtype

      const res = await fetch(`${base}/API/ListModels`, {
        method: "POST",
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) return []

      const data = (await res.json()) as Record<string, any>

      // Response: { folders: [...], files: [{ name, title, ... }] }
      const models: Array<{ id: string; label: string }> = []
      const files: any[] = Array.isArray(data.files) ? data.files : []

      for (const f of files) {
        const id = typeof f === "string" ? f : String(f?.name ?? "")
        if (id) models.push({ id, label: modelLabel(id) })
      }

      return models
    } catch {
      return []
    }
  }

  // ── WebSocket event stream ────────────────────────────────────────────

  private async *wsEvents(
    ws: WebSocket,
    signal?: AbortSignal,
  ): AsyncGenerator<
    | { type: "progress"; step: number; totalSteps: number; preview?: string }
    | { type: "image"; path: string }
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
      if (typeof evt.data !== "string") return
      try {
        const msg = JSON.parse(evt.data) as Record<string, any>

        // Error message
        if (msg.error || msg.error_id) {
          enqueue({ type: "error", message: String(msg.error || msg.error_id) })
          return
        }

        // Image result — may come as a standalone field or alongside gen_progress
        if (typeof msg.image === "string" && msg.image) {
          enqueue({ type: "image", path: msg.image })
        }

        // Progress update
        const gp = msg.gen_progress
        if (gp && typeof gp === "object") {
          const overall = typeof gp.overall_percent === "number" ? gp.overall_percent : null
          const current = typeof gp.current_percent === "number" ? gp.current_percent : null
          const pct = overall ?? current

          if (pct != null) {
            // Map 0-1 percentage to step/totalSteps (use 100 as synthetic total)
            const totalSteps = 100
            const step = Math.round(pct * totalSteps)
            const preview =
              typeof gp.preview === "string" && gp.preview ? gp.preview : undefined
            enqueue({ type: "progress", step, totalSteps, preview })
          }
        }

        // Discard indices signal (marks the end of generation for our batch)
        if (Array.isArray(msg.discard_indices)) {
          enqueue({ type: "complete" })
        }
      } catch {
        // Ignore malformed JSON
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
        await new Promise<void>((r) => {
          resolve = r
        })
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

/** Strip directory prefix and file extension for a cleaner display label. */
function modelLabel(name: string): string {
  const base = name.includes("/") ? name.split("/").pop()! : name
  return base.replace(/\.[^.]+$/, "")
}

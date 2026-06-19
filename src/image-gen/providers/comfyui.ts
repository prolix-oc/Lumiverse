import type { ImageProvider } from "../provider"
import type { ComfyUICapabilities } from "../types"
import type { ImageProviderCapabilities, ImageParameterSchemaMap } from "../param-schema"
import type { ImageGenRequest, ImageGenResponse } from "../types"
import { discoverCapabilities } from "../comfyui-discovery"
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors"
import { executeComfyWorkflow, executeComfyWorkflowStream } from "./comfy-runner"

const PARAMETERS: ImageParameterSchemaMap = {
  seed: { type: "integer", description: "Seed injected into mapped ComfyUI workflow seed fields.", group: "advanced" },
  steps: { type: "integer", default: 28, min: 1, max: 80, step: 1, description: "Sampling steps injected into mapped ComfyUI workflow fields.", group: "advanced" },
  cfg: { type: "number", default: 7, min: 1, max: 20, step: 0.5, description: "CFG scale injected into mapped ComfyUI workflow fields.", group: "advanced" },
  sampler_name: { type: "string", description: "Sampler injected into mapped ComfyUI workflow fields.", group: "advanced", modelSubtype: "samplers" },
  scheduler: { type: "string", description: "Scheduler injected into mapped ComfyUI workflow fields.", group: "advanced", modelSubtype: "schedulers" },
  width: { type: "integer", default: 1024, min: 256, max: 2048, step: 64, description: "Width injected into mapped ComfyUI workflow fields.", group: "advanced" },
  height: { type: "integer", default: 1024, min: 256, max: 2048, step: 64, description: "Height injected into mapped ComfyUI workflow fields.", group: "advanced" },
  checkpoint: { type: "string", description: "Checkpoint injected into mapped ComfyUI checkpoint fields.", group: "models", modelSubtype: "checkpoints" },
  denoise: { type: "number", default: 0.6, min: 0, max: 1, step: 0.05, description: "Denoise strength injected into a mapped KSampler denoise field for img2img (lower = closer to the source image). Requires an init_image-mapped workflow.", group: "img2img" },
}

/**
 * ComfyUI is intentionally a self-hosted service that often runs on
 * `localhost`/private IPs, so we can't pipe its requests through safeFetch
 * (which blocks private addresses). Instead we restrict the protocol to
 * http/https to keep `file://`, `ssh://`, and other surprising schemes from
 * being smuggled in via the apiUrl field.
 */
function assertSafeComfyUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("ComfyUI URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ComfyUI URL protocol "${parsed.protocol}" is not allowed`);
  }
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
    assertSafeComfyUrl(baseUrl)

    const workflow = request.parameters?.workflow
    if (!workflow || typeof workflow !== "object") {
      throw new Error("ComfyUI provider requires a pre-built workflow in parameters.workflow")
    }

    const { imageDataUrl } = await executeComfyWorkflow(
      baseUrl,
      workflow as Record<string, any>,
      request.signal,
      { label: "ComfyUI", wsTimeoutMs: 10_000 },
    )

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
    assertSafeComfyUrl(baseUrl)

    const workflow = request.parameters?.workflow
    if (!workflow || typeof workflow !== "object") {
      throw new Error("ComfyUI provider requires a pre-built workflow in parameters.workflow")
    }

    const stream = executeComfyWorkflowStream(
      baseUrl,
      workflow as Record<string, any>,
      request.signal,
      { label: "ComfyUI", wsTimeoutMs: 10_000 },
    )

    while (true) {
      const next = await stream.next()
      if (next.done) {
        return {
          imageDataUrl: next.value.imageDataUrl,
          model: request.model || "comfyui-workflow",
          provider: this.name,
        }
      }
      const event = next.value
      if (event.type === "progress") {
        yield { step: event.step, totalSteps: event.totalSteps }
      } else if (event.type === "executing") {
        yield { nodeId: event.nodeId }
      } else if (event.type === "preview") {
        yield { preview: event.imageBase64 }
      }
    }
  }

  async validateKey(_apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const baseUrl = apiUrl || this.capabilities.defaultUrl
      assertSafeComfyUrl(baseUrl!)
      const res = await fetch(`${baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) await throwProviderResponseError(this.displayName, "connection check", res)
      return res.ok
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err
      throw new ProviderRequestError({ provider: this.displayName, operation: "connection check", detail: err instanceof Error ? err.message : "network request failed", retryable: true })
    }
  }

  async listModels(_apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const baseUrl = apiUrl || this.capabilities.defaultUrl
    assertSafeComfyUrl(baseUrl!)
    const data = await fetchProviderJson<any>(this.displayName, "model listing", `${baseUrl}/object_info/CheckpointLoaderSimple`, {
      signal: AbortSignal.timeout(10000),
    })
    const checkpoints: string[] =
      data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []

    return checkpoints.map((name) => ({
      id: name,
      label: name.replace(/\.[^.]+$/, ""),
    }))
  }

  async listModelsBySubtype(
    _apiKey: string,
    apiUrl: string,
    subtype: string,
  ): Promise<Array<{ id: string; label: string }>> {
    const baseUrl = apiUrl || this.capabilities.defaultUrl
    assertSafeComfyUrl(baseUrl!)
    const capabilities = await discoverCapabilities(baseUrl!)
    const values = getCapabilityList(capabilities, subtype)
    return values.map((name) => ({ id: name, label: name.replace(/\.[^.]+$/, "") }))
  }
}

function getCapabilityList(capabilities: ComfyUICapabilities, subtype: string): string[] {
  switch (subtype) {
    case "checkpoints":
    case "checkpoint":
      return capabilities.checkpoints
    case "samplers":
    case "sampler_name":
      return capabilities.samplers
    case "schedulers":
    case "scheduler":
      return capabilities.schedulers
    case "vaes":
    case "vae":
      return capabilities.vaes
    case "loras":
    case "lora":
      return capabilities.loras
    case "unets":
    case "unet":
      return capabilities.unets
    case "clips":
    case "clip":
      return capabilities.clips
    case "dualClips":
    case "dual_clips":
      return capabilities.dualClips
    case "upscaleModels":
    case "upscale_models":
      return capabilities.upscaleModels
    case "detectorModels":
    case "detector_models":
      return capabilities.detectorModels
    default:
      return []
  }
}

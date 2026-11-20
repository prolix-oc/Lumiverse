import { loadWhistleAssets } from './assets'
import { WhistleRuntime } from './runtime'
import type { WhistleRequest, WhistleResponse } from './config'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WhistleRequest>) => void) | null
  postMessage(message: WhistleResponse): void
}
let runtime: WhistleRuntime | null = null
let queue = Promise.resolve()

worker.onmessage = ({ data: request }) => {
  // The native engine is not reentrant, including during model loading.
  queue = queue.then(async () => {
    try {
      if (!runtime) {
        const assets = await loadWhistleAssets((progress) => worker.postMessage({ type: 'progress', progress }))
        runtime = await WhistleRuntime.load(assets.wasm, assets.model)
      }
      if (request.type === 'prepare') worker.postMessage({ type: 'ready', id: request.id })
      else worker.postMessage({ type: 'result', id: request.id, result: runtime.transcribe(request.pcm, request.language, request.keywords) })
    } catch (error) {
      worker.postMessage({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

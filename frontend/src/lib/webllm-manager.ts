import { CreateMLCEngine, type MLCEngine, type InitProgressReport } from "@mlc-ai/web-llm";

// WebLLM: Singleton manager for the in-browser LLM engine lifecycle.
// The engine is expensive to initialize (model download + GPU compile),
// so we keep one instance and reuse it across generations.
class WebLLMManager {
  private engine: MLCEngine | null = null;
  private currentModelId: string | null = null;
  // WebLLM: module-level abort controller so any caller (InputArea, useSwipeAction)
  // can abort an in-progress generation without needing a shared React ref.
  private abortController: AbortController | null = null;

  isAvailable(): boolean {
    return !!(navigator as any).gpu;
  }

  isGenerating(): boolean {
    return this.abortController !== null;
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async loadModel(modelId: string, onProgress: (pct: number) => void): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error("WebGPU is not available on this device. Use a WebGPU-compatible browser (Chrome 113+, Edge 113+).");
    }

    // WebLLM: Reuse the engine if the same model is already loaded.
    if (this.engine && this.currentModelId === modelId) {
      return;
    }

    // Unload any previously loaded model to free GPU memory before loading a new one.
    if (this.engine) {
      try { await this.engine.unload(); } catch {}
      this.engine = null;
      this.currentModelId = null;
    }

    this.engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report: InitProgressReport) => {
        onProgress(Math.round(report.progress * 100));
      },
    });

    this.currentModelId = modelId;
  }

  async generateStream(
    messages: Array<{ role: string; content: string }>,
    onToken: (token: string) => void
  ): Promise<string> {
    if (!this.engine) {
      throw new Error("WebLLM engine not loaded. Call loadModel() first.");
    }

    // WebLLM: Create a fresh AbortController for this generation and register it
    // so any caller can abort via webllmManager.abort().
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const stream = await this.engine.chat.completions.create({
        messages: messages as any,
        stream: true,
        temperature: 1,
      });

      let fullContent = "";
      for await (const chunk of stream) {
        if (signal.aborted) break;
        const token = chunk.choices[0]?.delta.content ?? "";
        if (token) {
          onToken(token);
          fullContent += token;
        }
      }

      return fullContent;
    } finally {
      this.abortController = null;
    }
  }

  unload(): void {
    if (this.engine) {
      // WebLLM: Fire-and-forget — unload() is async but we don't need to await
      // it here since it's called on cleanup paths (provider switch, unmount).
      this.engine.unload().catch(() => {});
      this.engine = null;
      this.currentModelId = null;
    }
  }

  getCurrentModelId(): string | null {
    return this.currentModelId;
  }
}

export const webllmManager = new WebLLMManager();

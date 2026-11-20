import { PERMISSION_DENIED_PREFIX, type EmbeddingsWorkerMessage } from "lumiverse-spindle-types";
import { embedTextsWithConnection, listEmbeddingConnections } from "../services/embeddings.service";
import { clampErrorMessage } from "../utils/provider-errors";

type Context = {
  hasPermission: (permission: "embeddings") => boolean;
  resolveEffectiveUserId: (userId?: string) => string;
  enforceScopedUser: (userId: string) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};
export class WorkerHostEmbeddingsApi {
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly context: Context) {}
  async handle(message: EmbeddingsWorkerMessage): Promise<void> {
    if (message.type === "embeddings_cancel") {
      this.pending.get(message.requestId)?.abort();
      return;
    }
    try {
      if (!this.context.hasPermission("embeddings")) throw new Error(`${PERMISSION_DENIED_PREFIX} embeddings — Embeddings permission not granted`);
      const userId = this.context.resolveEffectiveUserId(message.type === "embeddings_embed" ? message.input?.userId : message.userId);
      if (!userId) throw new Error("userId is required for operator-scoped extensions");
      this.context.enforceScopedUser(userId);
      let result: unknown;
      if (message.type === "embeddings_connections_list") {
        result = await listEmbeddingConnections(userId);
      } else {
        if (this.pending.has(message.requestId)) throw new Error("Duplicate embeddings request ID");
        const { texts, connection_id, input_type } = message.input ?? {};
        const controller = new AbortController();
        this.pending.set(message.requestId, controller);
        try {
          result = await embedTextsWithConnection(userId, texts, { connectionId: connection_id, inputType: input_type, signal: controller.signal });
          controller.signal.throwIfAborted();
        } catch (error) {
          if (controller.signal.aborted) throw new Error("AbortError: Embeddings request cancelled");
          throw error;
        } finally {
          this.pending.delete(message.requestId);
        }
      }
      this.context.postResponse({ type: "response", requestId: message.requestId, result });
    } catch (error) {
      this.context.postResponse({ type: "response", requestId: message.requestId, error: clampErrorMessage(error instanceof Error ? error.message : "Embeddings operation failed") });
    }
  }
  dispose(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}

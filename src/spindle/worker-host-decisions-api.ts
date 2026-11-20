import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import type { DecisionEvaluationInput, DecisionWorkerMessage } from "../decision/contract";
import * as connections from "../services/decision-connections.service";
import { collectAll } from "../services/pagination";
import { withReadableApiKeyStatus, withReadableApiKeyStatuses } from "../services/connection-secret-status";
import { evaluateDecision } from "../services/decisions.service";
import { isRecord } from "../decision/validation";
import { clampErrorMessage } from "../utils/provider-errors";

type Context = {
  hasPermission: (permission: "decisions" | "images") => boolean;
  resolveEffectiveUserId: (userId?: string) => string;
  enforceScopedUser: (userId: string) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
};
export class WorkerHostDecisionsApi {
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly context: Context) {}
  async handle(message: DecisionWorkerMessage): Promise<void> {
    if (message.type === "decisions_cancel") {
      this.pending.get(message.requestId)?.abort();
      return;
    }
    try {
      if (!this.context.hasPermission("decisions")) throw new Error(`${PERMISSION_DENIED_PREFIX} decisions — Decision model permission not granted`);
      const userId = this.context.resolveEffectiveUserId(message.type === "decisions_evaluate" ? message.input?.userId : message.userId);
      if (!userId) throw new Error("userId is required for operator-scoped extensions");
      this.context.enforceScopedUser(userId);
      let result: unknown;
      switch (message.type) {
        case "decisions_providers": result = connections.listProviders(); break;
        case "decisions_connections_list": {
          const page = collectAll((pagination) => connections.listConnections(userId, pagination));
          result = (await withReadableApiKeyStatuses(userId, page, connections.decisionConnectionSecretKey)).data;
          break;
        }
        case "decisions_connection_get": {
          const profile = connections.getConnection(userId, message.connectionId);
          result = profile ? await withReadableApiKeyStatus(userId, profile, connections.decisionConnectionSecretKey) : null;
          break;
        }
        case "decisions_models": {
          const models = await connections.listConnectionModels(userId, message.connectionId);
          if (models.error) throw new Error(models.error);
          result = models.models;
          break;
        }
        case "decisions_evaluate": {
          if (this.pending.has(message.requestId)) throw new Error("Duplicate Decision request ID");
          const assets = (message.input as DecisionEvaluationInput).assets;
          if (assets && Object.values(assets).some((asset) => isRecord(asset) && "image_id" in asset) && !this.context.hasPermission("images")) {
            throw new Error(`${PERMISSION_DENIED_PREFIX} images — Decision image_id assets require the images permission`);
          }
          const controller = new AbortController();
          this.pending.set(message.requestId, controller);
          try { result = await evaluateDecision(userId, message.input, controller.signal); }
          finally { this.pending.delete(message.requestId); }
          break;
        }
      }
      this.context.postResponse({ type: "response", requestId: message.requestId, result });
    } catch (error) {
      this.context.postResponse({ type: "response", requestId: message.requestId, error: clampErrorMessage(error instanceof Error ? error.message : "Decision operation failed") });
    }
  }
  dispose(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}

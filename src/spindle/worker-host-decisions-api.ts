import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { evaluate } from "../services/decision-connections.service";
import type { DecisionRequest } from "../decisions/types";

export class WorkerHostDecisionsApi {
  constructor(private readonly context: {
    hasPermission: (permission: string) => boolean;
    resolveEffectiveUserId: () => string;
    enforceScopedUser: (userId: string) => void;
    post: (message: unknown) => void;
  }) {}

  async handleEvaluate(requestId: string, input: DecisionRequest): Promise<void> {
    try {
      if (!this.context.hasPermission("decisions")) throw new Error(`${PERMISSION_DENIED_PREFIX} decisions — Decision evaluation permission not granted`);
      const userId = this.context.resolveEffectiveUserId();
      if (!userId) throw new Error("A user context is required for decisions");
      this.context.enforceScopedUser(userId);
      const result = await evaluate(userId, input);
      this.context.post({ type: "response", requestId, result });
    } catch (error) {
      this.context.post({ type: "response", requestId, error: error instanceof Error ? error.message : "Decision evaluation failed" });
    }
  }
}

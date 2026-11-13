import { Hono } from "hono";
import { DecisionValidationError } from "../decision/validation";
import { DecisionConnectionNotFoundError, DecisionTimeoutError, evaluateDecision } from "../services/decisions.service";
import { ProviderRequestError, clampErrorMessage } from "../utils/provider-errors";
import type { DecisionEvaluationInput } from "../decision/contract";

const app = new Hono();
app.post("/evaluate", async (c) => {
  try {
    const input = await c.req.json<DecisionEvaluationInput>();
    const result = await evaluateDecision(c.get("userId"), input, c.req.raw.signal);
    return c.json(result);
  } catch (error) {
    const status = error instanceof DecisionValidationError || error instanceof SyntaxError ? 400
      : error instanceof DecisionConnectionNotFoundError ? 404
      : error instanceof DecisionTimeoutError ? 504
      : error instanceof ProviderRequestError ? 502 : 400;
    return c.json({ error: clampErrorMessage(error instanceof Error ? error.message : "Decision evaluation failed") }, status);
  }
});
export { app as decisionsRoutes };

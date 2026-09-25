export type DecisionData = string | Record<string, unknown> | unknown[];

export type DecisionQuestion =
  | { type: "choice"; instructions: DecisionData; criteria: Record<string, DecisionData | null> }
  | { type: "score"; instructions: DecisionData; criteria: DecisionData[] }
  | { type: "noul"; instructions: DecisionData; criteria?: { true?: DecisionData; false?: DecisionData } };

export interface DecisionRequest {
  connectionId?: string;
  state: DecisionData;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export function validateDecisionRequest(input: unknown): asserts input is DecisionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Decision request must be an object");
  const request = input as Record<string, unknown>;
  if ("userId" in request || "user_id" in request) throw new Error("Decision requests cannot specify a user ID");
  if (request.connectionId !== undefined && typeof request.connectionId !== "string") throw new Error("connectionId must be a string");
  if (!isDecisionData(request.state)) throw new Error("state must be a string, object, or array");
  if (!request.questions || typeof request.questions !== "object" || Array.isArray(request.questions)) throw new Error("questions must be a named map");
  const questions = Object.entries(request.questions as Record<string, unknown>);
  if (questions.length === 0 || questions.length > 100) throw new Error("questions must contain 1 to 100 entries");
  for (const [id, raw] of questions) {
    if (!id || ["__proto__", "constructor", "prototype"].includes(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid question ${id}`);
    const question = raw as Record<string, unknown>;
    if (!isDecisionData(question.instructions)) throw new Error(`Question ${id} requires structured instructions`);
    if (question.type === "choice") {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw new Error(`Question ${id} requires choice criteria`);
      const options = Object.entries(criteria as Record<string, unknown>);
      if (options.length < 2 || options.length > 255 || options.some(([key, value]) => !key || (value !== null && !isDecisionData(value)))) throw new Error(`Question ${id} has invalid choice criteria`);
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 || !question.criteria.every(isDecisionData)) throw new Error(`Question ${id} requires 2 to 10 score levels`);
    } else if (question.type === "noul") {
      const criteria = question.criteria;
      if (criteria !== undefined && (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.entries(criteria as Record<string, unknown>).some(([key, value]) => !["true", "false"].includes(key) || !isDecisionData(value)))) throw new Error(`Question ${id} has invalid noul criteria`);
    } else throw new Error(`Question ${id} has an unknown primitive`);
  }
}

function isDecisionData(value: unknown): value is DecisionData {
  return typeof value === "string" || (!!value && typeof value === "object");
}

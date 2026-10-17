/** Shared Decision contract supplied by the published Spindle SDK. */
import type * as Sdk from "lumiverse-spindle-types";
export type {
  DecisionJsonValue,
  DecisionDescription,
  DecisionState,
  DecisionConnectionProfileDTO,
  DecisionModelDTO,
  DecisionProviderDTO,
  SpindleDecisionsAPI,
  DecisionWorkerMessage,
} from "lumiverse-spindle-types";

// Box questions and image assets: host additions pending publication in lumiverse-spindle-types.
// After the package bump these return to plain re-exports.
export type DecisionImageAsset =
  | { type?: "image"; format: "png" | "jpg" | "jpeg"; data_base64: string }
  | { type?: "image"; image_id: string };
export interface DecisionBox { top: number; bottom: number; left: number; right: number }
export type DecisionQuestion = Sdk.DecisionQuestion | { type: "box"; instructions: Sdk.DecisionDescription };
export type DecisionAnswer = Sdk.DecisionAnswer | { type: "box"; box: DecisionBox; confidence: number };
export type DecisionAnswerFor<Q extends DecisionQuestion> = Q extends Sdk.DecisionQuestion ? Sdk.DecisionAnswerFor<Q> : Extract<DecisionAnswer, { type: "box" }>;
export type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = { [K in keyof Q]: DecisionAnswerFor<Q[K]> };
export interface DecisionResult<Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>> extends Omit<Sdk.DecisionResult, "answers"> {
  answers: DecisionAnswers<Q>;
}
export interface DecisionEvaluationInput<Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>> extends Omit<Sdk.DecisionEvaluationInput, "questions"> {
  questions: Q;
  assets?: Record<string, DecisionImageAsset>;
}

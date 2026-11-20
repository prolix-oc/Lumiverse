import type { GenerationParameters } from "./types";

const PENALTY_PARAMETERS = [
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
] as const;

/** Disabled penalties must be omitted, including values from custom bodies or request overrides. */
export function omitDisabledPenalties(parameters?: GenerationParameters): GenerationParameters {
  const params = { ...parameters };
  for (const key of PENALTY_PARAMETERS) {
    if (params[key] == null || params[key] === 0) delete params[key];
  }
  // Repetition penalty is a multiplier: 1 is neutral. Additive penalties remain active at 1.
  if (params.repetition_penalty === 1) delete params.repetition_penalty;
  return params;
}

import type { MacroEnv } from "../../macros/types";
import type { RegexScript } from "../../types/regex-script";
import { healFormattingArtifacts } from "../../utils/format-healing";
import { applyRegexScripts } from "../regex-scripts.service";
import type { VariableValues } from "../../utils/variable-checkpoint";

export interface PreparedResponseContext {
  env?: MacroEnv;
  presetId?: string;
  characterId?: string;
  model?: string;
  before: VariableValues;
  revision: string | null;
  prefill: string;
  reasoningPrefill: string;
  trimIncompleteWords: boolean;
}

export async function processResponseText(
  content: string,
  reasoning: string,
  scripts: RegexScript[],
  env: MacroEnv | undefined,
  options: { source: "response_backend"; previousContent?: string },
): Promise<{ content: string; reasoning: string }> {
  if (scripts.length) {
    content = await applyRegexScripts(content, scripts, "ai_output", 0, env, undefined, options);
    if (reasoning) reasoning = await applyRegexScripts(reasoning, scripts, "reasoning", 0, env, undefined, options);
  }
  return { content: healFormattingArtifacts(content), reasoning };
}

import type { RegexPromptActivation, RegexScript } from "../types/regex-script";
import { regexCollectSandboxed } from "./regex-sandbox";

export const MAX_ACTIVATION_CONTENT_LENGTH = 500_000;

export function validatePromptActivation(value: unknown): string | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "prompt_activation must be an object";
  const config = value as RegexPromptActivation;
  if (config.source !== "user_input" && config.source !== "ai_output") return "prompt_activation source must be user_input or ai_output";
  if (config.lifetime !== "latest" && config.lifetime !== "chat") return "prompt_activation lifetime must be latest or chat";
  if (!Array.isArray(config.mappings) || config.mappings.length === 0 || config.mappings.length > 64) {
    return "prompt_activation requires between 1 and 64 mappings";
  }
  for (const mapping of config.mappings) {
    if (!mapping || typeof mapping !== "object") return "Invalid prompt activation mapping";
    if (typeof mapping.capture !== "string" || !/^(?:[0-9]|[1-9][0-9]|[A-Za-z_][A-Za-z0-9_]{0,63})$/.test(mapping.capture)) {
      return "Activation capture must be 0, a group number (1–99), or a group name";
    }
    const values = Array.isArray(mapping.value) ? mapping.value : [mapping.value];
    if (values.length === 0 || values.length > 64) return "Each activation mapping requires between 1 and 64 values";
    if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 1000)) {
      return "Each activation value must contain between 1 and 1000 characters";
    }
    if (typeof mapping.enabled !== "boolean") return "Activation enabled must be a boolean";
    if (!Array.isArray(mapping.block_ids) || mapping.block_ids.length === 0 || mapping.block_ids.length > 128
      || mapping.block_ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) {
      return "Each activation mapping requires between 1 and 128 block IDs";
    }
  }
  return null;
}

export function readPromptActivation(metadata: Record<string, any> | undefined): RegexPromptActivation | null {
  const value = metadata?.prompt_activation;
  return value && !validatePromptActivation(value) ? value : null;
}

export interface PromptActivationMatch {
  mapping_index: number;
  value: string;
  index: number;
}

/** A read-only pass over source text, independent of replacement/move/display actions. */
export async function matchPromptActivation(
  script: Pick<RegexScript, "find_regex" | "flags">,
  config: RegexPromptActivation,
  content: string,
): Promise<PromptActivationMatch[]> {
  if (content.length > MAX_ACTIVATION_CONTENT_LENGTH) throw new Error("Message is too large for prompt activation");
  // The caller resolves bounded inputs once, before history replay.
  const matches = await regexCollectSandboxed(script.find_regex, script.flags, content, 500, 1000);
  const normalize = (value: string) => script.flags.includes("i") ? value.trim().toLowerCase() : value.trim();
  // Legacy strings stay literal (including commas). Lists use OR semantics and
  // duplicates cannot apply one mapping multiple times for the same capture.
  const acceptedValues = config.mappings.map((mapping) => new Set(
    (Array.isArray(mapping.value) ? mapping.value : [mapping.value]).map(normalize),
  ));
  const result: PromptActivationMatch[] = [];
  for (const match of matches) {
    if (!match.fullMatch.length) continue;
    // Enforce the actual message boundary even with m enabled or an unanchored pattern.
    if (config.source === "ai_output" && content.slice(match.index + match.fullMatch.length).trim()) continue;
    for (let index = 0; index < config.mappings.length; index++) {
      const mapping = config.mappings[index];
      const capture = mapping.capture === "0"
        ? match.fullMatch
        : /^\d+$/.test(mapping.capture)
          ? match.groups[Number(mapping.capture) - 1]
          : Object.hasOwn(match.namedGroups ?? {}, mapping.capture) ? match.namedGroups![mapping.capture] : undefined;
      if (capture !== undefined && acceptedValues[index].has(normalize(capture))) {
        result.push({ mapping_index: index, value: capture.trim(), index: match.index });
      }
    }
  }
  return result;
}

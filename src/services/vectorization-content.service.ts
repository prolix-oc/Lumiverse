import { evaluate, registry, type MacroEnv } from "../macros";
import { sanitizeForVectorization, type SanitizeOptions } from "../utils/content-sanitizer";

const HAS_MACRO_HINT_RE = /\{\{|<(?:user|char|bot)>/i;

export function contentHasMacroHints(content: string): boolean {
  return HAS_MACRO_HINT_RE.test(content);
}

export async function resolveAndSanitizeForVectorization(
  content: string,
  env: MacroEnv | null,
  options?: SanitizeOptions,
): Promise<string> {
  if (!content) return "";
  let resolved = content;
  if (env && HAS_MACRO_HINT_RE.test(content)) {
    try {
      const result = await evaluate(content, env, registry);
      resolved = result.text;
    } catch {
      resolved = content;
    }
  }
  return sanitizeForVectorization(resolved, options);
}

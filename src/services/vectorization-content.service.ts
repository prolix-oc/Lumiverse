import { evaluate, registry, type MacroEnv } from "../macros";
import { withJsonBlocksProtected } from "../macros/json-blocks";
import { restoreLiteralBraces } from "../macros/literal-braces";
import { sanitizeForVectorization, type SanitizeOptions } from "../utils/content-sanitizer";

const HAS_MACRO_HINT_RE = /\{\{|<(?:user|char|bot)>/i;

export function contentHasMacroHints(content: string): boolean {
  return HAS_MACRO_HINT_RE.test(content);
}

export async function resolveAndSanitizeForVectorization(
  content: string,
  env: MacroEnv | null,
  options?: SanitizeOptions,
  maskScanContent?: (content: string) => string,
): Promise<string> {
  // World Info excludes source text before it can execute, and masks markup
  // emitted by macros before HTML cleanup removes its exclusion attributes.
  if (maskScanContent) content = maskScanContent(content);
  if (!content) return "";
  let resolved = content;
  if (env && HAS_MACRO_HINT_RE.test(content)) {
    try {
      resolved = await withJsonBlocksProtected(content, env, async (protectedContent) =>
        (await evaluate(protectedContent, env, registry)).text,
      );
    } catch {
      resolved = content;
    }
    if (maskScanContent) resolved = maskScanContent(resolved);
  }
  return sanitizeForVectorization(restoreLiteralBraces(resolved), options);
}

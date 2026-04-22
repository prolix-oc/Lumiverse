import { registry } from "../MacroRegistry";
import { evaluate } from "../MacroEvaluator";
import {
  getRegexScriptByScriptId,
  substituteRegexCaptures,
} from "../../services/regex-scripts.service";
import {
  regexCollectSandboxed,
  regexReplaceSandboxed,
  RegexTimeoutError,
} from "../../utils/regex-sandbox";

const REGEX_REF_TIMEOUT_MS = 500;

/** Normalize a script_id: lowercase, spaces/hyphens → underscores, strip punctuation. */
function normalizeScriptId(raw: string): string {
  return raw.toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export function registerRegexRefMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "regexInstalled",
    category: "Regex",
    description:
      "Check if a regex script is installed, or apply it to text. " +
      "Without text arg: returns 'true'/'false'. With text arg: applies the regex and returns the result.",
    returnType: "string",
    args: [
      { name: "scriptId", description: "The script_id of the regex script" },
      { name: "text", optional: true, description: "Text to apply the regex to (or use scoped body)" },
    ],
    aliases: ["regex_installed", "hasRegex", "has_regex"],
    handler: async (ctx) => {
      const scriptId = normalizeScriptId((ctx.args[0] ?? "").trim());
      if (!scriptId) return "";

      const userId = ctx.env.extra.userId as string | undefined;
      if (!userId) {
        ctx.warn("regexInstalled: userId not available in macro environment");
        return ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      }

      const script = getRegexScriptByScriptId(userId, scriptId);

      // No text argument — check mode: return "true"/"false"
      const text = ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      if (!text && !ctx.isScoped) {
        return script && !script.disabled ? "true" : "false";
      }

      // Text provided — apply the regex if the script exists and is enabled
      if (!script || script.disabled) return text;

      try {
        let result: string;
        let findRegex = script.find_regex;

        if (script.substitute_macros !== "none") {
          findRegex = (await evaluate(findRegex, ctx.env, registry)).text;
        }

        if (script.substitute_macros === "raw") {
          // "raw" mode: substitute capture groups BEFORE macro resolution
          // so $1, $2, etc. are available inside macro arguments. Match
          // collection runs in the regex sandbox so a malicious script
          // pattern can't freeze the assembly thread.
          const matches = await regexCollectSandboxed(
            findRegex,
            script.flags,
            text,
            REGEX_REF_TIMEOUT_MS,
          );

          if (matches.length > 0) {
            const replacements = await Promise.all(
              matches.map(async ({ fullMatch, groups, index, namedGroups }) => {
                const withCaptures = substituteRegexCaptures(
                  script.replace_string, fullMatch, groups, index, text, namedGroups,
                );
                return (await evaluate(withCaptures, ctx.env, registry)).text;
              }),
            );
            let out = "";
            let lastIdx = 0;
            for (let i = 0; i < matches.length; i++) {
              out += text.slice(lastIdx, matches[i].index);
              out += replacements[i];
              lastIdx = matches[i].index + matches[i].fullMatch.length;
            }
            out += text.slice(lastIdx);
            result = out;
          } else {
            result = text;
          }
        } else {
          // "none" or "escaped" mode
          let replaceString = script.replace_string;
          if (script.substitute_macros !== "none") {
            const resolved = (await evaluate(replaceString, ctx.env, registry)).text;
            replaceString = script.substitute_macros === "escaped"
              ? resolved.replace(/\$/g, "$$$$")
              : resolved;
          }
          result = await regexReplaceSandboxed(
            findRegex,
            script.flags,
            text,
            replaceString,
            REGEX_REF_TIMEOUT_MS,
          );
        }

        // Apply trim_strings
        if (script.trim_strings.length > 0) {
          for (const trim of script.trim_strings) {
            while (result.includes(trim)) {
              result = result.replaceAll(trim, "");
            }
          }
        }

        return result;
      } catch (err) {
        if (err instanceof RegexTimeoutError) {
          ctx.warn(`regexInstalled: script "${scriptId}" exceeded ${REGEX_REF_TIMEOUT_MS}ms`);
        } else {
          ctx.warn(`regexInstalled: failed to apply script "${scriptId}"`);
        }
        return text;
      }
    },
  });
}

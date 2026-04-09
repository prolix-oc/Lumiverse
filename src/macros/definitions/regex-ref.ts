import { registry } from "../MacroRegistry";
import { evaluate } from "../MacroEvaluator";
import {
  getRegexScriptByScriptId,
} from "../../services/regex-scripts.service";

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
        const regex = new RegExp(script.find_regex, script.flags);

        // Resolve macros in replacement string if configured
        let replaceString = script.replace_string;
        if (script.substitute_macros !== "none") {
          const resolved = (await evaluate(replaceString, ctx.env, registry)).text;
          replaceString = script.substitute_macros === "escaped"
            ? resolved.replace(/\$/g, "$$$$")
            : resolved;
        }

        let result = text.replace(regex, replaceString);

        // Apply trim_strings
        if (script.trim_strings.length > 0) {
          for (const trim of script.trim_strings) {
            while (result.includes(trim)) {
              result = result.replaceAll(trim, "");
            }
          }
        }

        return result;
      } catch {
        ctx.warn(`regexInstalled: failed to apply script "${scriptId}"`);
        return text;
      }
    },
  });
}

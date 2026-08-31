import { registry } from "../MacroRegistry";
import { evaluate } from "../MacroEvaluator";
import {
  getRegexScriptByScriptId,
} from "../../services/regex-scripts.service";
import {
  regexCaptureReplacementsSandboxed,
  regexReplaceSandboxed,
  RegexTimeoutError,
} from "../../utils/regex-sandbox";
import { REGEX_LIMITS_V1, utf8ByteLength } from "../../utils/regex-limits";

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

      const script = getRegexScriptByScriptId(userId, scriptId, {
        characterId: typeof ctx.env.extra.characterId === "string" ? ctx.env.extra.characterId : null,
        chatId: typeof ctx.env.chat?.id === "string" ? ctx.env.chat.id : null,
        presetId: typeof ctx.env.extra.presetId === "string" ? ctx.env.extra.presetId : null,
      });

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
          findRegex = (await evaluate(findRegex, ctx.env, registry, { budget: ctx.budget })).text;
        }

        if (script.substitute_macros === "raw") {
          // "raw" mode: substitute capture groups BEFORE macro resolution.
          const matches = await regexCaptureReplacementsSandboxed(
            findRegex,
            script.flags,
            text,
            script.replace_string,
            REGEX_REF_TIMEOUT_MS,
            {
              maxMatches: REGEX_LIMITS_V1.maxMatchCount,
              maxExpansionBytes: Math.max(
                0,
                ctx.budget.limits.maxCumulativeExpansionBytes - ctx.budget.cumulativeExpansionBytes,
              ),
              maxOutputBytes: ctx.budget.limits.maxOutputBytes,
              maxOperationBytes: ctx.budget.limits.maxOperationBytes,
            },
          );

          if (matches.length > 0) {
            const replacements: string[] = [];
            let outputBytes = utf8ByteLength(text);
            let lastIdx = 0;
            for (const match of matches) {
              ctx.budget.checkAbort();
              ctx.budget.accountExpansion(match.replacement);
              const replacement = (await evaluate(
                match.replacement,
                ctx.env,
                registry,
                { budget: ctx.budget },
              )).text;
              const replacementBytes = utf8ByteLength(replacement);
              outputBytes += replacementBytes - utf8ByteLength(
                text.slice(match.index, match.index + match.matchLength),
              );
              ctx.budget.preflightOutput(outputBytes);
              replacements.push(replacement);
              lastIdx = match.index + match.matchLength;
            }
            const parts: string[] = [];
            lastIdx = 0;
            for (let i = 0; i < matches.length; i += 1) {
              const match = matches[i]!;
              parts.push(text.slice(lastIdx, match.index), replacements[i]!);
              lastIdx = match.index + match.matchLength;
            }
            parts.push(text.slice(lastIdx));
            ctx.budget.preflightOutput(outputBytes);
            result = parts.join("");
          } else {
            result = text;
          }
        } else if (script.substitute_macros === "after") {
          const substituted = await regexReplaceSandboxed(
            findRegex,
            script.flags,
            text,
            script.replace_string,
            REGEX_REF_TIMEOUT_MS,
            {
              maxMatches: REGEX_LIMITS_V1.maxMatchCount,
              maxExpansionBytes: Math.max(
                0,
                ctx.budget.limits.maxCumulativeExpansionBytes - ctx.budget.cumulativeExpansionBytes,
              ),
              maxOutputBytes: ctx.budget.limits.maxOutputBytes,
              maxOperationBytes: ctx.budget.limits.maxOperationBytes,
            },
          );
          result = substituted !== text
            ? (await evaluate(substituted, ctx.env, registry, { budget: ctx.budget })).text
            : substituted;
        } else {
          // "none", "find", or "escaped" mode
          let replaceString = script.replace_string;
          if (
            script.substitute_macros !== "none"
            && script.substitute_macros !== "find"
          ) {
            const resolved = (await evaluate(replaceString, ctx.env, registry, { budget: ctx.budget })).text;
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
            {
              maxMatches: REGEX_LIMITS_V1.maxMatchCount,
              maxExpansionBytes: Math.max(
                0,
                ctx.budget.limits.maxCumulativeExpansionBytes - ctx.budget.cumulativeExpansionBytes,
              ),
              maxOutputBytes: ctx.budget.limits.maxOutputBytes,
              maxOperationBytes: ctx.budget.limits.maxOperationBytes,
            },
          );
        }

        // Apply bounded literal trims. Empty tokens are rejected instead of
        // entering an unbounded no-progress loop.
        if (script.trim_strings.length > REGEX_LIMITS_V1.maxTrimStrings) {
          throw new Error("regexInstalled: trim string count exceeded");
        }
        for (const trim of script.trim_strings) {
          ctx.budget.checkAbort();
          ctx.budget.reserveTrimString();
          if (trim.length === 0) throw new Error("regexInstalled: trim string is empty");
          if (utf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) {
            throw new Error("regexInstalled: trim string is too large");
          }
          result = result.replaceAll(trim, "");
          ctx.budget.preflightOutput(result);
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

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";
import {
  regexCaptureReplacementsSandboxed,
  RegexTimeoutError,
  type SandboxCaptureReplacement,
} from "../../utils/regex-sandbox";
import { PreparationLimitExceededError, utf8ByteLength } from "../../types/agent-preprocessing";
import { MAX_LIST_ITEMS, selectDelimitedItem } from "../list-utils";

function measureMappedCodePointBytes(
  value: string,
  map: (codePoint: string) => string,
): number {
  let bytes = 0;
  for (const codePoint of value) bytes += utf8ByteLength(map(codePoint));
  return bytes;
}

export function registerStringMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "len",
    category: "String",
    description: "Length of a string (character count)",
    returnType: "integer",
    args: [{ name: "text", description: "Text to measure" }],
    aliases: ["length"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return String(text.length);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "upper",
    category: "String",
    description: "Convert text to uppercase",
    returnType: "string",
    args: [{ name: "text", description: "Text to convert" }],
    aliases: ["uppercase", "toUpper"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return ctx.budget.transform(
        text,
        (value) => value.toUpperCase(),
        (value) => measureMappedCodePointBytes(value, (codePoint) => codePoint.toUpperCase()),
      );
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "lower",
    category: "String",
    description: "Convert text to lowercase",
    returnType: "string",
    args: [{ name: "text", description: "Text to convert" }],
    aliases: ["lowercase", "toLower"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return ctx.budget.transform(
        text,
        (value) => value.toLowerCase(),
        (value) => measureMappedCodePointBytes(value, (codePoint) => codePoint.toLowerCase()),
      );
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "capitalize",
    category: "String",
    description: "Capitalize the first letter of each sentence",
    returnType: "string",
    args: [{ name: "text", description: "Text to capitalize" }],
    aliases: ["titlecase"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      if (!text) return "";
      const first = text.charAt(0).toUpperCase();
      return ctx.budget.append([first, text.slice(1)]);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "replace",
    category: "String",
    description: "Replace occurrences of a substring. Scoped: {{replace::find::with}}text{{/replace}}",
    returnType: "string",
    args: [
      { name: "find", description: "String to find" },
      { name: "with", description: "Replacement string" },
      { name: "text", optional: true, description: "Source text (or use scoped body)" },
    ],
    handler: (ctx) => {
      const find = ctx.args[0] ?? "";
      const replacement = ctx.args[1] ?? "";
      const text = ctx.isScoped ? ctx.body : (ctx.args[2] ?? "");
      if (!find) return text;
      return ctx.budget.replaceAll(text, find, replacement);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "substr",
    category: "String",
    description: "Extract a substring by start and optional end index",
    returnType: "string",
    args: [
      { name: "text", description: "Source text" },
      { name: "start", description: "Start index (0-based)" },
      { name: "end", optional: true, description: "End index (exclusive)" },
    ],
    aliases: ["substring"],
    handler: (ctx) => {
      const text = ctx.args[0] ?? "";
      const start = parseInt(ctx.args[1], 10) || 0;
      const end = ctx.args[2] !== undefined ? parseInt(ctx.args[2], 10) : undefined;
      return text.substring(start, end);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "split",
    category: "String",
    description: "Split text by delimiter and return the Nth item (0-based)",
    returnType: "string",
    args: [
      { name: "text", description: "Text to split" },
      { name: "delimiter", description: "Delimiter string" },
      { name: "index", description: "Item index (0-based)" },
    ],
    handler: (ctx) => {
      const text = ctx.args[0] ?? "";
      const delimiter = ctx.args[1] ?? ",";
      const index = parseInt(ctx.args[2], 10) || 0;
      const selection = selectDelimitedItem(text, delimiter, index, MAX_LIST_ITEMS);
      if (selection.overflow) {
        ctx.warn(`{{split}} capped at ${MAX_LIST_ITEMS} items`);
        return "";
      }
      return selection.value;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "join",
    category: "String",
    description: "Join multiple values with a separator",
    returnType: "string",
    args: [
      { name: "separator", description: "Separator string" },
      { name: "items", description: "Values to join" },
    ],
    isList: true,
    handler: (ctx) => {
      const sep = ctx.args[0] ?? ", ";
      // Trim each item before filtering blanks. When a join is written across
      // multiple indented lines for readability, every `::`-separated item
      // picks up the surrounding newlines/indentation as literal text (and a
      // nested macro that resolves to "" leaves just its indentation behind).
      // Items are list values, so that structural whitespace is noise and
      // would otherwise accumulate into joined output. The separator (arg 0)
      // is intentionally left intact — its whitespace is meaningful.
      const rawItems = ctx.args.slice(1);
      ctx.budget.reserveTrimString(rawItems.length);
      const items = rawItems
        .map((a) => a.trim())
        .filter((a) => a !== "");
      return ctx.budget.join(items, sep);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "repeat",
    category: "String",
    description: "Repeat text N times. Scoped: {{repeat::3}}text{{/repeat}}",
    returnType: "string",
    args: [
      { name: "count", description: "Number of repetitions" },
      { name: "text", optional: true, description: "Text to repeat (or use scoped body)" },
    ],
    handler: (ctx) => {
      const count = Math.min(Math.max(parseInt(ctx.args[0], 10) || 0, 0), 1000);
      const text = ctx.isScoped ? ctx.body : (ctx.args[1] ?? "");
      return ctx.budget.repeat(text, count);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "wrap",
    category: "String",
    description: "Wrap text with prefix and suffix. Only wraps if text is non-empty.",
    returnType: "string",
    args: [
      { name: "prefix", description: "Prefix string" },
      { name: "suffix", description: "Suffix string" },
      { name: "text", optional: true, description: "Text to wrap (or use scoped body)" },
    ],
    handler: (ctx) => {
      const prefix = ctx.args[0] ?? "";
      const suffix = ctx.args[1] ?? "";
      const text = ctx.isScoped ? ctx.body : (ctx.args[2] ?? "");
      if (!text) return "";
      return ctx.budget.wrap(prefix, text, suffix);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "regex",
    category: "String",
    description: "Regex replacement. {{regex::pattern::replacement::text}} or scoped.",
    returnType: "string",
    args: [
      { name: "pattern", description: "Regular expression pattern" },
      { name: "replacement", description: "Replacement string ($1, $2 for groups)" },
      { name: "text", optional: true, description: "Source text (or use scoped body)" },
      { name: "flags", optional: true, description: "Regex flags (default: g)" },
    ],
    handler: async (ctx) => {
      const pattern = ctx.args[0] ?? "";
      const replacement = ctx.args[1] ?? "";
      const text = ctx.isScoped ? ctx.body : (ctx.args[2] ?? "");
      const flags = (ctx.isScoped ? ctx.args[2] : ctx.args[3]) ?? "g";
      if (!pattern) return text;
      try {
        // Capture replacements in the terminable regex sandbox, then preflight
        // the exact rebuilt byte count before allocating the final string.
        return await regexReplaceWithBudget(ctx, pattern, flags, text, replacement);
      } catch (err) {
        if (err instanceof PreparationLimitExceededError) throw err;
        if (err instanceof RegexTimeoutError) {
          ctx.warn(`Regex pattern exceeded time budget: ${pattern}`);
          return text;
        }
        ctx.warn(`Invalid regex pattern: ${pattern}`);
        return text;
      }
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "tokenCount",
    category: "String",
    description: "Approximate token count of text (~4 chars per token)",
    returnType: "integer",
    args: [{ name: "text", description: "Text to estimate" }],
    aliases: ["token_count", "tokens"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return String(Math.ceil(text.length / 4));
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "truncate",
    category: "String",
    description: "Truncate text to approximately N tokens (word-boundary aware)",
    returnType: "string",
    args: [
      { name: "text", description: "Text to truncate" },
      { name: "maxTokens", description: "Maximum token count" },
    ],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      const maxTokens = parseInt(ctx.isScoped ? ctx.args[0] : ctx.args[1], 10) || 100;
      const maxChars = maxTokens * 4;
      if (text.length <= maxChars) return text;
      // Truncate at nearest word boundary
      const truncated = text.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(" ");
      return (lastSpace > maxChars * 0.8 ? truncated.substring(0, lastSpace) : truncated) + "...";
    },
  });
}
const MAX_REGEX_REPLACEMENTS = 10_000;

async function regexReplaceWithBudget(
  ctx: MacroExecContext,
  pattern: string,
  flags: string,
  text: string,
  replacement: string,
): Promise<string> {
  const replacements: SandboxCaptureReplacement[] =
    await regexCaptureReplacementsSandboxed(
      pattern,
      flags,
      text,
      replacement,
      500,
      {
        signal: ctx.budget.signal,
        maxMatches: Math.min(MAX_REGEX_REPLACEMENTS, 1024),
        maxExpansionBytes: Math.max(
          0,
          ctx.budget.limits.maxCumulativeExpansionBytes - ctx.budget.cumulativeExpansionBytes,
        ),
        maxOutputBytes: ctx.budget.limits.maxOutputBytes,
        maxOperationBytes: ctx.budget.limits.maxOperationBytes,
      },
    );
  if (replacements.length > MAX_REGEX_REPLACEMENTS) {
    throw new PreparationLimitExceededError(
      "operation_bytes",
      ctx.budget.limits.maxOperationBytes,
      ctx.budget.limits.maxOperationBytes + 1,
    );
  }
  if (replacements.length === 0) return text;

  let cursor = 0;
  let outputBytes = Buffer.byteLength(text, "utf8");
  for (const entry of replacements) {
    ctx.budget.checkAbort();
    if (
      !Number.isSafeInteger(entry.index)
      || !Number.isSafeInteger(entry.matchLength)
      || entry.index < cursor
      || entry.matchLength < 0
      || entry.index + entry.matchLength > text.length
    ) {
      throw new Error("Regex sandbox returned malformed match spans");
    }
    const replacementBytes = Buffer.byteLength(entry.replacement, "utf8");
    if (replacementBytes > ctx.budget.limits.maxOperationBytes) {
      throw new PreparationLimitExceededError(
        "operation_bytes",
        ctx.budget.limits.maxOperationBytes,
        replacementBytes,
      );
    }
    ctx.budget.preflightExpansion(entry.replacement, replacementBytes);
    const matched = text.slice(entry.index, entry.index + entry.matchLength);
    outputBytes += replacementBytes - Buffer.byteLength(matched, "utf8");
    ctx.budget.preflightOutput(outputBytes);
    cursor = entry.index + entry.matchLength;
  }

  const parts: string[] = [];
  cursor = 0;
  for (const entry of replacements) {
    parts.push(text.slice(cursor, entry.index), entry.replacement);
    cursor = entry.index + entry.matchLength;
  }
  parts.push(text.slice(cursor));
  ctx.budget.preflightOutput(outputBytes);
  return ctx.budget.append(parts);
}

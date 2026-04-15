import { registry } from "../MacroRegistry";
import {
  regexReplaceSandboxed,
  RegexTimeoutError,
} from "../../utils/regex-sandbox";

export function registerStringMacros(): void {
  registry.registerMacro({
    builtIn: true,
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
    name: "upper",
    category: "String",
    description: "Convert text to uppercase",
    returnType: "string",
    args: [{ name: "text", description: "Text to convert" }],
    aliases: ["uppercase", "toUpper"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return text.toUpperCase();
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "lower",
    category: "String",
    description: "Convert text to lowercase",
    returnType: "string",
    args: [{ name: "text", description: "Text to convert" }],
    aliases: ["lowercase", "toLower"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      return text.toLowerCase();
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "capitalize",
    category: "String",
    description: "Capitalize the first letter of each sentence",
    returnType: "string",
    args: [{ name: "text", description: "Text to capitalize" }],
    aliases: ["titlecase"],
    handler: (ctx) => {
      const text = ctx.isScoped ? ctx.body : (ctx.args[0] ?? "");
      if (!text) return "";
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
  });

  registry.registerMacro({
    builtIn: true,
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
      return text.replaceAll(find, replacement);
    },
  });

  registry.registerMacro({
    builtIn: true,
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
      const parts = text.split(delimiter);
      const item = parts[index < 0 ? parts.length + index : index];
      return item?.trim() ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
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
      const items = ctx.args.slice(1).filter((a) => a !== "");
      return items.join(sep);
    },
  });

  registry.registerMacro({
    builtIn: true,
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
      return text.repeat(count);
    },
  });

  registry.registerMacro({
    builtIn: true,
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
      return prefix + text + suffix;
    },
  });

  registry.registerMacro({
    builtIn: true,
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
        // Run user-supplied regex in the sandbox so a pathological pattern
        // can't freeze the prompt-assembly thread.
        return await regexReplaceSandboxed(pattern, flags, text, replacement);
      } catch (err) {
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

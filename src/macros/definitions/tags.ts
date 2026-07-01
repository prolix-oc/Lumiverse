/**
 * Character tag macros — character-card tag accessors.
 *
 * All macros read from ctx.env.extra.characterTags which is populated by
 * buildEnv() in MacroEnv.ts from the active character card's tags field.
 *
 * Tags are normalized by trimming blanks so they compose cleanly with the
 * comma-separated list family.
 */

import { registry } from "../MacroRegistry";
import { formatList, resolveIndex } from "../list-utils";
import type { MacroExecContext } from "../types";

function getCharacterTags(ctx: MacroExecContext): string[] {
  const tags = ctx.env.extra.characterTags;
  if (!Array.isArray(tags)) return [];
  // Imported/legacy cards can carry non-string tag entries; coerce defensively
  // so one bad element never makes every tag macro resolve to empty.
  return tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export function registerTagMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "charTags",
    category: "Character",
    description: "Comma-separated list of the character's tags.",
    returnType: "string",
    aliases: ["characterTags", "char_tags", "tags"],
    handler: (ctx) => formatList(getCharacterTags(ctx)),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "tag",
    category: "Character",
    description: "Character tag at a 0-based index. Negative indexes count from the end.",
    returnType: "string",
    args: [{ name: "index", description: "0-based index; negative counts from the end" }],
    aliases: ["tagAt", "tag_at", "charTagAt", "nthTag"],
    handler: (ctx) => {
      const items = getCharacterTags(ctx);
      const i = resolveIndex(parseInt(ctx.args[0] ?? "", 10), items.length);
      return items[i] ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "tagCount",
    category: "Character",
    description: "Number of tags on the character card.",
    returnType: "integer",
    aliases: ["tag_count", "tags_count", "numTags", "charTagCount"],
    handler: (ctx) => String(getCharacterTags(ctx).length),
  });

  registry.registerMacro({
    builtIn: true,
    volatile: true,
    name: "randomTag",
    category: "Character",
    description: "Random tag from the character card.",
    returnType: "string",
    aliases: ["random_tag", "randomCharTag"],
    handler: (ctx) => {
      const items = getCharacterTags(ctx);
      if (items.length === 0) return "";
      return items[Math.floor(Math.random() * items.length)] ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "hasTag",
    category: "Character",
    description: "Check whether the character has a specific tag (case-insensitive).",
    returnType: "boolean",
    args: [{ name: "tag", description: "Tag to check (case-insensitive)" }],
    aliases: ["charTag", "char_tag", "has_tag", "tagged"],
    handler: (ctx) => {
      const needle = (ctx.args[0] ?? "").trim().toLowerCase();
      if (!needle) return "";
      return getCharacterTags(ctx).some((tag) => tag.toLowerCase() === needle) ? "true" : "";
    },
  });
}

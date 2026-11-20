/**
 * Prompt variables macros — preset-scoped typed inputs configured by end users.
 *
 * Defs live on PromptBlock.variables. Values live in preset.metadata.promptVariables
 * keyed by block id. prompt-assembly.service.ts merges values over defaults,
 * coerces + clamps per type, writes the results to env.extra.promptVariables,
 * and pre-seeds env.variables.local with the same keys before any block content
 * is evaluated. That shared backing store is what lets {{var::name}},
 * {{getvar::name}}, and the {{.name}} shorthand all resolve to the same value.
 *
 * Resolution precedence for {{var::name}}:
 *   1. env.variables.local  — runtime map; overlaid with the current block's
 *                             schema-resolved values while that block renders,
 *                             then updated by any in-block {{setvar::name::…}}.
 *   2. env.extra.promptVariables       — schema-resolved snapshot (belt & braces).
 *   3. env.extra.promptVariableDefaults — creator-declared defaults.
 *   4. "" — undeclared.
 *
 * Sub-syntax for multiselect variables:
 *   {{var::name::ison::key1,key2,…}} — returns 'true' iff every listed option key
 *   is currently selected (AND). Useful as a guard inside {{#if}} / switch
 *   blocks. Unknown keys cause the check to fail. Empty key list returns 'true'.
 *
 * env.extra shape:
 *   promptVariables          — Record<varName, string | number>   flat compatibility view
 *   promptVariablesByBlock   — Record<blockId, Record<varName, string | number>>
 *   promptVariableDefaults   — Record<varName, string | number>   flat compatibility view
 *   promptVariableDefaultsByBlock — block-scoped creator defaults
 *   promptVariableSelections — Record<varName, string[]>          flat compatibility view
 *   promptVariableSelectionsByBlock — block-scoped multiselect option ids
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

function resolveKey(ctx: MacroExecContext): string | null {
  const raw = (ctx.args[0] ?? ctx.body ?? "").trim();
  return raw.length ? raw : null;
}

function getValues(ctx: MacroExecContext): Record<string, string | number> {
  const blockId = ctx.env.promptBlock?.id;
  const byBlock = ctx.env.extra.promptVariablesByBlock as
    | Record<string, Record<string, string | number>>
    | undefined;
  if (blockId && byBlock?.[blockId]) return byBlock[blockId];
  return (ctx.env.extra.promptVariables ?? {}) as Record<string, string | number>;
}

function getDefaults(ctx: MacroExecContext): Record<string, string | number> {
  const blockId = ctx.env.promptBlock?.id;
  const byBlock = ctx.env.extra.promptVariableDefaultsByBlock as
    | Record<string, Record<string, string | number>>
    | undefined;
  if (blockId && byBlock?.[blockId]) return byBlock[blockId];
  return (ctx.env.extra.promptVariableDefaults ?? {}) as Record<string, string | number>;
}

function getSelections(ctx: MacroExecContext): Record<string, string[]> {
  const blockId = ctx.env.promptBlock?.id;
  const byBlock = ctx.env.extra.promptVariableSelectionsByBlock as
    | Record<string, Record<string, string[]>>
    | undefined;
  if (blockId && byBlock?.[blockId]) return byBlock[blockId];
  return (ctx.env.extra.promptVariableSelections ?? {}) as Record<string, string[]>;
}

// {{var::name::ison::key1,key2,…}} returns 'true' iff every listed key is in
// the variable's current selection (AND semantics). Unknown variables and
// non-multiselect variables both report 'false' so creators get loud failure
// rather than silent matches.
function resolveIsOnQuery(ctx: MacroExecContext, key: string): string {
  const rawList = (ctx.args[2] ?? "").trim();
  if (!rawList) return "true";
  const wanted = rawList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return "true";
  const selections = getSelections(ctx);
  const current = selections[key];
  if (!Array.isArray(current)) return "false";
  const set = new Set(current);
  for (const id of wanted) {
    if (!set.has(id)) return "false";
  }
  return "true";
}

export function registerPromptVarMacros(): void {
  // {{var::name}} — configured value, falling back to creator default, then empty string.
  // Reads env.variables.local first so {{var::}} stays in lockstep with {{getvar::}}
  // and the {{.name}} shorthand. Prompt assembly temporarily overlays the
  // current block's own resolved bucket on this shared backing store.
  //
  // {{var::name::ison::key1,key2,…}} — multiselect-only AND-query. Returns
  // 'true' iff every listed option key is currently selected.
  registry.registerMacro({
    name: "var",
    category: "state",
    description:
      "Read a preset-scoped prompt variable value. Returns the runtime value (including any {{setvar::}} overrides), then the end-user configured value, then the creator default, then an empty string. With sub-syntax {{var::name::ison::key1,key2,…}}, returns 'true' iff every listed multiselect option key is currently selected.",
    args: [
      { name: "name", type: "string", description: "Variable name defined on a prompt block" },
      { name: "op", type: "string", optional: true, description: "Optional sub-operation. Currently only 'ison' is supported (multiselect)." },
      { name: "keys", type: "string", optional: true, description: "Comma-separated option keys for 'ison' (AND-matched)." },
    ],
    aliases: ["promptVar", "presetVar"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "";
      const op = (ctx.args[1] ?? "").trim().toLowerCase();
      if (op === "ison") return resolveIsOnQuery(ctx, key);
      const local = ctx.env.variables.local;
      if (local.has(key)) return local.get(key)!;
      const values = getValues(ctx);
      if (key in values) return String(values[key]);
      const defaults = getDefaults(ctx);
      if (key in defaults) return String(defaults[key]);
      return "";
    },
  });

  // {{hasVar::name}} — is this variable resolvable right now?
  registry.registerMacro({
    name: "hasVar",
    category: "state",
    description:
      "Returns 'true' if the named prompt variable is resolvable (runtime, schema, or default), 'false' otherwise.",
    args: [{ name: "name", type: "string", description: "Variable name" }],
    aliases: ["hasPromptVar", "hasPresetVar"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "false";
      if (ctx.env.variables.local.has(key)) return "true";
      const values = getValues(ctx);
      const defaults = getDefaults(ctx);
      return key in values || key in defaults ? "true" : "false";
    },
  });

  // {{varDefault::name}} — creator-declared default, ignoring any end-user override
  registry.registerMacro({
    name: "varDefault",
    category: "state",
    description:
      "Read the creator-declared default for a prompt variable, ignoring any end-user override.",
    args: [{ name: "name", type: "string", description: "Variable name" }],
    aliases: ["promptVarDefault", "presetVarDefault"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "";
      const defaults = getDefaults(ctx);
      return key in defaults ? String(defaults[key]) : "";
    },
  });
}

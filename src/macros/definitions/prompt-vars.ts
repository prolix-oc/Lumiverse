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
 *   1. env.variables.local  — runtime map; reflects schema-seeded values AND any
 *                             in-prompt {{setvar::name::…}} mutations so an
 *                             upstream variable-setter block's writes survive
 *                             downstream reads via either syntax.
 *   2. env.extra.promptVariables       — schema-resolved snapshot (belt & braces).
 *   3. env.extra.promptVariableDefaults — creator-declared defaults.
 *   4. "" — undeclared.
 *
 * env.extra shape:
 *   promptVariables         — Record<varName, string | number>   flat; last enabled block wins
 *   promptVariablesByBlock  — Record<blockId, Record<varName, string | number>>
 *   promptVariableDefaults  — Record<varName, string | number>   creator-declared defaults
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

function resolveKey(ctx: MacroExecContext): string | null {
  const raw = (ctx.args[0] ?? ctx.body ?? "").trim();
  return raw.length ? raw : null;
}

function getValues(ctx: MacroExecContext): Record<string, string | number> {
  return (ctx.env.extra.promptVariables ?? {}) as Record<string, string | number>;
}

function getDefaults(ctx: MacroExecContext): Record<string, string | number> {
  return (ctx.env.extra.promptVariableDefaults ?? {}) as Record<string, string | number>;
}

export function registerPromptVarMacros(): void {
  // {{var::name}} — configured value, falling back to creator default, then empty string.
  // Reads env.variables.local first so {{var::}} stays in lockstep with {{getvar::}}
  // and the {{.name}} shorthand — all three resolve against the same backing store.
  registry.registerMacro({
    name: "var",
    category: "state",
    description:
      "Read a preset-scoped prompt variable value. Returns the runtime value (including any {{setvar::}} overrides), then the end-user configured value, then the creator default, then an empty string.",
    args: [{ name: "name", type: "string", description: "Variable name defined on a prompt block" }],
    aliases: ["promptVar", "presetVar"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "";
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

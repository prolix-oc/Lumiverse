import { registry } from "../MacroRegistry";
import { shieldDataBraces } from "../json-utils";
import { MAX_PRESET_HISTORY, presetHistoryDependency } from "../../types/preset-history";
import { resolvePresetHistory } from "../../services/preset-history.service";
import type { MacroExecContext } from "../types";

function history(ctx: MacroExecContext, count: number): string {
  ctx.env._fingerprint?.touched.add(presetHistoryDependency(ctx.env.chat.id));
  const names = resolvePresetHistory(ctx.env).slice(0, count);
  const separator = ctx.args[1] ?? "\n";
  const length = names.reduce((total, name) => total + name.length, 0) + Math.max(0, names.length - 1) * separator.length;
  if (length > 65_536) { ctx.warn("Preset history output exceeds 65536 characters"); return ""; }
  return shieldDataBraces(names.join(separator));
}

export function registerPresetHistoryMacros(): void {
  registry.registerMacro({ builtIn: true, terminal: true, name: "lastPreset", category: "Chat",
    description: "Most recent available preset name from the selected assistant swipes. Empty without recorded history.",
    returnType: "string", handler: ctx => history(ctx, 1) });
  registry.registerMacro({ builtIn: true, terminal: true, name: "lastPresets", category: "Chat",
    description: "Recent preset names from selected assistant swipes, newest first, with repeats. Searches up to 100 attributed responses.",
    returnType: "string", args: [
      { name: "count", optional: true, defaultValue: "1", description: "Whole number from 0 to 100" },
      { name: "separator", optional: true, description: "Join separator; defaults to a newline" },
    ], handler: ctx => {
      const raw = (ctx.args[0] ?? "1").trim();
      if (!/^\d+$/.test(raw)) { ctx.warn("Preset history count must be a non-negative whole number"); return ""; }
      const count = Number(raw);
      if (count > MAX_PRESET_HISTORY) ctx.warn(`Preset history count capped at ${MAX_PRESET_HISTORY}`);
      return count === 0 ? "" : history(ctx, Math.min(count, MAX_PRESET_HISTORY));
    } });
}

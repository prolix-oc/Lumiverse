/**
 * Lumi Engine macros — pipeline results access.
 *
 * Data is injected into env.extra.lumiPipeline by the prompt assembly service
 * when lumiPipelineResults are present in the AssemblyContext.
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";


function getPipelineResults(ctx: MacroExecContext): Map<string, string> {
  const raw = ctx.env.extra.lumiPipeline?.results;
  if (!raw || !(raw instanceof Map)) return new Map();
  // LumiPipelineResult values may be LumiModuleResult objects or plain strings
  const out = new Map<string, string>();
  for (const [key, value] of raw as Map<string, any>) {
    out.set(key, typeof value === "string" ? value : (value?.content ?? ""));
  }
  return out;
}

function getModuleNames(ctx: MacroExecContext): Map<string, string> {
  return (ctx.env.extra.lumiPipeline?.moduleNames as Map<string, string>) ?? new Map();
}


export function registerLumiEngineMacros(): void {
  // All enabled pipeline results formatted as labeled sections.
  registry.registerMacro({
    builtIn: true,
    name: "pipeline",
    category: "Lumi Engine",
    description: "All enabled pipeline module results, formatted as labeled sections.",
    returnType: "string",
    handler: (ctx) => {
      const results = getPipelineResults(ctx);
      const names = getModuleNames(ctx);
      if (results.size === 0) return "";

      const sections: string[] = [];
      for (const [key, value] of results) {
        const name = names.get(key) || key;
        sections.push(`[${name}]\n${value}`);
      }
      return sections.join("\n\n");
    },
  });

  // Individual pipeline result by key.
  registry.registerMacro({
    builtIn: true,
    name: "pipe",
    category: "Lumi Engine",
    description: "Get a specific pipeline module result by key. Usage: {{pipe(module_key)}}",
    returnType: "string",
    handler: (ctx) => {
      const key = ctx.args[0] || "";
      if (!key) return "";
      const results = getPipelineResults(ctx);
      return results.get(key) ?? "";
    },
  });
}

import { protectJsonBlocks, readJsonInput } from "./json-blocks";
import { shieldDataBraces } from "./json-utils";
import type { MacroDefinition, MacroExecContext, MacroHandler } from "./types";
import { registry } from "./MacroRegistry";

/** String operations see data's actual characters, while their output stays inert. */
export function withDataInput(handler: (ctx: MacroExecContext, hasData: boolean) => ReturnType<MacroHandler>): MacroHandler {
  return async (ctx) => {
    const args = ctx.args.map((arg) => readJsonInput(arg, ctx.env));
    const body = readJsonInput(ctx.body, ctx.env);
    const hasData = body !== ctx.body || args.some((arg, i) => arg !== ctx.args[i]);
    const result = String(await handler(hasData ? { ...ctx, args, body } : ctx, hasData));
    if (!hasData) return result;
    // Keep surviving blocks byte-identical, including after regex replacement.
    // Shield other braces so extracting or rewriting data cannot execute it.
    const protectedResult = protectJsonBlocks(result, ctx.env);
    return shieldDataBraces(protectedResult.text);
  };
}

export function registerDataMacro(definition: MacroDefinition): void {
  registry.registerMacro({ ...definition, handler: withDataInput(definition.handler) });
}

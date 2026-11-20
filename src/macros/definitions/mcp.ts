import type { ToolDefinition } from "../../llm/types";
import { registry } from "../MacroRegistry";
import { shieldLiteralBraces } from "../literal-braces";
import type { MacroExecContext } from "../types";

function getTools(ctx: MacroExecContext): ToolDefinition[] {
  return ctx.env.extra.mcpTools ?? [];
}

export function registerMcpMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "mcpTools",
    category: "MCP",
    description: "Lists the MCP function names and descriptions available for this generation. Place in a preset block to control its role and position.",
    returnType: "string",
    terminal: true,
    handler: (ctx) => {
      const tools = getTools(ctx);
      if (tools.length === 0) return "";
      // Server-provided descriptions must stay literal across macro passes.
      return shieldLiteralBraces([
        "**Available MCP tools:**",
        ...tools.map((tool) => `- **${tool.name}**: ${tool.description}`),
      ].join("\n"));
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "mcpToolsActive",
    category: "MCP",
    description: "Returns 'yes' when MCP tools are available for this generation, otherwise 'no'.",
    returnType: "boolean",
    handler: (ctx) => getTools(ctx).length > 0 ? "yes" : "no",
  });
}

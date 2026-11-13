import { registry } from "../MacroRegistry";

export function registerReasoningMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "reasoningPrefix",
    category: "Reasoning",
    description: "Reasoning/CoT opening tag from user settings. Pass 'raw' arg to strip newlines.",
    returnType: "string",
    args: [{ name: "mode", description: "Optional: 'raw' to strip surrounding newlines" }],
    handler: (ctx) => {
      const value = (ctx.env.extra.reasoningPrefix as string) ?? "";
      if (ctx.args[0] === "raw") return value.replace(/^\n+|\n+$/g, "");
      return value;
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "reasoningSuffix",
    category: "Reasoning",
    description: "Reasoning/CoT closing tag from user settings. Pass 'raw' arg to strip newlines.",
    returnType: "string",
    args: [{ name: "mode", description: "Optional: 'raw' to strip surrounding newlines" }],
    handler: (ctx) => {
      const value = (ctx.env.extra.reasoningSuffix as string) ?? "";
      if (ctx.args[0] === "raw") return value.replace(/^\n+|\n+$/g, "");
      return value;
    },
  });
}

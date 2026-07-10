import { registry } from "../MacroRegistry";

export function registerStateMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "userInput",
    category: "State",
    description: "Exact draft text from the input bar when this generation started",
    returnType: "string",
    aliases: ["user_input"],
    handler: (ctx) =>
      typeof ctx.env.extra.userInput === "string" ? ctx.env.extra.userInput : "",
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "model",
    category: "State",
    description: "Current LLM model name",
    returnType: "string",
    handler: (ctx) => ctx.env.system.model,
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "isMobile",
    category: "State",
    description: "Whether the client is a mobile device",
    returnType: "boolean",
    aliases: ["is_mobile"],
    handler: (ctx) => (ctx.env.system.isMobile ? "true" : "false"),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "maxPrompt",
    category: "State",
    description: "Maximum prompt tokens",
    returnType: "integer",
    aliases: ["maxPromptTokens", "max_prompt"],
    handler: (ctx) => String(ctx.env.system.maxPrompt),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "maxContext",
    category: "State",
    description: "Maximum context window tokens",
    returnType: "integer",
    aliases: ["maxContextTokens", "max_context"],
    handler: (ctx) => String(ctx.env.system.maxContext),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "maxResponse",
    category: "State",
    description: "Maximum response tokens",
    returnType: "integer",
    aliases: ["maxResponseTokens", "max_response"],
    handler: (ctx) => String(ctx.env.system.maxResponse),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "lastGenerationType",
    category: "State",
    description: "Type of the last generation (normal, continue, regenerate, etc.)",
    returnType: "string",
    aliases: ["last_generation_type"],
    handler: (ctx) => ctx.env.system.lastGenerationType,
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "hasExtension",
    category: "State",
    description: "Check if a named extension is active (returns 'true' or 'false')",
    returnType: "boolean",
    args: [{ name: "name", description: "Extension name" }],
    aliases: ["has_extension"],
    handler: (ctx) => {
      // Extensions are not yet tracked in env; always false for now
      return "false";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "userColorMode",
    category: "State",
    description: "User's selected color scheme (dark, light, or system)",
    returnType: "string",
    aliases: ["user_color_mode", "colorMode", "color_mode"],
    handler: (ctx) => {
      return (ctx.env.extra.theme?.mode as string) || "dark";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: false,
    name: "presetBlock",
    category: "State",
    description: "Resolve a Lumiverse preset runtime block",
    returnType: "string",
    args: [{ name: "key", description: "Sealed block key" }],
    aliases: ["pblock"],
    handler: async (ctx) => {
      const key = (ctx.args[0] ?? "").trim();
      if (!key) return "";
      const { resolveSealedPresetBlock } = await import("../../lumihub/sealed-presets");
      return resolveSealedPresetBlock(ctx.env.extra.presetMetadata, key);
    },
  });
}

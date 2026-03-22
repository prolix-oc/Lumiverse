import { registry } from "../MacroRegistry";

export function registerStateMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "model",
    category: "State",
    description: "Current LLM model name",
    returnType: "string",
    handler: (ctx) => ctx.env.system.model,
  });

  registry.registerMacro({
    builtIn: true,
    name: "isMobile",
    category: "State",
    description: "Whether the client is a mobile device",
    returnType: "boolean",
    aliases: ["is_mobile"],
    handler: (ctx) => (ctx.env.system.isMobile ? "true" : "false"),
  });

  registry.registerMacro({
    builtIn: true,
    name: "maxPrompt",
    category: "State",
    description: "Maximum prompt tokens",
    returnType: "integer",
    aliases: ["maxPromptTokens", "max_prompt"],
    handler: (ctx) => String(ctx.env.system.maxPrompt),
  });

  registry.registerMacro({
    builtIn: true,
    name: "maxContext",
    category: "State",
    description: "Maximum context window tokens",
    returnType: "integer",
    aliases: ["maxContextTokens", "max_context"],
    handler: (ctx) => String(ctx.env.system.maxContext),
  });

  registry.registerMacro({
    builtIn: true,
    name: "maxResponse",
    category: "State",
    description: "Maximum response tokens",
    returnType: "integer",
    aliases: ["maxResponseTokens", "max_response"],
    handler: (ctx) => String(ctx.env.system.maxResponse),
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastGenerationType",
    category: "State",
    description: "Type of the last generation (normal, continue, regenerate, etc.)",
    returnType: "string",
    aliases: ["last_generation_type"],
    handler: (ctx) => ctx.env.system.lastGenerationType,
  });

  registry.registerMacro({
    builtIn: true,
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
    name: "userColorMode",
    category: "State",
    description: "User's selected color scheme (dark, light, or system)",
    returnType: "string",
    aliases: ["user_color_mode", "colorMode", "color_mode"],
    handler: (ctx) => {
      return (ctx.env.extra.theme?.mode as string) || "dark";
    },
  });
}

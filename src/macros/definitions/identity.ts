import { registry } from "../MacroRegistry";

export function registerNamesMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "user",
    category: "Names",
    description: "Current user/persona name",
    returns: "The user's display name",
    returnType: "string",
    handler: (ctx) => ctx.env.names.user,
  });

  registry.registerMacro({
    builtIn: true,
    name: "char",
    category: "Names",
    description: "Current character name",
    returns: "The character's name",
    returnType: "string",
    aliases: ["charName"],
    handler: (ctx) => ctx.env.names.char,
  });

  registry.registerMacro({
    builtIn: true,
    name: "group",
    category: "Names",
    description: "Comma-separated list of group member names",
    returnType: "string",
    handler: (ctx) => ctx.env.names.group,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupNotMuted",
    category: "Names",
    description: "Comma-separated list of non-muted group member names",
    returnType: "string",
    aliases: ["group_not_muted"],
    handler: (ctx) => ctx.env.names.groupNotMuted,
  });

  registry.registerMacro({
    builtIn: true,
    name: "notChar",
    category: "Names",
    description: "Name of the not-character (usually the user)",
    returnType: "string",
    aliases: ["not_char"],
    handler: (ctx) => ctx.env.names.notChar,
  });
}

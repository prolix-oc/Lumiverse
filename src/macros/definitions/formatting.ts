import { registry } from "../MacroRegistry";

export function registerFormattingMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "bullets",
    category: "Formatting",
    description:
      "Format items as a bulleted list. Args: items. Scoped: splits body on newlines.",
    returnType: "string",
    isList: true,
    handler: (ctx) => {
      const items = ctx.isScoped
        ? ctx.body.split("\n").map((l) => l.trim()).filter(Boolean)
        : ctx.args.filter((a) => a.trim() !== "");
      if (items.length === 0) return "";
      return items.map((item) => `- ${item}`).join("\n");
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "numbered",
    category: "Formatting",
    description:
      "Format items as a numbered list. Args: items. Scoped: splits body on newlines.",
    returnType: "string",
    isList: true,
    aliases: ["ol", "enumerate"],
    handler: (ctx) => {
      const items = ctx.isScoped
        ? ctx.body.split("\n").map((l) => l.trim()).filter(Boolean)
        : ctx.args.filter((a) => a.trim() !== "");
      if (items.length === 0) return "";
      return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    },
  });
}

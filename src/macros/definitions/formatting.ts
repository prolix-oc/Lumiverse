import { registry } from "../MacroRegistry";

export function registerFormattingMacros(): void {
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "bullets",
    category: "Formatting",
    description:
      "Format items as a bulleted list. Args: items. Scoped: splits body on newlines.",
    returnType: "string",
    isList: true,
    handler: (ctx) => {
      const items = ctx.isScoped
        ? ctx.body.split("\n").map((line) => line.trim()).filter(Boolean)
        : ctx.args.filter((arg) => arg.trim() !== "");
      if (items.length === 0) return "";
      ctx.budget.reserveTrimString(items.length);
      return ctx.budget.join(items.map((item) => `- ${item}`), "\n");
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "numbered",
    category: "Formatting",
    description:
      "Format items as a numbered list. Args: items. Scoped: splits body on newlines.",
    returnType: "string",
    isList: true,
    handler: (ctx) => {
      const items = ctx.isScoped
        ? ctx.body.split("\n").map((line) => line.trim()).filter(Boolean)
        : ctx.args.filter((arg) => arg.trim() !== "");
      if (items.length === 0) return "";
      ctx.budget.reserveTrimString(items.length);
      return ctx.budget.join(items.map((item, index) => `${index + 1}. ${item}`), "\n");
    },
  });
}

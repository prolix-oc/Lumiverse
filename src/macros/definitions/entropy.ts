import { registry } from "../MacroRegistry";

export function registerRandomMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "random",
    category: "Random",
    description:
      "Random integer between min and max (inclusive), or pick a random item from a list of strings",
    returnType: "string",
    args: [
      { name: "min_or_item1", description: "Minimum value or first item" },
      { name: "max_or_item2", description: "Maximum value or second item" },
    ],
    isList: true,
    handler: (ctx) => {
      if (ctx.args.length === 0) return String(Math.round(Math.random()));

      // If all args are valid integers, use numeric range (first two args)
      const allNumeric =
        ctx.args.length <= 2 &&
        ctx.args.every((a) => a.trim() !== "" && !isNaN(Number(a)));

      if (allNumeric) {
        const min = parseInt(ctx.args[0], 10) || 0;
        const max = parseInt(ctx.args[1], 10) || 1;
        if (max < min) return String(min);
        return String(Math.floor(Math.random() * (max - min + 1)) + min);
      }

      // Otherwise, pick a random item from the list
      const idx = Math.floor(Math.random() * ctx.args.length);
      return ctx.args[idx];
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "pick",
    category: "Random",
    description: "Pick a random item from a list of arguments. Stable per evaluation when seeded.",
    returnType: "string",
    isList: true,
    handler: (ctx) => {
      if (ctx.args.length === 0) return "";
      const idx = Math.floor(Math.random() * ctx.args.length);
      return ctx.args[idx];
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "roll",
    category: "Random",
    description: "Roll dice in NdS format (e.g., 2d6). Returns total.",
    returnType: "integer",
    args: [{ name: "dice", description: "Dice notation like 2d6, 1d20, 3d8" }],
    handler: (ctx) => {
      const notation = ctx.args[0] || "1d6";
      const match = notation.match(/^(\d+)d(\d+)$/i);
      if (!match) {
        ctx.warn(`Invalid dice notation: ${notation}`);
        return "0";
      }

      const count = Math.min(parseInt(match[1], 10), 100);
      const sides = parseInt(match[2], 10);
      if (sides < 1 || count < 1) return "0";

      let total = 0;
      for (let i = 0; i < count; i++) {
        total += Math.floor(Math.random() * sides) + 1;
      }
      return String(total);
    },
  });
}

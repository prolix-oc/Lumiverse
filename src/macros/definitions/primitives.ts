import { registry } from "../MacroRegistry";

const ELSE_MARKER = "\x00ELSE_MARKER\x00";

export function registerCoreMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "space",
    category: "Core",
    description: "Inserts a literal space character",
    returnType: "string",
    handler: () => " ",
  });

  registry.registerMacro({
    builtIn: true,
    name: "newline",
    category: "Core",
    description: "Inserts a literal newline character",
    returnType: "string",
    aliases: ["nl", "n"],
    handler: () => "\n",
  });

  registry.registerMacro({
    builtIn: true,
    name: "noop",
    category: "Core",
    description: "No operation — resolves to empty string",
    returnType: "string",
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "trim",
    category: "Core",
    description: "Trim whitespace from scoped content or surrounding whitespace in post mode",
    returnType: "string",
    handler: (ctx) => {
      if (ctx.isScoped) {
        return ctx.body.trim();
      }
      // Non-scoped trim acts as a marker; handled in post-processing
      return "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "comment",
    category: "Core",
    description: "Comment — resolves to empty string, content is ignored",
    returnType: "string",
    aliases: ["note"],
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "//",
    category: "Core",
    description: "Inline comment shorthand — resolves to empty string",
    returnType: "string",
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "input",
    category: "Core",
    description: "Resolves to the raw user input (last user message)",
    returnType: "string",
    handler: (ctx) => ctx.env.chat.lastUserMessage,
  });

  registry.registerMacro({
    builtIn: true,
    name: "reverse",
    category: "Core",
    description: "Reverse a string",
    returnType: "string",
    args: [{ name: "text", description: "Text to reverse" }],
    handler: (ctx) => {
      if (ctx.isScoped) return [...ctx.body].reverse().join("");
      return ctx.args[0] ? [...ctx.args[0]].reverse().join("") : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "outlet",
    category: "Core",
    description: "Placeholder for extension outlet injection — resolves to empty",
    returnType: "string",
    handler: () => "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "banned",
    category: "Core",
    description: "Placeholder for banned tokens — resolves to empty",
    returnType: "string",
    handler: () => "",
  });

  // ---- if / else / endif (scoped, with delayArgResolution) ----

  registry.registerMacro({
    builtIn: true,
    name: "if",
    category: "Core",
    description: "Conditional block. Usage: {{if::condition}}...{{else}}...{{/if}}",
    returnType: "string",
    delayArgResolution: true,
    handler: async (ctx) => {
      // Resolve the condition argument
      const conditionNodes = ctx.rawArgs[0] || [];
      const conditionStr = (await ctx.resolveNodes(conditionNodes)).trim();

      const isTruthy = evaluateCondition(conditionStr);

      if (ctx.isScoped) {
        // Split body on {{else}} marker
        const parts = splitOnElse(ctx.body);
        return isTruthy ? parts.truthy : parts.falsy;
      }

      return isTruthy ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "else",
    category: "Core",
    description: "Else branch for if blocks",
    returnType: "string",
    handler: () => ELSE_MARKER,
  });
}

function evaluateCondition(value: string): boolean {
  // Handle comparison operators
  const compMatch = value.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const [, left, op, right] = compMatch;
    const lv = left.trim();
    const rv = right.trim();

    // Try numeric comparison
    const ln = parseFloat(lv);
    const rn = parseFloat(rv);
    const bothNumeric = !isNaN(ln) && !isNaN(rn);

    switch (op) {
      case "==": return bothNumeric ? ln === rn : lv === rv;
      case "!=": return bothNumeric ? ln !== rn : lv !== rv;
      case ">": return bothNumeric ? ln > rn : lv > rv;
      case ">=": return bothNumeric ? ln >= rn : lv >= rv;
      case "<": return bothNumeric ? ln < rn : lv < rv;
      case "<=": return bothNumeric ? ln <= rn : lv <= rv;
    }
  }

  // Falsy values
  if (!value || value === "0" || value === "false" || value === "null" || value === "undefined") {
    return false;
  }
  return true;
}

function splitOnElse(body: string): { truthy: string; falsy: string } {
  const idx = body.indexOf(ELSE_MARKER);
  if (idx < 0) return { truthy: body, falsy: "" };
  return {
    truthy: body.substring(0, idx),
    falsy: body.substring(idx + ELSE_MARKER.length),
  };
}

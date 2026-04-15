import { registry } from "../MacroRegistry";

export function registerMathMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "calc",
    category: "Math",
    description: "Evaluate a math expression (+ - * / % with parentheses)",
    returnType: "number",
    args: [{ name: "expression", description: "Math expression to evaluate" }],
    aliases: ["math", "evaluate"],
    handler: (ctx) => {
      const expr = ctx.args[0] ?? "";
      return formatNum(safeCalc(expr));
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "min",
    category: "Math",
    description: "Return the smallest of two or more numbers",
    returnType: "number",
    isList: true,
    handler: (ctx) => {
      const nums = ctx.args.map((a) => parseFloat(a)).filter((n) => !isNaN(n));
      return nums.length > 0 ? formatNum(Math.min(...nums)) : "0";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "max",
    category: "Math",
    description: "Return the largest of two or more numbers",
    returnType: "number",
    isList: true,
    handler: (ctx) => {
      const nums = ctx.args.map((a) => parseFloat(a)).filter((n) => !isNaN(n));
      return nums.length > 0 ? formatNum(Math.max(...nums)) : "0";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "clamp",
    category: "Math",
    description: "Clamp a value between min and max",
    returnType: "number",
    args: [
      { name: "value", description: "Value to clamp" },
      { name: "min", description: "Minimum bound" },
      { name: "max", description: "Maximum bound" },
    ],
    handler: (ctx) => {
      const val = parseFloat(ctx.args[0]) || 0;
      const lo = parseFloat(ctx.args[1]) || 0;
      const hi = parseFloat(ctx.args[2]) || 0;
      return formatNum(Math.min(Math.max(val, lo), hi));
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "abs",
    category: "Math",
    description: "Absolute value of a number",
    returnType: "number",
    args: [{ name: "value", description: "Number" }],
    handler: (ctx) => formatNum(Math.abs(parseFloat(ctx.args[0]) || 0)),
  });

  registry.registerMacro({
    builtIn: true,
    name: "floor",
    category: "Math",
    description: "Round down to nearest integer",
    returnType: "integer",
    args: [{ name: "value", description: "Number to floor" }],
    handler: (ctx) => String(Math.floor(parseFloat(ctx.args[0]) || 0)),
  });

  registry.registerMacro({
    builtIn: true,
    name: "ceil",
    category: "Math",
    description: "Round up to nearest integer",
    returnType: "integer",
    args: [{ name: "value", description: "Number to ceil" }],
    handler: (ctx) => String(Math.ceil(parseFloat(ctx.args[0]) || 0)),
  });

  registry.registerMacro({
    builtIn: true,
    name: "mod",
    category: "Math",
    description: "Modulo (remainder of division)",
    returnType: "number",
    args: [
      { name: "a", description: "Dividend" },
      { name: "b", description: "Divisor" },
    ],
    handler: (ctx) => {
      const a = parseFloat(ctx.args[0]) || 0;
      const b = parseFloat(ctx.args[1]) || 0;
      return b !== 0 ? formatNum(a % b) : "0";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "round",
    category: "Math",
    description: "Round a number to N decimal places (default 0)",
    returnType: "number",
    args: [
      { name: "value", description: "Number to round" },
      { name: "decimals", optional: true, description: "Decimal places (default 0)" },
    ],
    handler: (ctx) => {
      const val = parseFloat(ctx.args[0]) || 0;
      const dec = parseInt(ctx.args[1], 10) || 0;
      const factor = Math.pow(10, dec);
      return formatNum(Math.round(val * factor) / factor);
    },
  });
}

/** Format a number, stripping unnecessary trailing zeros. */
function formatNum(n: number): string {
  if (!isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  // Round to 6 decimal places to avoid floating-point artifacts
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}

// ============================================================================
// Safe arithmetic expression evaluator (no eval)
// Supports: + - * / % () and unary minus, with numbers (including decimals)
// ============================================================================

// Cap parser recursion so deeply-nested user input (e.g. `((((((...)))))`)
// can't blow the JS stack. 100 levels is far beyond any sane real expression
// and well under V8's default limit.
const MAX_CALC_DEPTH = 100;

function safeCalc(expr: string): number {
  const cleaned = expr.replace(/\s+/g, "");
  if (!cleaned) return 0;
  let pos = 0;
  let depth = 0;

  function descend<T>(fn: () => T): T {
    if (++depth > MAX_CALC_DEPTH) {
      throw new Error("calc: expression nested too deeply");
    }
    try {
      return fn();
    } finally {
      depth--;
    }
  }

  function parseExpr(): number {
    return descend(() => {
      let left = parseTerm();
      while (pos < cleaned.length) {
        const ch = cleaned[pos];
        if (ch === "+") {
          pos++;
          left += parseTerm();
        } else if (ch === "-") {
          pos++;
          left -= parseTerm();
        } else {
          break;
        }
      }
      return left;
    });
  }

  function parseTerm(): number {
    return descend(() => {
      let left = parseUnary();
      while (pos < cleaned.length) {
        const ch = cleaned[pos];
        if (ch === "*") {
          pos++;
          left *= parseUnary();
        } else if (ch === "/") {
          pos++;
          const r = parseUnary();
          left = r !== 0 ? left / r : 0;
        } else if (ch === "%") {
          pos++;
          const r = parseUnary();
          left = r !== 0 ? left % r : 0;
        } else {
          break;
        }
      }
      return left;
    });
  }

  function parseUnary(): number {
    return descend(() => {
      if (cleaned[pos] === "-") {
        pos++;
        return -parseUnary();
      }
      if (cleaned[pos] === "+") {
        pos++;
        return parseUnary();
      }
      return parsePrimary();
    });
  }

  function parsePrimary(): number {
    return descend(() => {
      if (cleaned[pos] === "(") {
        pos++;
        const result = parseExpr();
        if (cleaned[pos] === ")") pos++;
        return result;
      }
      const start = pos;
      while (pos < cleaned.length && (/[0-9.]/.test(cleaned[pos]))) pos++;
      const num = parseFloat(cleaned.substring(start, pos));
      return isNaN(num) ? 0 : num;
    });
  }

  try {
    const result = parseExpr();
    return result;
  } catch {
    return 0;
  }
}

/**
 * Shared condition evaluation for macros that branch on truthiness.
 *
 * This is the single source of truth used by {{if}} and by the predicate-style
 * iteration macros ({{filter}}, {{some}}, {{every}}) so a predicate behaves
 * exactly like an {{if}} condition: the same comparison operators, the same
 * `!` negation, the same `.var`/$var shorthand fallback, and the same falsy
 * set (empty, "0", "false", "null", "undefined", "no", "off").
 */

type VariableScopes = {
  local: Map<string, string>;
  global: Map<string, string>;
};

// Order matters — we scan for the *leftmost* operator and prefer the longest
// match at that position so e.g. ">=" beats ">" when both could apply at index N.
const COMPARISON_OPERATORS = ["==", "!=", ">=", "<=", ">", "<"] as const;

function findComparisonOperator(
  value: string,
): { op: (typeof COMPARISON_OPERATORS)[number]; index: number } | null {
  let bestIndex = -1;
  let bestOp: (typeof COMPARISON_OPERATORS)[number] | null = null;
  for (const op of COMPARISON_OPERATORS) {
    const index = value.indexOf(op);
    if (index === -1) continue;
    if (
      bestIndex === -1 ||
      index < bestIndex ||
      (index === bestIndex && op.length > (bestOp?.length ?? 0))
    ) {
      bestIndex = index;
      bestOp = op;
    }
  }
  return bestOp ? { op: bestOp, index: bestIndex } : null;
}

/**
 * Truthiness of a resolved condition string, including comparison operators.
 * Does not handle `!` negation or shorthand resolution — see
 * {@link evaluateMacroCondition} for the full pipeline.
 */
export function isConditionTruthy(value: string): boolean {
  // Unresolved macros (reconstructed as {{name}} by the evaluator) mean the
  // value couldn't be determined — treat the entire condition as falsy.
  if (value.includes("{{") && value.includes("}}")) {
    return false;
  }

  // Linear scan for the first comparison operator; avoids a regex whose
  // greedy/non-greedy combination could backtrack pathologically on
  // user-supplied values.
  const found = findComparisonOperator(value);
  if (found) {
    const lv = value.slice(0, found.index).trim();
    const rv = value.slice(found.index + found.op.length).trim();

    const ln = parseFloat(lv);
    const rn = parseFloat(rv);
    const bothNumeric = !isNaN(ln) && !isNaN(rn);

    switch (found.op) {
      case "==":
        return bothNumeric ? ln === rn : lv === rv;
      case "!=":
        return bothNumeric ? ln !== rn : lv !== rv;
      case ">":
        return bothNumeric ? ln > rn : lv > rv;
      case ">=":
        return bothNumeric ? ln >= rn : lv >= rv;
      case "<":
        return bothNumeric ? ln < rn : lv < rv;
      case "<=":
        return bothNumeric ? ln <= rn : lv <= rv;
    }
  }

  // Falsy values. "no" and "off" are included case-insensitively so the
  // dozen-plus yes/no boolean macros across the codebase (isGroupChat,
  // isMultiplayer, databank/memory/cortex enabled flags, loom Sovereign Hand,
  // etc.) work as documented — those macros emit the literal string "no" when
  // off.
  if (!value) return false;
  const lower = value.toLowerCase();
  if (
    lower === "0" ||
    lower === "false" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "no" ||
    lower === "off"
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve .varName and $varName shorthands within a condition string. Used as a
 * fallback when the lexer couldn't detect the shorthand (e.g. preceded by `!`
 * or other non-space characters).
 */
function resolveInlineShorthands(condition: string, variables: VariableScopes): string {
  return condition
    .replace(/(^|\s)\.([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + (variables.local.get(name) ?? ""))
    .replace(/(^|\s)\$([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + (variables.global.get(name) ?? ""));
}

/**
 * Full condition pipeline: strip a leading `!` (negation), resolve any leftover
 * variable shorthands, then evaluate truthiness. The input should already have
 * its nested macros resolved by the caller.
 */
export function evaluateMacroCondition(condition: string, variables: VariableScopes): boolean {
  let c = condition.trim();
  let negate = false;
  if (c.startsWith("!")) {
    negate = true;
    c = c.slice(1).trim();
  }
  c = resolveInlineShorthands(c, variables);
  const truthy = isConditionTruthy(c);
  return negate ? !truthy : truthy;
}

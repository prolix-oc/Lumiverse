import { registry } from "../MacroRegistry";
import { parseList, formatList, resolveIndex, MAX_LIST_ITEMS } from "../list-utils";

/**
 * List algebra — query and transform comma-separated lists. These compose with
 * the iteration family ({{foreach}}, {{filter}}, …) and with any macro that
 * emits a list ({{players}}, {{group}}, {{range}}). Input is split on commas
 * (items trimmed, blanks dropped); list-returning macros emit a clean,
 * comma-separated list so the whole family round-trips.
 */
export function registerListMacros(): void {
  // ---- range: numeric sequence generator (feeds loops) ----
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "range",
    category: "Iteration",
    description:
      "Generate a numeric sequence as a comma-separated list. {{range::5}} → 1, 2, 3, 4, 5. " +
      "{{range::start::end}} (inclusive) or {{range::start::end::step}}. Counts down when start > end.",
    returnType: "string",
    args: [
      { name: "start_or_end", description: "End (1-based) with one arg, or start with two+" },
      { name: "end", optional: true, description: "End value (inclusive)" },
      { name: "step", optional: true, description: "Step size (default 1, or -1 counting down)" },
    ],
    handler: (ctx) => {
      const singleArg = ctx.args.length <= 1;
      let start: number;
      let end: number;
      if (singleArg) {
        start = 1;
        end = parseInt(ctx.args[0], 10);
      } else {
        start = parseInt(ctx.args[0], 10);
        end = parseInt(ctx.args[1], 10);
      }
      if (isNaN(start) || isNaN(end)) return "";

      let step = ctx.args[2] !== undefined ? parseInt(ctx.args[2], 10) : NaN;
      // Default/invalid/zero step: the single-arg form always ascends (1..n, so
      // {{range::0}} is empty); the explicit start/end form infers direction.
      if (isNaN(step) || step === 0) step = singleArg || end >= start ? 1 : -1;

      const out: number[] = [];
      // A step whose sign disagrees with the start→end direction yields an empty
      // list rather than looping forever.
      if (step > 0) {
        for (let v = start; v <= end && out.length < MAX_LIST_ITEMS; v += step) out.push(v);
      } else {
        for (let v = start; v >= end && out.length < MAX_LIST_ITEMS; v += step) out.push(v);
      }
      if (out.length >= MAX_LIST_ITEMS) {
        ctx.warn(`{{range}} capped at ${MAX_LIST_ITEMS} items`);
      }
      return out.join(", ");
    },
  });

  // ---- count: number of items ----
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "count",
    category: "Lists",
    description: "Number of items in a comma-separated list (blanks ignored).",
    returnType: "integer",
    args: [{ name: "list", description: "Comma-separated list" }],
    aliases: ["listLength", "list_count"],
    handler: (ctx) => String(parseList(ctx.args[0] ?? "").length),
  });

  // ---- includes: membership test (condition-compatible) ----
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "includes",
    category: "Lists",
    description:
      "'true' if the list contains the item (whole-item, case-sensitive match), else ''. Usable as a condition.",
    returnType: "boolean",
    args: [
      { name: "list", description: "Comma-separated list" },
      { name: "item", description: "Item to look for" },
    ],
    aliases: ["contains", "inList"],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      const needle = (ctx.args[1] ?? "").trim();
      return items.includes(needle) ? "true" : "";
    },
  });

  // ---- nth / first / last: indexed access ----
  registry.registerMacro({
    builtIn: true,
    name: "nth",
    category: "Lists",
    description: "Item at a 0-based index (negative counts from the end). Empty if out of range.",
    returnType: "string",
    args: [
      { name: "list", description: "Comma-separated list" },
      { name: "index", description: "0-based index; negative counts from the end" },
    ],
    aliases: ["at"],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      const i = resolveIndex(parseInt(ctx.args[1], 10), items.length);
      return items[i] ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "first",
    category: "Lists",
    description: "First item of a list (empty if the list is empty).",
    returnType: "string",
    args: [{ name: "list", description: "Comma-separated list" }],
    handler: (ctx) => parseList(ctx.args[0] ?? "")[0] ?? "",
  });

  registry.registerMacro({
    builtIn: true,
    name: "last",
    category: "Lists",
    description: "Last item of a list (empty if the list is empty).",
    returnType: "string",
    args: [{ name: "list", description: "Comma-separated list" }],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      return items[items.length - 1] ?? "";
    },
  });

  // ---- slice / take: sublists ----
  registry.registerMacro({
    builtIn: true,
    name: "slice",
    category: "Lists",
    description:
      "Sublist from start to end (end exclusive, optional). Negative indices count from the end. " +
      "{{slice::list::-3}} → last 3 items.",
    returnType: "string",
    args: [
      { name: "list", description: "Comma-separated list" },
      { name: "start", description: "Start index (0-based; negative from end)" },
      { name: "end", optional: true, description: "End index, exclusive (default: through end)" },
    ],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      const start = parseInt(ctx.args[1], 10);
      const s = isNaN(start) ? 0 : start;
      const hasEnd = ctx.args[2] !== undefined && ctx.args[2] !== "";
      const end = hasEnd ? parseInt(ctx.args[2], 10) : NaN;
      const out = hasEnd && !isNaN(end) ? items.slice(s, end) : items.slice(s);
      return formatList(out);
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "take",
    category: "Lists",
    description: "First N items of a list (negative N takes the last |N| items).",
    returnType: "string",
    args: [
      { name: "list", description: "Comma-separated list" },
      { name: "n", description: "How many items (negative counts from the end)" },
    ],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      const n = parseInt(ctx.args[1], 10) || 0;
      return formatList(n >= 0 ? items.slice(0, n) : items.slice(n));
    },
  });

  // ---- sort / unique / reverseList / shuffle: ordering & hygiene ----
  registry.registerMacro({
    builtIn: true,
    name: "sort",
    category: "Lists",
    description:
      "Sort a list. Numeric when every item is a number, otherwise alphabetical. " +
      "Pass 'desc' as the second argument to reverse the order.",
    returnType: "string",
    args: [
      { name: "list", description: "Comma-separated list" },
      { name: "direction", optional: true, description: "'asc' (default) or 'desc'" },
    ],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      const dir = (ctx.args[1] ?? "").trim().toLowerCase();
      const allNumeric =
        items.length > 0 && items.every((x) => x.trim() !== "" && !isNaN(Number(x)));
      const sorted = [...items].sort(
        allNumeric ? (a, b) => Number(a) - Number(b) : (a, b) => a.localeCompare(b),
      );
      if (dir === "desc" || dir === "descending" || dir === "reverse") sorted.reverse();
      return formatList(sorted);
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "unique",
    category: "Lists",
    description: "Remove duplicate items, keeping the first occurrence's order.",
    returnType: "string",
    args: [{ name: "list", description: "Comma-separated list" }],
    aliases: ["dedupe", "distinct"],
    handler: (ctx) => formatList([...new Set(parseList(ctx.args[0] ?? ""))]),
  });

  registry.registerMacro({
    builtIn: true,
    name: "reverseList",
    category: "Lists",
    description: "Reverse the order of a list's items.",
    returnType: "string",
    args: [{ name: "list", description: "Comma-separated list" }],
    aliases: ["reverse_list"],
    handler: (ctx) => formatList(parseList(ctx.args[0] ?? "").reverse()),
  });

  registry.registerMacro({
    builtIn: true,
    volatile: true,
    name: "shuffle",
    category: "Lists",
    description: "Randomly reorder a list's items.",
    returnType: "string",
    args: [{ name: "list", description: "Comma-separated list" }],
    handler: (ctx) => {
      const items = parseList(ctx.args[0] ?? "");
      // Fisher-Yates.
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return formatList(items);
    },
  });

  // ---- numeric reductions: sum / avg / listMax / listMin ----
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "sum",
    category: "Lists",
    description: "Sum the numeric items of a list (non-numbers ignored). 0 for an empty list.",
    returnType: "number",
    args: [{ name: "list", description: "Comma-separated list of numbers" }],
    handler: (ctx) => fmtNum(toNumbers(parseList(ctx.args[0] ?? "")).reduce((a, b) => a + b, 0)),
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "avg",
    category: "Lists",
    description: "Average (mean) of the numeric items of a list. Empty when there are no numbers.",
    returnType: "number",
    args: [{ name: "list", description: "Comma-separated list of numbers" }],
    aliases: ["mean", "average"],
    handler: (ctx) => {
      const nums = toNumbers(parseList(ctx.args[0] ?? ""));
      if (nums.length === 0) return "";
      return fmtNum(nums.reduce((a, b) => a + b, 0) / nums.length);
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "listMax",
    category: "Lists",
    description: "Largest numeric item of a list. Empty when there are no numbers.",
    returnType: "number",
    args: [{ name: "list", description: "Comma-separated list of numbers" }],
    aliases: ["list_max"],
    handler: (ctx) => {
      const nums = toNumbers(parseList(ctx.args[0] ?? ""));
      return nums.length === 0 ? "" : fmtNum(Math.max(...nums));
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "listMin",
    category: "Lists",
    description: "Smallest numeric item of a list. Empty when there are no numbers.",
    returnType: "number",
    args: [{ name: "list", description: "Comma-separated list of numbers" }],
    aliases: ["list_min"],
    handler: (ctx) => {
      const nums = toNumbers(parseList(ctx.args[0] ?? ""));
      return nums.length === 0 ? "" : fmtNum(Math.min(...nums));
    },
  });
}

/** Parse a list's items into finite numbers, dropping anything non-numeric. */
function toNumbers(items: string[]): number[] {
  return items.map((x) => Number(x)).filter((n) => !isNaN(n) && isFinite(n));
}

/** Format a number for output: strip floating-point noise and trailing zeros. */
function fmtNum(n: number): string {
  return String(parseFloat(n.toFixed(6)));
}

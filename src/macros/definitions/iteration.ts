import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";
import { parseDelimitedList, formatList, MAX_LIST_ITEMS } from "../list-utils";
import { evaluateMacroCondition } from "../conditions";

/**
 * Scoped iteration macros that loop a list and resolve a body per item:
 *   {{foreach}} — concatenate the body for every item
 *   {{filter}}  — keep items whose body (a predicate) is truthy
 *   {{some}} / {{every}} — quantifiers over a predicate
 *
 * They share the `::list::var::delimiter` signature, the loop-variable bindings,
 * and the hygienic save/restore below. {{filter}}/{{some}}/{{every}} treat the
 * body as an {{if}}-style condition (same operators, negation, and falsy set)
 * via evaluateMacroCondition.
 */

// Loop variables bound for the body. `item` is the value; the suffixed forms
// give position/size/edge info. See bindLoopVars.
const LOOP_SUFFIXES = ["", "_index", "_number", "_count", "_first", "_last"] as const;

/**
 * Names of the variables a loop binds. `extra` adds macro-specific suffixes
 * (e.g. `_name`/`_is_user` for messages, `_key`/`_value` for variables) so they
 * are snapshotted and restored alongside the standard positional bindings.
 */
function loopKeys(varName: string, extra: readonly string[] = []): string[] {
  return [...LOOP_SUFFIXES, ...extra].map((s) => `${varName}${s}`);
}

/** Snapshot the loop variables' current values so they can be restored. */
function snapshotVars(
  local: Map<string, string>,
  keys: string[],
): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const k of keys) saved.set(k, local.has(k) ? local.get(k) : undefined);
  return saved;
}

/** Restore loop variables to their snapshot (deleting ones that didn't exist). */
function restoreVars(local: Map<string, string>, saved: Map<string, string | undefined>): void {
  for (const [k, prev] of saved) {
    if (prev === undefined) local.delete(k);
    else local.set(k, prev);
  }
}

/** Bind the loop variables for iteration `i` of `count` items. */
function bindLoopVars(
  local: Map<string, string>,
  varName: string,
  item: string,
  i: number,
  count: number,
): void {
  local.set(varName, item);
  local.set(`${varName}_index`, String(i));
  local.set(`${varName}_number`, String(i + 1));
  local.set(`${varName}_count`, String(count));
  local.set(`${varName}_first`, i === 0 ? "true" : "");
  local.set(`${varName}_last`, i === count - 1 ? "true" : "");
}

interface IterArgs {
  items: string[];
  varName: string;
}

/**
 * Parse the shared `::list::var::delimiter` signature. Returns null (with a
 * warning) when used without a body. Caps the item count like {{repeat}}.
 */
async function parseIterArgs(ctx: MacroExecContext): Promise<IterArgs | null> {
  if (!ctx.isScoped) {
    ctx.warn(`{{${ctx.name}}} needs a body: {{${ctx.name}::list}}...{{/${ctx.name}}}`);
    return null;
  }
  const listStr = ctx.rawArgs[0] ? (await ctx.resolveNodes(ctx.rawArgs[0])).trim() : "";
  const varName = (ctx.rawArgs[1] ? (await ctx.resolveNodes(ctx.rawArgs[1])).trim() : "") || "item";
  const delimiter = ctx.rawArgs[2] ? await ctx.resolveNodes(ctx.rawArgs[2]) : ",";
  let items = parseDelimitedList(listStr, delimiter);
  if (items.length > MAX_LIST_ITEMS) {
    ctx.warn(`{{${ctx.name}}} capped at ${MAX_LIST_ITEMS} items (got ${items.length})`);
    items = items.slice(0, MAX_LIST_ITEMS);
  }
  return { items, varName };
}

/** Resolve the scoped body and evaluate it as an {{if}}-style condition. */
async function bodyIsTruthy(ctx: MacroExecContext): Promise<boolean> {
  let s = (await ctx.resolveNodes(ctx.bodyRaw)).trim();
  // Safety re-resolve for the rare case where a value depends on state mutated
  // later in the same template (mirrors {{if}}).
  if (s.includes("{{")) {
    const next = (await ctx.resolve(s)).trim();
    if (next !== s) s = next;
  }
  return evaluateMacroCondition(s, ctx.env.variables);
}

export function registerIterationMacros(): void {
  // ---- foreach ----
  //
  // {{foreach::<list>}}body{{/foreach}}
  // {{foreach::<list>::<var>}}body{{/foreach}}
  // {{foreach::<list>::<var>::<delimiter>}}body{{/foreach}}
  //
  // Body bindings (replace `item` with <var>): {{.item}}, {{.item_index}}
  // (0-based), {{.item_number}} (1-based), {{.item_count}}, {{.item_first}},
  // {{.item_last}} ("true"/"").
  registry.registerMacro({
    builtIn: true,
    name: "foreach",
    category: "Iteration",
    description:
      "Iterate over a delimited list, resolving the body once per item. " +
      "Usage: {{foreach::a,b,c}}...{{.item}}...{{/foreach}}. Optional args: loop " +
      "variable name (default 'item') and delimiter (default ',').",
    returnType: "string",
    delayArgResolution: true,
    aliases: ["each", "for_each"],
    handler: async (ctx) => {
      const parsed = await parseIterArgs(ctx);
      if (!parsed) return "";
      const { items, varName } = parsed;
      if (items.length === 0) return "";

      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName));
      let out = "";
      try {
        for (let i = 0; i < items.length; i++) {
          bindLoopVars(local, varName, items[i], i, items.length);
          out += await ctx.resolveNodes(ctx.bodyRaw);
        }
      } finally {
        restoreVars(local, saved);
      }
      return out;
    },
  });

  // ---- map: transform each list item and return a delimited list ----
  registry.registerMacro({
    builtIn: true,
    name: "map",
    category: "Iteration",
    description:
      "Transform each item in a delimited list with a scoped body. " +
      "Usage: {{map::a,b,c::x}}{{upper::{{.x}}}}{{/map}}. Optional args: loop " +
      "variable name, input delimiter, output delimiter (default ', ').",
    returnType: "string",
    delayArgResolution: true,
    aliases: ["collect"],
    handler: async (ctx) => {
      const parsed = await parseIterArgs(ctx);
      if (!parsed) return "";
      const { items, varName } = parsed;
      if (items.length === 0) return "";

      const outputDelimiter = ctx.rawArgs[3] ? await ctx.resolveNodes(ctx.rawArgs[3]) : ", ";
      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName));
      const mapped: string[] = [];
      try {
        for (let i = 0; i < items.length; i++) {
          bindLoopVars(local, varName, items[i], i, items.length);
          mapped.push((await ctx.resolveNodes(ctx.bodyRaw)).trim());
        }
      } finally {
        restoreVars(local, saved);
      }
      return mapped.filter((item) => item !== "").join(outputDelimiter);
    },
  });

  // ---- filter: keep items whose predicate body is truthy ----
  registry.registerMacro({
    builtIn: true,
    name: "filter",
    category: "Iteration",
    description:
      "Keep list items whose body (an {{if}}-style condition) is truthy; returns a " +
      "comma-separated list. Usage: {{filter::a,b,c::x}}{{gt::{{.x}}::1}}{{/filter}}.",
    returnType: "string",
    delayArgResolution: true,
    aliases: ["where"],
    handler: async (ctx) => {
      const parsed = await parseIterArgs(ctx);
      if (!parsed) return "";
      const { items, varName } = parsed;
      if (items.length === 0) return "";

      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName));
      const kept: string[] = [];
      try {
        for (let i = 0; i < items.length; i++) {
          bindLoopVars(local, varName, items[i], i, items.length);
          if (await bodyIsTruthy(ctx)) kept.push(items[i]);
        }
      } finally {
        restoreVars(local, saved);
      }
      return formatList(kept);
    },
  });

  // ---- some / every: predicate quantifiers (condition-compatible) ----
  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "some",
    category: "Iteration",
    description:
      "'true' if any list item's body (an {{if}}-style condition) is truthy, else ''. " +
      "Short-circuits. Usage: {{some::{{players}}::p}}{{gt::{{@hp_{{.p}}}}::0}}{{/some}}.",
    returnType: "boolean",
    delayArgResolution: true,
    aliases: ["any"],
    handler: async (ctx) => {
      const parsed = await parseIterArgs(ctx);
      if (!parsed) return "";
      const { items, varName } = parsed;

      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName));
      let result = false;
      try {
        for (let i = 0; i < items.length; i++) {
          bindLoopVars(local, varName, items[i], i, items.length);
          if (await bodyIsTruthy(ctx)) {
            result = true;
            break;
          }
        }
      } finally {
        restoreVars(local, saved);
      }
      return result ? "true" : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "every",
    category: "Iteration",
    description:
      "'true' if every list item's body (an {{if}}-style condition) is truthy, else ''. " +
      "Vacuously 'true' for an empty list. Short-circuits.",
    returnType: "boolean",
    delayArgResolution: true,
    aliases: ["all"],
    handler: async (ctx) => {
      const parsed = await parseIterArgs(ctx);
      if (!parsed) return "";
      const { items, varName } = parsed;

      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName));
      let result = true;
      try {
        for (let i = 0; i < items.length; i++) {
          bindLoopVars(local, varName, items[i], i, items.length);
          if (!(await bodyIsTruthy(ctx))) {
            result = false;
            break;
          }
        }
      } finally {
        restoreVars(local, saved);
      }
      return result ? "true" : "";
    },
  });

  // ---- foreachMessage: iterate the chat history ----
  //
  // {{foreachMessage}}body{{/foreachMessage}}        — every message
  // {{foreachMessage::5}}body{{/foreachMessage}}     — last 5 (chronological)
  // {{foreachMessage::5::m}}body{{/foreachMessage}}  — last 5, var "m"
  // {{foreachMessage::m}}body{{/foreachMessage}}     — every message, var "m"
  //
  // Bindings (replace `msg`): {{.msg}} content, {{.msg_name}} author,
  // {{.msg_is_user}} ("true"/""), plus {{.msg_index/_number/_count/_first/_last}}.
  registry.registerMacro({
    builtIn: true,
    name: "foreachMessage",
    category: "Iteration",
    description:
      "Iterate over chat history, resolving the body once per message. Optional first arg: a " +
      "number (iterate the last N messages) or a loop variable name (default 'msg'). Bindings: " +
      "{{.msg}}, {{.msg_name}}, {{.msg_is_user}}, plus the usual index/number/count/first/last.",
    returnType: "string",
    delayArgResolution: true,
    aliases: ["for_each_message"],
    handler: async (ctx) => {
      if (!ctx.isScoped) {
        ctx.warn("{{foreachMessage}} needs a body: {{foreachMessage}}...{{/foreachMessage}}");
        return "";
      }
      // First arg is either a count (last N) or — when non-numeric — the loop
      // variable name; the second arg is the variable name when a count is given.
      const a0 = ctx.rawArgs[0] ? (await ctx.resolveNodes(ctx.rawArgs[0])).trim() : "";
      const a1 = ctx.rawArgs[1] ? (await ctx.resolveNodes(ctx.rawArgs[1])).trim() : "";
      let count = 0; // 0 = all
      let varName = "msg";
      if (a0 !== "") {
        if (/^\d+$/.test(a0)) {
          count = parseInt(a0, 10);
          if (a1) varName = a1;
        } else {
          varName = a0;
        }
      }

      const all = getMessages(ctx);
      let messages = count > 0 ? all.slice(-count) : all;
      if (messages.length > MAX_LIST_ITEMS) {
        ctx.warn(`{{foreachMessage}} capped at ${MAX_LIST_ITEMS} messages`);
        messages = messages.slice(-MAX_LIST_ITEMS);
      }
      if (messages.length === 0) return "";

      const local = ctx.env.variables.local;
      const saved = snapshotVars(local, loopKeys(varName, ["_name", "_is_user"]));
      let out = "";
      try {
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          bindLoopVars(local, varName, m.content ?? "", i, messages.length);
          local.set(`${varName}_name`, m.name ?? "");
          local.set(`${varName}_is_user`, m.is_user ? "true" : "");
          out += await ctx.resolveNodes(ctx.bodyRaw);
        }
      } finally {
        restoreVars(local, saved);
      }
      return out;
    },
  });

  // ---- foreachVar / foreachChatVar / foreachGlobalVar: iterate namespaced variables ----
  //
  // Iterate the variables in a scope whose name starts with a prefix. Build a
  // state table with {{@hp_Alice = 100}} / {{@hp_Bob = 80}} then render it:
  //   {{foreachChatVar::hp_::p}}{{.p}}: {{.p_value}}{{newline}}{{/foreachChatVar}}
  //
  // Bindings (replace `item`): {{.item}} name after the prefix, {{.item_key}}
  // full name, {{.item_value}} value, plus index/number/count/first/last.
  // Marked volatile: the result depends on the full keyset, which the dependency
  // fingerprint cannot track (it only records individual var get/has).
  const VAR_SCOPES = [
    { name: "foreachVar", scope: "local", aliases: ["for_each_var"] },
    { name: "foreachChatVar", scope: "chat", aliases: ["for_each_chat_var"] },
    { name: "foreachGlobalVar", scope: "global", aliases: ["foreachGvar", "for_each_global_var"] },
  ] as const;
  for (const { name, scope, aliases } of VAR_SCOPES) {
    registry.registerMacro({
      builtIn: true,
      volatile: true,
      name,
      category: "Iteration",
      description:
        `Iterate ${scope} variables whose name starts with a prefix (alphabetical order). ` +
        `Bindings: {{.item}} (name after the prefix), {{.item_key}} (full name), {{.item_value}}, ` +
        `plus index/number/count/first/last. Usage: {{${name}::prefix::var}}...{{/${name}}}.`,
      returnType: "string",
      delayArgResolution: true,
      aliases: [...aliases],
      handler: (ctx) => runForeachVar(ctx, ctx.env.variables[scope]),
    });
  }
}

interface SimpleMessage {
  content: string;
  name: string;
  is_user: boolean;
}

/** Chat history off the env (same source as {{messageAt}}), or [] when absent. */
function getMessages(ctx: MacroExecContext): SimpleMessage[] {
  const m = ctx.env.extra?.messages;
  return Array.isArray(m) ? (m as SimpleMessage[]) : [];
}

/**
 * Shared implementation for the foreach*Var family. Iterates the variables of
 * `scopeMap` whose name starts with the prefix, in alphabetical order. The
 * loop bindings always live in the LOCAL scope (so {{.var}} shorthand resolves)
 * regardless of which scope is being read.
 */
async function runForeachVar(ctx: MacroExecContext, scopeMap: Map<string, string>): Promise<string> {
  if (!ctx.isScoped) {
    ctx.warn(`{{${ctx.name}}} needs a body: {{${ctx.name}::prefix}}...{{/${ctx.name}}}`);
    return "";
  }
  const prefix = ctx.rawArgs[0] ? (await ctx.resolveNodes(ctx.rawArgs[0])).trim() : "";
  const varName = (ctx.rawArgs[1] ? (await ctx.resolveNodes(ctx.rawArgs[1])).trim() : "") || "item";

  // Snapshot the matching variables BEFORE binding loop vars, so writing the
  // loop bindings can't perturb the set being iterated (matters when iterating
  // the local scope, which is also where the loop bindings live).
  let matched = [...scopeMap.keys()].filter((k) => k.startsWith(prefix)).sort();
  if (matched.length === 0) return "";
  if (matched.length > MAX_LIST_ITEMS) {
    ctx.warn(`{{${ctx.name}}} capped at ${MAX_LIST_ITEMS} variables (got ${matched.length})`);
    matched = matched.slice(0, MAX_LIST_ITEMS);
  }
  const entries = matched.map((k) => [k, scopeMap.get(k) ?? ""] as const);

  const local = ctx.env.variables.local;
  const saved = snapshotVars(local, loopKeys(varName, ["_key", "_value"]));
  let out = "";
  try {
    for (let i = 0; i < entries.length; i++) {
      const [fullKey, value] = entries[i];
      const id = prefix && fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
      bindLoopVars(local, varName, id, i, entries.length);
      local.set(`${varName}_key`, fullKey);
      local.set(`${varName}_value`, value);
      out += await ctx.resolveNodes(ctx.bodyRaw);
    }
  } finally {
    restoreVars(local, saved);
  }
  return out;
}

import type { Preset, PromptBlock, PromptVariableValues } from "../types/preset";
import { coercePromptVariable } from "./prompt-variable-values";

/** Only persisted inputs: never the macro engine's mutable local/global variables. */
export interface ActivationInputSnapshot {
  char?: string;
  user?: string;
  chatVariables?: ReadonlyMap<string, unknown>;
  presetVariables?: ReadonlyMap<string, ReadonlyMap<string, string | number>>;
}

type InputReference = { token: string; kind: "char" | "user" | "getchatvar" | "presetvar"; args: string[] };
type PatternPart = string | InputReference;

/** Parse a small, nonrecursive whitelist, not general macro syntax. */
export function parseActivationFindPattern(pattern: string): PatternPart[] {
  if (pattern.length > 10_000) throw new Error("Activation find pattern exceeds 10000 characters");
  const parts: PatternPart[] = [];
  let start = 0;
  let classDepth = 0;
  let inputs = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      if (pattern.startsWith("{{", i + 1)) throw new Error("Activation inputs cannot follow a regex escape");
      i++;
      continue;
    }
    if (pattern[i] === "[") classDepth++;
    if (pattern[i] === "]") classDepth = Math.max(0, classDepth - 1);
    if (!pattern.startsWith("{{", i)) continue;
    if (classDepth) throw new Error("Activation inputs cannot appear inside character classes");
    const end = pattern.indexOf("}}", i + 2);
    if (end === -1) throw new Error("Unclosed activation input");
    const token = pattern.slice(i, end + 2);
    const [name, ...args] = token.slice(2, -2).split("::").map((part) => part.trim());
    const kind = name.toLowerCase() as InputReference["kind"];
    const arity = kind === "char" || kind === "user" ? 0 : kind === "getchatvar" ? 1 : kind === "presetvar" ? 2 : -1;
    if (arity < 0 || args.length !== arity || args.some((arg) => !arg || arg.length > 200 || /[{}\r\n]/.test(arg))) {
      throw new Error(`Unsupported activation input ${token}: use char, user, getchatvar::key, or presetvar::block-id::variable-id`);
    }
    if (++inputs > 32) throw new Error("Activation find patterns support at most 32 inputs");
    parts.push(pattern.slice(start, i), { token, kind, args });
    i = end + 1;
    start = end + 2;
  }
  parts.push(pattern.slice(start));
  return parts;
}

/** Validate template structure and stable preset IDs without needing live chat values. */
export function activationPatternForValidation(pattern: string, blocks?: PromptBlock[]): string {
  return parseActivationFindPattern(pattern).map((part) => {
    if (typeof part === "string") return part;
    if (part.kind === "presetvar" && blocks) {
      const block = blocks.find((block) => block.id === part.args[0]);
      if (!block?.variables?.some((def) => def.id === part.args[1])) {
        throw new Error(`Unknown linked preset variable: ${part.token}`);
      }
    }
    return "(?:x)";
  }).join("");
}

/** One regex atom per value; no injection, capture renumbering, or recursive expansion. */
function literalAtom(value: string): string {
  let escaped = "";
  for (let i = 0; i < value.length; i++) escaped += `\\u${value.charCodeAt(i).toString(16).padStart(4, "0")}`;
  return `(?:${escaped})`;
}

export function resolveActivationFindPattern(pattern: string, snapshot: ActivationInputSnapshot = {}): string {
  const result = parseActivationFindPattern(pattern).map((part) => {
    if (typeof part === "string") return part;
    const value = part.kind === "getchatvar" ? snapshot.chatVariables?.get(part.args[0])
      : part.kind === "presetvar" ? snapshot.presetVariables?.get(part.args[0])?.get(part.args[1])
      : snapshot[part.kind];
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      || (typeof value === "number" && !Number.isFinite(value)) || !String(value).trim()) {
      throw new Error(`Missing or empty activation input: ${part.token}`);
    }
    const text = String(value);
    if (text.length > 1024) throw new Error(`Activation input exceeds 1024 characters: ${part.token}`);
    return literalAtom(text);
  }).join("");
  if (result.length > 100_000) throw new Error("Resolved activation pattern exceeds 100000 characters");
  return result;
}

function own(object: unknown, key: string): unknown {
  return object && typeof object === "object" && Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined;
}

/** Snapshot typed selections/defaults even from closed blocks, without evaluating their content. */
export function createActivationInputSnapshot(input: {
  characterName?: string;
  userName?: string;
  chatVariables?: Record<string, unknown>;
  preset?: Pick<Preset, "prompt_order" | "metadata"> | null;
  profileValues?: PromptVariableValues;
  /** Restrict schema reads to references in these rules. Omit only for a full snapshot. */
  patterns?: string[];
}): ActivationInputSnapshot {
  const requested = input.patterns ? new Map<string, Set<string>>() : undefined;
  for (const pattern of input.patterns ?? []) {
    try {
      for (const part of parseActivationFindPattern(pattern)) {
        if (typeof part === "string" || part.kind !== "presetvar") continue;
        const variables = requested!.get(part.args[0]) ?? new Set<string>();
        variables.add(part.args[1]);
        requested!.set(part.args[0], variables);
      }
    } catch { /* The rule resolver reports invalid templates and keeps their gates closed. */ }
  }
  const presetVariables = new Map<string, ReadonlyMap<string, string | number>>();
  for (const block of input.preset?.prompt_order ?? []) {
    if (requested && !requested.has(block.id)) continue;
    const values = new Map<string, string | number>();
    for (const def of block.variables ?? []) {
      if (!def?.id || !def.name) continue;
      if (requested && !requested.get(block.id)!.has(def.id)) continue;
      const profile = own(own(input.profileValues, block.id), def.name);
      const stored = own(own(input.preset?.metadata?.promptVariables, block.id), def.name);
      try {
        values.set(def.id, coercePromptVariable(def, profile === undefined ? stored : profile).rendered);
      } catch { /* Malformed legacy definitions resolve as missing, not as executable content. */ }
    }
    presetVariables.set(block.id, values);
  }
  return {
    char: input.characterName,
    user: input.userName,
    chatVariables: new Map(Object.entries(input.chatVariables ?? {})),
    presetVariables,
  };
}

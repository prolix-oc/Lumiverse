import type { GenerationResponse } from "../llm/types";
import type { AgentPublicBudgetId, AgentPublicErrorCode } from "../types/agent-runtime";

export const AGENT_CHILD_TASK_MAX_BYTES = 32 * 1024;
export const AGENT_INITIAL_INPUT_MAX_BYTES = 256 * 1024;
export const AGENT_RETAINED_DATA_MAX_BYTES = 256 * 1024;
export const AGENT_SERIALIZED_VALUE_MAX_BYTES = 64 * 1024;
export const AGENT_ARGUMENT_MAX_BYTES = 16 * 1024;
export const AGENT_RESULT_MAX_BYTES = 64 * 1024;
export const AGENT_CONTINUATION_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_JSON_DEPTH_MAX = 32;
export const AGENT_JSON_NODE_MAX = 4_096;
export const AGENT_PROVIDER_REASONING_CARRIER_MAX_BYTES = 256 * 1024;
/** Maximum candidate rows admitted to one owned-lore relevance preflight scan. */
export const AGENT_LORE_SEARCH_SCAN_MAX_ROWS = 4_096;
/** Maximum cumulative UTF-8 bytes in ranked candidate fields for one preflight scan. */
export const AGENT_LORE_SEARCH_SCAN_MAX_BYTES = 2 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();
export interface JsonBounds { readonly bytes: number; readonly depth: number; readonly nodes: number; }
export interface JsonBoundsOptions { readonly maxBytes?: number; readonly maxDepth?: number; readonly maxNodes?: number; }
export interface ProviderUsageValidation { readonly valid: boolean; readonly outputTokens: number; readonly reason?: "negative" | "non_integer" | "contradictory" | "over_allowance"; }
export interface ObservedOutputOptions { readonly countTokens?: (text: string) => number; readonly allowance?: number; }
export interface SettleOutputOptions { readonly countTokens?: (text: string) => number; readonly observedTokens?: number; }
export interface OutputTokenSettlement {
  readonly tokens: number;
  readonly usage: ProviderUsageValidation;
  readonly observed: number;
  readonly failure?: AgentAccountingFailure;
}

export class AgentAccountingFailure extends Error {
  readonly code: AgentPublicErrorCode;
  readonly budget: AgentPublicBudgetId;
  readonly limit: number;
  readonly observed: number;
  constructor(code: AgentPublicErrorCode, budget: AgentPublicBudgetId, limit: number, observed: number) {
    super(`${code}: ${budget} ${observed}/${limit}`);
    this.name = "AgentAccountingFailure";
    this.code = code;
    this.budget = budget;
    this.limit = limit;
    this.observed = observed;
  }
}

export function utf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
  return UTF8_ENCODER.encode(value).byteLength;
}
function primitiveJsonBytes(value: unknown): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 4;
  if (typeof value === "bigint") throw new TypeError("BigInt is not JSON serializable");
  const serialized = JSON.stringify(value);
  return utf8ByteLength(serialized === undefined ? "null" : serialized);
}

/** Iterative JSON accounting avoids recursion on hostile nesting. */
export function measureJsonValue(value: unknown): JsonBounds {
  type Work = { readonly value: unknown; readonly depth: number };
  const work: Work[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = 0; let depth = 0; let nodes = 0;
  while (work.length > 0) {
    const current = work.pop()!; const item = current.value;
    nodes += 1; depth = Math.max(depth, current.depth);
    if (item === null || typeof item !== "object") { bytes += primitiveJsonBytes(item); continue; }
    if (seen.has(item)) throw new TypeError("Circular value is not JSON serializable");
    seen.add(item);
    if (Array.isArray(item)) {
      bytes += 2;
      for (let index = item.length - 1; index >= 0; index -= 1) {
        if (index < item.length - 1) bytes += 1;
        work.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(item as Record<string, unknown>);
    bytes += 2;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      if (index < entries.length - 1) bytes += 1;
      bytes += utf8ByteLength(JSON.stringify(key)) + 1;
      work.push({ value: child, depth: current.depth + 1 });
    }
  }
  return { bytes, depth, nodes };
}
export const measureJsonBounds = measureJsonValue;
/** Charge a finite amount even when validation rejects a hostile value. */
export function boundedJsonValueBytes(
  value: unknown,
  cap = AGENT_ARGUMENT_MAX_BYTES,
): number {
  try {
    return Math.min(cap, Math.max(1, measureJsonValue(value).bytes));
  } catch {
    return cap;
  }
}


function skipWhitespace(text: string, index: number): number { let cursor = index; while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1; return cursor; }
function consumeString(text: string, index: number): number { let cursor = index + 1; while (cursor < text.length) { const character = text[cursor]!; if (character === "\\") { cursor += 2; continue; } if (character === '"') return cursor + 1; cursor += 1; } return text.length + 1; }
function consumePrimitive(text: string, index: number): number { let cursor = index; while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor += 1; return cursor; }

/** Lexical JSON scan for size/depth/node limits before JSON.parse. */
export function measureJsonText(text: string): JsonBounds {
  const bytes = utf8ByteLength(text); let cursor = skipWhitespace(text, 0); let nodes = 0; let maxDepth = 0;
  const stack: Array<"object" | "array"> = []; let expectKey = false;
  while (cursor < text.length) {
    cursor = skipWhitespace(text, cursor); if (cursor >= text.length) break;
    const character = text[cursor]!;
    if (character === "{" || character === "[") { nodes += 1; stack.push(character === "{" ? "object" : "array"); maxDepth = Math.max(maxDepth, stack.length - 1); expectKey = stack.at(-1) === "object"; cursor += 1; continue; }
    if (character === "}" || character === "]") { stack.pop(); expectKey = stack.at(-1) === "object"; cursor += 1; continue; }
    if (character === '"') { const end = consumeString(text, cursor); if (expectKey) expectKey = false; else nodes += 1; cursor = end; continue; }
    if (character === ":" || character === ",") { expectKey = character === "," && stack.at(-1) === "object"; cursor += 1; continue; }
    nodes += 1; cursor = consumePrimitive(text, cursor);
  }
  return { bytes, depth: maxDepth, nodes };
}

function throwBoundsFailure(bounds: JsonBounds, options: JsonBoundsOptions, budget: AgentPublicBudgetId): void {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER; const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER; const maxNodes = options.maxNodes ?? Number.MAX_SAFE_INTEGER;
  if (bounds.bytes > maxBytes) throw new AgentAccountingFailure(budget === "argument_bytes" ? "argument_limit_exceeded" : "result_limit_exceeded", budget, maxBytes, bounds.bytes);
  if (bounds.depth > maxDepth) throw new AgentAccountingFailure(budget === "continuation_bytes" ? "continuation_limit_exceeded" : "argument_limit_exceeded", budget, maxDepth, bounds.depth);
  if (bounds.nodes > maxNodes) throw new AgentAccountingFailure(budget === "continuation_bytes" ? "continuation_limit_exceeded" : "argument_limit_exceeded", budget, maxNodes, bounds.nodes);
}
export function assertJsonValueBounds(value: unknown, options: JsonBoundsOptions = {}, budget: AgentPublicBudgetId = "argument_bytes"): JsonBounds { const bounds = measureJsonValue(value); throwBoundsFailure(bounds, options, budget); return bounds; }
export function assertJsonTextBounds(text: string, options: JsonBoundsOptions = {}, budget: AgentPublicBudgetId = "argument_bytes"): JsonBounds { const bounds = measureJsonText(text); throwBoundsFailure(bounds, options, budget); return bounds; }

export function validateProviderUsage(
  usage: unknown,
  allowance: number,
): ProviderUsageValidation {
  if (usage === undefined) return { valid: false, outputTokens: 0 };
  if (usage === null || typeof usage !== "object") {
    return { valid: false, outputTokens: 0, reason: "non_integer" };
  }
  const candidate = usage as Record<string, unknown>;
  const promptTokens = candidate.prompt_tokens;
  const completionTokens = candidate.completion_tokens;
  const totalTokens = candidate.total_tokens;
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    !Number.isFinite(totalTokens) ||
    !Number.isSafeInteger(promptTokens) ||
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(totalTokens)
  ) return { valid: false, outputTokens: 0, reason: "non_integer" };
  if (promptTokens < 0 || completionTokens < 0 || totalTokens < 0) {
    return { valid: false, outputTokens: 0, reason: "negative" };
  }
  if (
    promptTokens > Number.MAX_SAFE_INTEGER - completionTokens ||
    totalTokens < promptTokens + completionTokens
  ) return { valid: false, outputTokens: 0, reason: "contradictory" };
  if (completionTokens > allowance) return { valid: false, outputTokens: completionTokens, reason: "over_allowance" };
  return { valid: true, outputTokens: completionTokens };
}
function observedStrings(response: GenerationResponse): string[] {
  const values: string[] = []; if (typeof response.content === "string") values.push(response.content); if (typeof response.reasoning === "string") values.push(response.reasoning); if (response.tool_calls?.length) values.push(JSON.stringify(response.tool_calls)); if (response.thinking_blocks?.length) values.push(JSON.stringify(response.thinking_blocks)); if (response.reasoning_details?.length) values.push(JSON.stringify(response.reasoning_details)); return values;
}
export function observeOutputTokens(response: GenerationResponse, options: ObservedOutputOptions = {}): number {
  const tokenizer = options.countTokens; let observed = 0;
  for (const text of observedStrings(response)) { const count = tokenizer ? tokenizer(text) : utf8ByteLength(text); if (!Number.isSafeInteger(count) || count < 0) throw new AgentAccountingFailure("provider_protocol_error", "child_output_tokens", options.allowance ?? Number.MAX_SAFE_INTEGER, count); observed = Math.min(Number.MAX_SAFE_INTEGER, observed + count); }
  if (options.allowance !== undefined && observed > options.allowance) throw new AgentAccountingFailure("child_output_token_limit_exceeded", "child_output_tokens", options.allowance, observed);
  return observed;
}
/**
 * Inspect one complete provider response without discarding trustworthy
 * accounting evidence on a protocol or allowance failure. Callers settle the
 * returned token amount exactly once, then surface `failure`.
 */
export function evaluateOutputTokens(
  usage: unknown,
  response: GenerationResponse,
  allowance: number,
  options: SettleOutputOptions = {},
): OutputTokenSettlement {
  const precomputed = options.observedTokens;
  let observed = 0;
  let failure: AgentAccountingFailure | undefined;
  if (precomputed !== undefined) {
    if (typeof precomputed !== "number" || !Number.isFinite(precomputed) || !Number.isSafeInteger(precomputed) || precomputed < 0) {
      failure = new AgentAccountingFailure("provider_protocol_error", "child_output_tokens", allowance, precomputed);
    } else {
      observed = precomputed;
    }
  } else {
    try {
      observed = observeOutputTokens(response, { countTokens: options.countTokens });
    } catch (error) {
      if (!(error instanceof AgentAccountingFailure)) throw error;
      failure = error;
    }
  }

  const validated = validateProviderUsage(usage, allowance);
  const providerOutput =
    validated.valid || validated.reason === "over_allowance"
      ? validated.outputTokens
      : 0;
  const tokens = Math.max(observed, providerOutput);
  if (!failure && usage !== undefined && !validated.valid) {
    failure = new AgentAccountingFailure(
      validated.reason === "over_allowance"
        ? "child_output_token_limit_exceeded"
        : "provider_protocol_error",
      "child_output_tokens",
      allowance,
      validated.outputTokens,
    );
  }
  if (!failure && tokens > allowance) {
    failure = new AgentAccountingFailure(
      "child_output_token_limit_exceeded",
      "child_output_tokens",
      allowance,
      tokens,
    );
  }
  return {
    tokens,
    usage: validated,
    observed,
    ...(failure ? { failure } : {}),
  };
}

export function settleOutputTokens(
  usage: unknown,
  response: GenerationResponse,
  allowance: number,
  options: SettleOutputOptions = {},
): Omit<OutputTokenSettlement, "failure"> {
  const { failure, ...settlement } = evaluateOutputTokens(
    usage,
    response,
    allowance,
    options,
  );
  if (failure) throw failure;
  return settlement;
}

import type { LlmMessage } from "../../llm/types";
import { isChatHistoryMessage } from "../../llm/chat-history";
import { NanoGPTProvider } from "../../llm/providers/nanogpt";
import type { CachingContext, CachingInput, CachingOutput } from "./types";

const messageSerializer = new NanoGPTProvider();

// Matches NanoGPT-routed Claude IDs: `claude-…`, `anthropic/claude-…`, or
// any vendor-prefixed Anthropic route. Used to gate NanoGPT's explicit
// `prompt_caching` helper, which is Claude-only — sending it (or top-level
// `caching: true` / `stickyProvider`) for non-Claude models biases provider
// selection toward cache-capable upstreams and bypasses subscription
// coverage for routes like GLM 5.1 (see NanoGPT docs:
// provider-selection.md, prompt-caching.md). For non-Claude routes NanoGPT
// applies implicit caching server-side, so no flags are needed.
export function isNanoGptClaudeModel(model?: string | null): boolean {
  if (!model) return false;
  return /(?:^|\/)(?:anthropic\/)?claude[-_]/i.test(model);
}

// Conversation messages left outside the cached prefix by the automatic cut.
//
// A provider-selected breakpoint can include the volatile tail: depth-injected
// blocks with freshly evaluated macros, the newest turn, or history still
// being rewritten by depth-gated regexes. Keeping that tail outside the
// boundary improves the chance of reusing an unchanged prefix.
//
// Six is a heuristic margin for depth-gated prompt regexes. Presets with
// deeper rewrites or dynamic content earlier in the prompt need tuning.
const DEFAULT_TAIL_RESERVE_MESSAGES = 6;

// Leave NanoGPT's placement alone on short payloads. Provider token thresholds
// still determine whether the selected prefix is eligible for caching.
const MIN_CACHEABLE_PREFIX_MESSAGES = 8;

interface NanoGptCachingPayload {
  enabled: true;
  ttl: "5m" | "1h";
  stickyProvider: boolean;
  cutAfterMessageIndex?: number;
  explicitCacheControl?: boolean;
}

function readTailReserve(cacheSetting: Record<string, any>): number {
  const raw =
    cacheSetting.tailReserveMessages ?? cacheSetting.tail_reserve_messages;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return DEFAULT_TAIL_RESERVE_MESSAGES;
  }
  return raw;
}

/**
 * Suggest a cache boundary before the recent conversation tail.
 *
 * Walks back from the end of the assembled payload past the trailing run of
 * non-history blocks (post-history system instructions plus the
 * depth-injected `user` blocks that end the array) to the newest assistant
 * turn, ignoring assistant prefills. Tagged assembly history also excludes
 * injected assistant blocks and counts the reserve in actual history messages.
 * Raw API requests without provenance use a role-based fallback.
 *
 * Recomputed per request on purpose: the boundary tracks the end of the
 * conversation, so each turn reads the previous turn's prefix and writes
 * only the delta when the earlier prefix stays unchanged. Context trimming or
 * dynamic content earlier in the prompt can still invalidate that prefix.
 *
 * Returns undefined when there is nothing worth pinning, leaving NanoGPT's
 * own breakpoint placement untouched.
 */
export function computeAutoCutAfterMessageIndex(
  messages: LlmMessage[],
  tailReserveMessages: number = DEFAULT_TAIL_RESERVE_MESSAGES,
): number | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const hasTaggedHistory = messages.some(isChatHistoryMessage);
  let newestAssistant = messages.length - 1;
  while (newestAssistant >= 0 && (
    messages[newestAssistant].role !== "assistant" ||
    messages[newestAssistant].partial === true ||
    (hasTaggedHistory && !isChatHistoryMessage(messages[newestAssistant]))
  )) {
    newestAssistant--;
  }
  // No assistant turn yet (first generation, or a sidecar system+user prompt):
  // there is no settled history to protect.
  if (newestAssistant < 0) return undefined;

  // The newest assistant turn itself is still inside every depth window, so
  // the boundary starts one message before it.
  let reserve = Number.isSafeInteger(tailReserveMessages) && tailReserveMessages >= 0
    ? tailReserveMessages : DEFAULT_TAIL_RESERVE_MESSAGES;
  let cut = newestAssistant - 1;
  while (cut >= 0 && reserve > 0) {
    if (!hasTaggedHistory || isChatHistoryMessage(messages[cut])) reserve--;
    cut--;
  }
  if (reserve > 0 || cut < 0) return undefined;
  // Tool-result arrays can expand and empty content arrays can disappear.
  // Use the same serializer as dispatch so this is an index in the wire array.
  const prefixLength = messageSerializer.serializeMessages(messages.slice(0, cut + 1)).length;
  return prefixLength >= MIN_CACHEABLE_PREFIX_MESSAGES ? prefixLength - 1 : undefined;
}

/**
 * NanoGPT caching.
 *
 * Body shape decisions are driven by two signals from `nanogpt_caching`
 * metadata: the model family (Claude vs not) and the advanced
 * `forceCacheCapableRouting` opt-in.
 *
 * - Claude routes: emit the `prompt_caching` body helper (NanoGPT's
 *   explicit caching format). Forwards `enabled`, `ttl`, `stickyProvider`,
 *   `cutAfterMessageIndex`, `explicitCacheControl` when set in metadata.
 *   With no pinned `cutAfterMessageIndex`, derives one from the payload so
 *   the cached prefix stops short of the volatile tail.
 * - Any model with `forceCacheCapableRouting: true`: also emit top-level
 *   `caching: true`. This biases NanoGPT to route to a cache-capable
 *   upstream — useful when implicit caching isn't covering your route, but
 *   per NanoGPT docs it MAY bypass subscription coverage. Opt-in only.
 * - Non-Claude routes without force-routing: emit nothing. NanoGPT's
 *   implicit caching applies automatically on supported upstreams and the
 *   subscription router keeps the user on the included provider.
 */
export function applyNanoGptCaching(
  ctx: CachingContext,
  input: CachingInput,
): CachingOutput {
  const cacheSetting = ctx.metadata?.nanogpt_caching;
  if (
    !cacheSetting ||
    typeof cacheSetting !== "object" ||
    Array.isArray(cacheSetting) ||
    cacheSetting.enabled !== true
  ) {
    return input;
  }

  const isClaude = isNanoGptClaudeModel(ctx.model);
  const forceCacheCapableRouting =
    cacheSetting.forceCacheCapableRouting === true ||
    cacheSetting.force_cache_capable_routing === true;

  // Without Claude AND without force-routing, there's nothing to send —
  // NanoGPT's implicit caching handles supported routes automatically.
  if (!isClaude && !forceCacheCapableRouting) return input;

  const params = { ...input.params };

  if (forceCacheCapableRouting) {
    params.caching = true;
  }

  if (isClaude) {
    const payload: NanoGptCachingPayload = {
      enabled: true,
      ttl: cacheSetting.ttl === "1h" ? "1h" : "5m",
      stickyProvider: cacheSetting.stickyProvider !== false,
    };
    // Pass-through advanced fields when explicitly set. Accept both
    // camelCase and snake_case from metadata; emit canonical camelCase.
    const cutAfterRaw =
      cacheSetting.cutAfterMessageIndex ?? cacheSetting.cut_after_message_index;
    const autoCutDisabled = (cacheSetting.autoCut ?? cacheSetting.auto_cut) === false;
    if (typeof cutAfterRaw === "number" && Number.isInteger(cutAfterRaw) && cutAfterRaw >= 0) {
      // A pinned index is the user's explicit choice — never override it.
      payload.cutAfterMessageIndex = cutAfterRaw;
    } else if (!autoCutDisabled) {
      const autoCut = computeAutoCutAfterMessageIndex(
        input.messages,
        readTailReserve(cacheSetting),
      );
      if (autoCut !== undefined) payload.cutAfterMessageIndex = autoCut;
    }
    const explicitRaw =
      cacheSetting.explicitCacheControl ?? cacheSetting.explicit_cache_control;
    if (explicitRaw === true) {
      payload.explicitCacheControl = true;
    }
    params.prompt_caching = payload;
  }

  return { ...input, params };
}

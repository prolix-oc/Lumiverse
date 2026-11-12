import type { LlmMessage } from "../../llm/types";
import type { CachingContext, CachingInput, CachingOutput } from "./types";

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
// Without a cut index NanoGPT anchors its own breakpoint at the end of the
// prompt, so the stored prefix swallows the volatile tail — depth-injected
// blocks (which carry freshly evaluated `{{roll::…}}` style macros), the
// newest turn, and any history a rolling-depth prompt regex is still
// rewriting. The next request diverges inside that prefix and the whole
// prompt is re-written at the cache-write premium with zero reads.
//
// Six covers the deepest depth-gated prompt regex in common presets
// (internal-state cleaners at depth 3, GFX strippers at depth 5): past that
// a message's rendered text is settled and safe to cache.
const DEFAULT_TAIL_RESERVE_MESSAGES = 6;

// Below this many leading messages a pinned prefix is not worth the write
// premium — leave NanoGPT's own heuristic alone on short chats.
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
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_TAIL_RESERVE_MESSAGES;
  }
  return raw;
}

/**
 * Last message index that is safe to pin a cache boundary on.
 *
 * Walks back from the end of the wire payload past the trailing run of
 * non-history blocks (post-history system instructions plus the
 * depth-injected `user` blocks that end the array) to the newest assistant
 * turn, then reserves `tailReserveMessages` further messages so a
 * rolling-depth prompt regex cannot rewrite history inside the cached
 * prefix.
 *
 * Recomputed per request on purpose: the boundary tracks the end of the
 * conversation, so each turn reads the previous turn's prefix and writes
 * only the delta. That also keeps it correct when context trimming shifts
 * every index, which a number pinned in connection settings cannot.
 *
 * Returns undefined when there is nothing worth pinning, leaving NanoGPT's
 * own breakpoint placement untouched.
 */
export function computeAutoCutAfterMessageIndex(
  messages: LlmMessage[],
  tailReserveMessages: number = DEFAULT_TAIL_RESERVE_MESSAGES,
): number | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  let newestAssistant = messages.length - 1;
  while (newestAssistant >= 0 && messages[newestAssistant]?.role !== "assistant") {
    newestAssistant--;
  }
  // No assistant turn yet (first generation, or a sidecar system+user prompt):
  // there is no settled history to protect.
  if (newestAssistant < 0) return undefined;

  // The newest assistant turn itself is still inside every depth window, so
  // the boundary starts one message before it.
  const cut = newestAssistant - 1 - Math.max(0, Math.trunc(tailReserveMessages));
  if (cut < MIN_CACHEABLE_PREFIX_MESSAGES) return undefined;
  return cut;
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
    const autoCutDisabled =
      cacheSetting.autoCut === false || cacheSetting.auto_cut === false;
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

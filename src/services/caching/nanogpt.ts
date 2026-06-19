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

interface NanoGptCachingPayload {
  enabled: true;
  ttl: "5m" | "1h";
  stickyProvider: boolean;
  cutAfterMessageIndex?: number;
  explicitCacheControl?: boolean;
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
    if (typeof cutAfterRaw === "number" && Number.isInteger(cutAfterRaw) && cutAfterRaw >= 0) {
      payload.cutAfterMessageIndex = cutAfterRaw;
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

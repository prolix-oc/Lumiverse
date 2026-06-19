import { applyAnthropicCaching } from "./anthropic";
import { applyNanoGptCaching } from "./nanogpt";
import type {
  CachingContext,
  CachingInput,
  CachingOutput,
  CachingStrategy,
} from "./types";

// Strategy registry. Add new providers by registering their strategy here —
// no other call sites need to change.
const STRATEGIES: Record<string, CachingStrategy> = {
  anthropic: { apply: applyAnthropicCaching },
  nanogpt: { apply: applyNanoGptCaching },
};

/**
 * Apply provider-specific prompt caching to a pending request bundle.
 *
 * Returns a new bundle with any params/messages/tools transformations the
 * provider's caching strategy requires. Providers without a registered
 * strategy pass through unchanged. Callers should swap the returned values
 * into the request before sending.
 */
export function applyPromptCaching(
  ctx: CachingContext,
  input: CachingInput,
): CachingOutput {
  const strategy = STRATEGIES[ctx.provider];
  if (!strategy) return input;
  return strategy.apply(ctx, input);
}

export type { CachingContext, CachingInput, CachingOutput, CachingStrategy };

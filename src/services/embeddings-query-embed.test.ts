import { describe, expect, it } from "bun:test";
import { nextQueryEmbedLength } from "./embeddings.service";

// nextQueryEmbedLength drives embedQueryAdaptive's shrink-and-retry backoff:
// when a token-limited embedding backend rejects an over-budget query, we halve
// the query (keeping the recent tail) until it fits or we hit the floor. The
// key safety property is that every step strictly shrinks or stops — otherwise
// the retry loop would spin forever.
describe("nextQueryEmbedLength", () => {
  it("halves the length while comfortably above the floor", () => {
    expect(nextQueryEmbedLength(24000, 512)).toBe(12000);
    expect(nextQueryEmbedLength(12000, 512)).toBe(6000);
  });

  it("clamps the final step to the floor instead of dropping below it", () => {
    // floor(700/2) = 350 < 512, so it pins to the floor rather than undershoot.
    expect(nextQueryEmbedLength(700, 512)).toBe(512);
  });

  it("returns null at or below the floor so the caller gives up", () => {
    expect(nextQueryEmbedLength(512, 512)).toBeNull();
    expect(nextQueryEmbedLength(400, 512)).toBeNull();
  });

  it("always strictly decreases or stops — guarantees the retry loop terminates", () => {
    for (const minChars of [64, 512, 2048]) {
      let len = 50000;
      let steps = 0;
      for (;;) {
        const next = nextQueryEmbedLength(len, minChars);
        if (next === null) break;
        expect(next).toBeLessThan(len);
        expect(next).toBeGreaterThanOrEqual(minChars);
        len = next;
        expect(++steps).toBeLessThan(100); // can't loop unboundedly
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import { getConnectionRouletteConfig } from "./connections.service";

describe("getConnectionRouletteConfig", () => {
  test("normalizes roulette target ids", () => {
    expect(getConnectionRouletteConfig({
      metadata: {
        connection_roulette: {
          connection_ids: [" a ", "", "b", "a", 42, "c"],
        },
      },
    })).toEqual({ connection_ids: ["a", "b", "c"] });
  });

  test("falls back to an empty roulette config", () => {
    expect(getConnectionRouletteConfig({ metadata: {} })).toEqual({ connection_ids: [] });
  });
});

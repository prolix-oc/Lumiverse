import { describe, expect, test } from "bun:test";
import {
  ACTIVATION_PROVENANCE_FORBIDDEN_KEYS,
  mapPeerBookSourceToPersona,
  projectActivationProvenance,
  projectActivationTraceEntry,
} from "./activation-provenance";

function expectNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoForbiddenKeys(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    expect(ACTIVATION_PROVENANCE_FORBIDDEN_KEYS).not.toContain(key);
    expectNoForbiddenKeys(nested);
  }
}

describe("projectActivationProvenance", () => {
  test("preserves each canonical discriminator and strips unknown fields", () => {
    expect(projectActivationProvenance({ origin: "constant", raw: "x" })).toEqual({
      origin: "constant",
    });
    expect(projectActivationProvenance({ origin: "sticky", content: "secret" })).toEqual({
      origin: "sticky",
    });
    expect(projectActivationProvenance({ origin: "vector", vectorQuery: "secret" })).toEqual({
      origin: "vector",
    });
  });

  test("projects keyword provenance without exact evidence", () => {
    const projected = projectActivationProvenance({
      origin: "keyword",
      activationPass: 0,
      matchedPrimaryKeys: ["dragon", "castle"],
      matchedSecondaryKeys: ["king"],
      internalScore: 0.42,
    });

    expect(projected).toEqual({
      origin: "keyword",
      activationPass: 0,
      matchedPrimaryKeys: ["dragon", "castle"],
      matchedSecondaryKeys: ["king"],
    });
  });

  test("projects all exact-match source variants and strips nested unknown keys", () => {
    const message = projectActivationProvenance({
      origin: "keyword",
      activationPass: 2,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: {
          kind: "message",
          messageId: "message-7",
          messageOffset: 12,
          start: 4,
          end: 10,
          matchedText: "dragon in the message",
          content: "full message content",
        },
        regexCapture: "dragon",
      },
    });
    expect(message).toEqual({
      origin: "keyword",
      activationPass: 2,
      matchedPrimaryKeys: ["dragon"],
      matchedSecondaryKeys: [],
      exactMatch: {
        configuredPattern: "dragon",
        source: {
          kind: "message",
          messageId: "message-7",
          messageOffset: 12,
          start: 4,
          end: 10,
        },
      },
    });

    expect(
      projectActivationProvenance({
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: ["secondary"],
        exactMatch: {
          configuredPattern: "entry-key",
          source: {
            kind: "recursive_entry",
            entryId: "entry-4",
            start: 0,
            end: 8,
            sentence: "secret surrounding sentence",
          },
        },
      }),
    ).toEqual({
      origin: "keyword",
      activationPass: 1,
      matchedPrimaryKeys: [],
      matchedSecondaryKeys: ["secondary"],
      exactMatch: {
        configuredPattern: "entry-key",
        source: { kind: "recursive_entry", entryId: "entry-4", start: 0, end: 8 },
      },
    });

    expect(
      projectActivationProvenance({
        origin: "keyword",
        activationPass: 3,
        matchedPrimaryKeys: ["a"],
        matchedSecondaryKeys: ["b"],
        exactMatch: {
          configuredPattern: "configured-regex-source",
          source: { kind: "mixed_or_unavailable", query: "vector query" },
        },
      }),
    ).toEqual({
      origin: "keyword",
      activationPass: 3,
      matchedPrimaryKeys: ["a"],
      matchedSecondaryKeys: ["b"],
      exactMatch: {
        configuredPattern: "configured-regex-source",
        source: { kind: "mixed_or_unavailable" },
      },
    });
  });

  test("deeply clones arrays and nested locator objects", () => {
    const matchedPrimaryKeys = ["first"];
    const source = {
      kind: "message" as const,
      messageId: "message-1",
      messageOffset: 5,
      start: 2,
      end: 7,
    };
    const input = {
      origin: "keyword" as const,
      activationPass: 1,
      matchedPrimaryKeys,
      matchedSecondaryKeys: ["second"],
      exactMatch: { configuredPattern: "first", source },
    };

    const projected = projectActivationProvenance(input);
    expect(projected).toBeDefined();
    expect(projected).not.toBe(input);
    expect(projected?.origin).toBe("keyword");
    expect(projected && "exactMatch" in projected ? projected.exactMatch : undefined).not.toBe(
      input.exactMatch,
    );

    matchedPrimaryKeys[0] = "changed";
    source.messageId = "changed";
    expect(projected).toEqual({
      origin: "keyword",
      activationPass: 1,
      matchedPrimaryKeys: ["first"],
      matchedSecondaryKeys: ["second"],
      exactMatch: {
        configuredPattern: "first",
        source: {
          kind: "message",
          messageId: "message-1",
          messageOffset: 5,
          start: 2,
          end: 7,
        },
      },
    });
  });

  test("returns undefined for invalid discriminators, fields, numbers, and ranges", () => {
    const invalidValues: unknown[] = [
      null,
      [],
      { origin: "recursive" },
      { origin: "keyword" },
      {
        origin: "keyword",
        activationPass: Number.NaN,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
      },
      {
        origin: "keyword",
        activationPass: Number.POSITIVE_INFINITY,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
      },
      {
        origin: "keyword",
        activationPass: -1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
      },
      {
        origin: "keyword",
        activationPass: 1.5,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: ["ok", 2],
        matchedSecondaryKeys: [],
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        exactMatch: null,
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        exactMatch: {
          configuredPattern: "key",
          source: { kind: "unknown" },
        },
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        exactMatch: {
          configuredPattern: "key",
          source: {
            kind: "message",
            messageId: "message-1",
            messageOffset: -1,
            start: 0,
            end: 1,
          },
        },
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        exactMatch: {
          configuredPattern: "key",
          source: {
            kind: "message",
            messageId: "message-1",
            messageOffset: 0,
            start: 4,
            end: 2,
          },
        },
      },
      {
        origin: "keyword",
        activationPass: 1,
        matchedPrimaryKeys: [],
        matchedSecondaryKeys: [],
        exactMatch: {
          configuredPattern: "key",
          source: {
            kind: "recursive_entry",
            entryId: "entry-1",
            start: 0.5,
            end: 2,
          },
        },
      },
    ];

    for (const value of invalidValues) {
      expect(projectActivationProvenance(value)).toBeUndefined();
    }
  });

  test("projects trace rows only when both id and provenance are valid", () => {
    const row = projectActivationTraceEntry({
      id: "entry-1",
      provenance: { origin: "vector", vectorQuery: "secret query" },
      internal: { content: "secret" },
    });
    expect(row).toEqual({ id: "entry-1", provenance: { origin: "vector" } });
    expect(projectActivationTraceEntry({ id: 7, provenance: { origin: "constant" } })).toBeUndefined();
    expect(projectActivationTraceEntry({ id: "entry-1", provenance: { origin: "invalid" } })).toBeUndefined();
  });

  test("never emits corpus, context, regex-capture, or vector-query fields", () => {
    const variants: unknown[] = [
      { origin: "constant", content: "entry content" },
      { origin: "sticky", sentence: "surrounding sentence" },
      { origin: "vector", query: "vector query" },
      {
        origin: "keyword",
        activationPass: 0,
        matchedPrimaryKeys: ["key"],
        matchedSecondaryKeys: [],
        match: "regex capture",
        captures: ["regex capture"],
        exactMatch: {
          configuredPattern: "configured-pattern",
          source: {
            kind: "message",
            messageId: "message-1",
            messageOffset: 0,
            start: 0,
            end: 1,
            messageContent: "message content",
            entryContent: "entry content",
            vectorQuery: "vector query",
          },
        },
      },
    ];

    for (const variant of variants) {
      const projected = projectActivationProvenance(variant);
      expect(projected).toBeDefined();
      expectNoForbiddenKeys(projected);
      expect(JSON.stringify(projected)).not.toContain("regex capture");
      expect(JSON.stringify(projected)).not.toContain("vector query");
      expect(JSON.stringify(projected)).not.toContain("message content");
      expect(JSON.stringify(projected)).not.toContain("entry content");
    }
  });
});

describe("mapPeerBookSourceToPersona", () => {
  test("maps peer and preserves the published source values", () => {
    expect(mapPeerBookSourceToPersona("peer")).toBe("persona");
    expect(mapPeerBookSourceToPersona("character")).toBe("character");
    expect(mapPeerBookSourceToPersona("persona")).toBe("persona");
    expect(mapPeerBookSourceToPersona("chat")).toBe("chat");
    expect(mapPeerBookSourceToPersona("global")).toBe("global");
    expect(mapPeerBookSourceToPersona("other")).toBeUndefined();
  });
});

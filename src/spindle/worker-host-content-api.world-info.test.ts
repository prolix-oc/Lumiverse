import { describe, expect, test } from "bun:test";
import {
  canExtensionMutateRegexScript,
  getEntityExtensionPermission,
  prepareSpindleRegexMutation,
  projectActivatedWorldInfoEntryForRpc,
  WorkerHostContentApi,
} from "./worker-host-content-api";

describe("worker regex-script mutation projection", () => {
  test("exposes mutation capability only for the caller's non-preset scripts", () => {
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.a",
      preset_id: null,
    }, "extension.a")).toBe(true);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: null,
      preset_id: null,
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.b",
      preset_id: null,
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.a",
      preset_id: "preset-1",
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.b",
      preset_id: "preset-1",
    }, "extension.a", true)).toBe(true);
  });

  test("separates the optional folder version from the persisted script input", () => {
    expect(prepareSpindleRegexMutation({
      name: "Versioned script",
      folder: "Extension scripts",
      folder_version: "2.4.0",
    }, "extension.a")).toEqual({
      input: { name: "Versioned script", folder: "Extension scripts" },
      context: { extensionIdentifier: "extension.a", extensionFolderVersion: "2.4.0" },
    });
    expect(prepareSpindleRegexMutation({ name: "Unversioned script" }, "extension.a")).toEqual({
      input: { name: "Unversioned script" },
      context: { extensionIdentifier: "extension.a" },
    });
    expect(prepareSpindleRegexMutation({ name: "Editable script" }, "extension.a", true)).toEqual({
      input: { name: "Editable script" },
      context: { extensionIdentifier: "extension.a", allowUnownedMutation: true },
    });
  });
});

const baseEntry = {
  id: "entry-1",
  comment: "safe label",
  keys: ["alpha"],
  source: "keyword" as const,
  score: 0.8,
  bookId: "book-1",
};

describe("worker activated world-info projection", () => {
  test("projects every H13 provenance origin and maps peer books to persona", () => {
    const origins = ["constant", "sticky", "vector"] as const;
    for (const origin of origins) {
      expect(projectActivatedWorldInfoEntryForRpc({ ...baseEntry, bookSource: "peer", activationProvenance: { origin } }))
        .toMatchObject({ bookSource: "persona", activationProvenance: { origin } });
    }

    expect(projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      activationProvenance: {
        origin: "keyword",
        activationPass: 2,
        matchedPrimaryKeys: ["alpha"],
        matchedSecondaryKeys: ["alias"],
        exactMatch: {
          configuredPattern: "alpha",
          source: { kind: "message", messageId: "msg-1", messageOffset: 3, start: 10, end: 15 },
        },
      },
    })).toMatchObject({ activationProvenance: { origin: "keyword", activationPass: 2 } });
  });

  test("preserves the optional first-trigger flag without widening the RPC allowlist", () => {
    expect(projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      firstTriggeredForBook: true,
    })).toMatchObject({ firstTriggeredForBook: true });
    expect(projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      firstTriggeredForBook: false,
    })).toMatchObject({ firstTriggeredForBook: false });
    expect(projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      firstTriggeredForBook: "true",
      unexpected: "must not cross",
    } as typeof baseEntry & { firstTriggeredForBook: unknown; unexpected: string })).toEqual(baseEntry);
  });

  test("deeply strips content-like and unknown fields", () => {
    const result = projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      activationProvenance: {
        origin: "keyword",
        activationPass: 0,
        matchedPrimaryKeys: ["alpha"],
        matchedSecondaryKeys: [],
        content: "must not cross",
        exactMatch: {
          configuredPattern: "alpha",
          source: {
            kind: "recursive_entry",
            entryId: "entry-1",
            start: 0,
            end: 2,
            content: "must not cross",
            unexpected: true,
          },
          extra: true,
        },
        unexpected: true,
      },
    });

    expect(result).toEqual({
      id: "entry-1",
      comment: "safe label",
      keys: ["alpha"],
      source: "keyword",
      score: 0.8,
      bookId: "book-1",
      activationProvenance: {
        origin: "keyword",
        activationPass: 0,
        matchedPrimaryKeys: ["alpha"],
        matchedSecondaryKeys: [],
        exactMatch: {
          configuredPattern: "alpha",
          source: { kind: "recursive_entry", entryId: "entry-1", start: 0, end: 2 },
        },
      },
    });
  });

  test("omits malformed provenance and unsupported book sources", () => {
    const result = projectActivatedWorldInfoEntryForRpc({
      ...baseEntry,
      bookSource: "unknown",
      activationProvenance: { origin: "keyword", activationPass: -1, matchedPrimaryKeys: [], matchedSecondaryKeys: [] },
    });
    expect(result).toEqual(baseEntry);
  });
});

describe("worker entity-extension RPC permissions", () => {
  test("maps every H12 entity kind to its owner-scoped content permission", () => {
    expect(getEntityExtensionPermission("world_book_entry")).toBe("world_books");
    expect(getEntityExtensionPermission("character")).toBe("characters");
    expect(getEntityExtensionPermission("preset")).toBe("presets");
    expect(() => getEntityExtensionPermission("unknown")).toThrow("Unsupported extension entity");
  });

  test("routes all entity kinds through the owner-scoped namespace primitive", () => {
    const calls: Array<[string, string, string, string, unknown]> = [];
    const responses: Array<{ type: "response"; requestId: string; result?: unknown; error?: string }> = [];
    const scopedUsers: string[] = [];
    const api = new WorkerHostContentApi({
      manifest: { identifier: "h12-test" },
      hasPermission: () => true,
      resolveEffectiveUserId: () => "owner-1",
      enforceScopedUser: (userId) => scopedUsers.push(userId ?? ""),
      setEntityExtensionNamespace: (userId, entity, entityId, namespace, value) => {
        calls.push([userId, entity, entityId, namespace, value]);
        return { entity, id: entityId, namespace, value, extensions: { [namespace]: value } };
      },
      postResponse: (message) => responses.push(message),
    });

    for (const entity of ["world_book_entry", "character", "preset"] as const) {
      api.handleEntityExtensionSet(`request-${entity}`, entity, `${entity}-1`, "extension_ns", { entity });
    }

    expect(calls).toEqual([
      ["owner-1", "world_book_entry", "world_book_entry-1", "extension_ns", { entity: "world_book_entry" }],
      ["owner-1", "character", "character-1", "extension_ns", { entity: "character" }],
      ["owner-1", "preset", "preset-1", "extension_ns", { entity: "preset" }],
    ]);
    expect(scopedUsers).toEqual(["owner-1", "owner-1", "owner-1"]);
    expect(responses).toHaveLength(3);
    expect(responses.every((response) => response.error === undefined)).toBe(true);
  });
});

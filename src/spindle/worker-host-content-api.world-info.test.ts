import { describe, expect, spyOn, test } from "bun:test";
import * as regexScriptsSvc from "../services/regex-scripts.service";
import {
  canExtensionMutateRegexScript,
  getEntityExtensionPermission,
  prepareSpindleRegexMutation,
  projectActivatedWorldInfoEntryForRpc,
  WorkerHostContentApi,
} from "./worker-host-content-api";

describe("worker regex-script mutation projection", () => {
  test("exposes mutation capability for the caller's own scripts, preset-bound or not", () => {
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.a",
      preset_id: null,
    }, "extension.a")).toBe(true);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.a",
      preset_id: "preset-1",
    }, "extension.a")).toBe(true);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: null,
      preset_id: null,
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: null,
      preset_id: "preset-1",
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.b",
      preset_id: null,
    }, "extension.a")).toBe(false);
    expect(canExtensionMutateRegexScript({
      owner_extension_identifier: "extension.b",
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

describe("worker regex-script RPC preset links", () => {
  const extensionOwnedRow = {
    id: "script-1",
    name: "Imported display rule",
    script_id: "display_rule",
    find_regex: "x",
    replace_string: "y",
    actions: [],
    flags: "gi",
    placement: ["ai_output"],
    scope: "global",
    scope_id: null,
    target: ["display"],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: "none",
    disabled: false,
    sort_order: 0,
    description: "",
    folder: "",
    pack_id: null,
    preset_id: "preset-1",
    character_id: null,
    owner_extension_identifier: "realm.test",
    metadata: {},
    created_at: 1,
    updated_at: 1,
  };

  const invoke = (
    call: (api: WorkerHostContentApi) => void,
    permissions: string[] = ["regex_scripts"],
  ): Promise<{ type: "response"; requestId: string; result?: any; error?: string }> => new Promise((resolve) => {
    const api = new WorkerHostContentApi({
      manifest: { identifier: "realm.test" },
      hasPermission: (permission) => permissions.includes(permission),
      resolveEffectiveUserId: () => "owner-1",
      enforceScopedUser: () => {},
      postResponse: resolve,
    });
    call(api);
  });

  test("forwards an extension-supplied preset_id to creation and projects the row as mutable", async () => {
    const create = spyOn(regexScriptsSvc, "createRegexScript").mockReturnValue(extensionOwnedRow as any);
    try {
      const response = await invoke((api) => api.handleRegexScriptsCreate("create-1", {
        name: "Imported display rule",
        find_regex: "x",
        target: ["display"],
        preset_id: "preset-1",
        folder_version: "2.4.0",
      }));

      expect(response.error).toBeUndefined();
      expect(create).toHaveBeenCalledTimes(1);
      const [userId, input, context] = create.mock.calls[0]!;
      expect(userId).toBe("owner-1");
      expect(input).toMatchObject({ preset_id: "preset-1" });
      expect(input).not.toHaveProperty("folder_version");
      expect(context).toEqual({ extensionIdentifier: "realm.test", extensionFolderVersion: "2.4.0" });
      expect(response.result).toMatchObject({ id: "script-1", can_mutate: true, preset_id: "preset-1" });
    } finally {
      create.mockRestore();
    }
  });

  test("surfaces a rejected preset link as an error instead of a created row", async () => {
    const create = spyOn(regexScriptsSvc, "createRegexScript").mockReturnValue("Linked preset not found");
    try {
      const response = await invoke((api) => api.handleRegexScriptsCreate("create-2", {
        name: "Imported display rule",
        find_regex: "x",
        preset_id: "preset-foreign",
      }));

      expect(response.error).toBe("Linked preset not found");
      expect(response.result).toBeUndefined();
    } finally {
      create.mockRestore();
    }
  });

  test("projects the preset link on list, get, getActive, and update responses", async () => {
    const unboundRow = { ...extensionOwnedRow, id: "script-2", preset_id: null };
    const list = spyOn(regexScriptsSvc, "listRegexScripts")
      .mockReturnValue({ data: [extensionOwnedRow, unboundRow], total: 2 } as any);
    const get = spyOn(regexScriptsSvc, "getRegexScript").mockReturnValue(extensionOwnedRow as any);
    const update = spyOn(regexScriptsSvc, "updateRegexScript").mockReturnValue(extensionOwnedRow as any);
    const active = spyOn(regexScriptsSvc, "getActiveScripts").mockReturnValue([unboundRow] as any);
    try {
      const listed = await invoke((api) => api.handleRegexScriptsList("list-1"));
      expect(listed.error).toBeUndefined();
      expect(listed.result.data).toMatchObject([
        { id: "script-1", preset_id: "preset-1", can_mutate: true },
        { id: "script-2", preset_id: null, can_mutate: true },
      ]);

      const got = await invoke((api) => api.handleRegexScriptsGet("get-1", "script-1"));
      expect(got.result).toMatchObject({ id: "script-1", preset_id: "preset-1" });

      const updated = await invoke(
        (api) => api.handleRegexScriptsUpdate("update-1", "script-1", { name: "Renamed" }),
      );
      expect(updated.result).toMatchObject({ id: "script-1", preset_id: "preset-1" });

      const activeList = await invoke((api) => api.handleRegexScriptsGetActive("active-1", "display"));
      expect(activeList.result).toMatchObject([{ id: "script-2", preset_id: null }]);
    } finally {
      list.mockRestore();
      get.mockRestore();
      update.mockRestore();
      active.mockRestore();
    }
  });

  test("only passes allowUnownedMutation for unrestricted regex editors", async () => {
    const remove = spyOn(regexScriptsSvc, "deleteRegexScript").mockReturnValue(true);
    try {
      await invoke((api) => api.handleRegexScriptsDelete("delete-1", "script-1"));
      expect(remove.mock.calls[0]?.[2]).toEqual({
        extensionIdentifier: "realm.test",
        allowUnownedMutation: false,
      });

      await invoke(
        (api) => api.handleRegexScriptsDelete("delete-2", "script-1"),
        ["regex_scripts", "regex_scripts_unrestricted"],
      );
      expect(remove.mock.calls[1]?.[2]).toEqual({
        extensionIdentifier: "realm.test",
        allowUnownedMutation: true,
      });
    } finally {
      remove.mockRestore();
    }
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

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type { MacroEnv } from "../macros/types";
import {
  activatePresetBoundRegexScripts,
  applyRegexScripts,
  createRegexScript,
  deleteRegexScript,
  deleteRegexScripts,
  exportRegexScripts,
  getCharacterBoundScripts,
  getRegexScript,
  getRegexScriptByScriptId,
  getRegexScriptsByPresetId,
  getSpindleExtensionRegexFolderVersion,
  importRegexScripts,
  importCharacterBoundRegexScripts,
  installLumiHubPresetRegexScripts,
  importPresetBoundRegexScripts,
  resolveLumiHubPresetRegexInstallFolder,
  retireLumiHubPresetRegexScriptsForUpdate,
  reorderRegexScripts,
  reportRegexScriptPerformance,
  switchPresetBoundRegexScripts,
  toggleRegexScript,
  toggleRegexScriptsByIds,
  toggleRegexScriptsByFolder,
  updateRegexScript,
} from "./regex-scripts.service";
import { initMacros } from "../macros";
import type { RegexScript } from "../types/regex-script";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const USER_ID = "u1";

function mustGetScript(id: string) {
  const script = getRegexScript(USER_ID, id);
  expect(script).not.toBeNull();
  return script!;
}

function runtimeScript(overrides: Partial<RegexScript>): RegexScript {
  return {
    id: "runtime-script",
    user_id: USER_ID,
    name: "Runtime script",
    script_id: "runtime_script",
    find_regex: "x",
    replace_string: "y",
    actions: [],
    flags: "g",
    placement: ["ai_output"],
    scope: "global",
    scope_id: null,
    target: ["display"],
    min_depth: null,
    max_depth: null,
    substitute_macros: "none",
    trim_strings: [],
    run_on_edit: false,
    disabled: false,
    sort_order: 0,
    description: "",
    folder: "",
    pack_id: null,
    preset_id: null,
    character_id: null,
    owner_extension_identifier: null,
    validation_error_code: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}
beforeAll(() => {
  initMacros();
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);

  db.run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    script_id TEXT NOT NULL DEFAULT '',
    find_regex TEXT NOT NULL,
    replace_string TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT 'gi',
    placement TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_id TEXT,
    target TEXT NOT NULL,
    min_depth INTEGER,
    max_depth INTEGER,
    trim_strings TEXT NOT NULL,
    run_on_edit INTEGER NOT NULL DEFAULT 0,
    substitute_macros TEXT NOT NULL DEFAULT 'none',
    disabled INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    pack_id TEXT,
    preset_id TEXT,
    character_id TEXT,
    validation_error_code TEXT,
    owner_extension_identifier TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT 'classic',
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    prompts TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    cache_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE UNIQUE INDEX idx_regex_scripts_script_id
    ON regex_scripts(user_id, script_id)
    WHERE script_id != ''`);
});

beforeEach(() => {
  const db = getDb();
  db.query("DELETE FROM regex_scripts").run();
  db.query("DELETE FROM settings").run();
  db.query("DELETE FROM presets").run();
});

function insertAuthorityPreset(id: string): void {
  getDb().query(
    "INSERT INTO presets (id, user_id, cache_revision, prompt_order, updated_at) VALUES (?, ?, 0, '[]', 0)",
  ).run(id, USER_ID);
}

function authorityRevision(id: string): number {
  const row = getDb().query(
    "SELECT cache_revision FROM presets WHERE id = ? AND user_id = ?",
  ).get(id, USER_ID) as { cache_revision?: number } | null;
  return Number(row?.cache_revision ?? -1);
}

describe("preset-bound regex authority", () => {
  test("advances each direct operation once while unbound and normalized no-ops stay inert", () => {
    insertAuthorityPreset("preset-authority");
    const first = createRegexScript(USER_ID, {
      name: "First",
      find_regex: "first",
      preset_id: "preset-authority",
      sort_order: 1,
      metadata: { nested: { alpha: 1, beta: 2 } },
    }) as RegexScript;
    expect(authorityRevision("preset-authority")).toBe(1);

    updateRegexScript(USER_ID, first.id, {
      metadata: { nested: { beta: 2, alpha: 1 } },
    });
    expect(authorityRevision("preset-authority")).toBe(1);

    updateRegexScript(USER_ID, first.id, { find_regex: "changed" });
    expect(authorityRevision("preset-authority")).toBe(2);

    const second = createRegexScript(USER_ID, {
      name: "Second",
      find_regex: "second",
      preset_id: "preset-authority",
      sort_order: 0,
    }) as RegexScript;
    expect(authorityRevision("preset-authority")).toBe(3);

    reorderRegexScripts(USER_ID, [first.id, second.id]);
    expect(authorityRevision("preset-authority")).toBe(4);

    expect(deleteRegexScripts(USER_ID, [first.id, second.id])).toHaveLength(2);
    expect(authorityRevision("preset-authority")).toBe(5);

    const imported = importRegexScripts(USER_ID, {
      preset_id: "preset-authority",
      scripts: [
        { name: "Imported A", script_id: "import-a", find_regex: "a" },
        { name: "Imported B", script_id: "import-b", find_regex: "b" },
      ],
    });
    expect(imported.imported).toBe(2);
    expect(imported.presetAuthorityChanged).toBe(true);
    expect(authorityRevision("preset-authority")).toBe(6);

    const importedA = getRegexScriptByScriptId(USER_ID, "import-a")!;
    expect(deleteRegexScript(USER_ID, importedA.id)).toBe(true);
    expect(authorityRevision("preset-authority")).toBe(7);

    insertAuthorityPreset("preset-moved");
    const importedB = getRegexScriptByScriptId(USER_ID, "import-b")!;
    updateRegexScript(USER_ID, importedB.id, { preset_id: "preset-moved" });
    expect(authorityRevision("preset-authority")).toBe(8);
    expect(authorityRevision("preset-moved")).toBe(1);

    const unbound = createRegexScript(USER_ID, { name: "Unbound", find_regex: "x" }) as RegexScript;
    updateRegexScript(USER_ID, unbound.id, { find_regex: "y" });
    deleteRegexScript(USER_ID, unbound.id);
    expect(authorityRevision("preset-authority")).toBe(8);
  });
});

describe("extension regex ownership", () => {
  test("attributes an explicitly versioned Spindle folder without affecting unversioned scripts", () => {
    const versioned = createRegexScript(USER_ID, {
      name: "Versioned",
      find_regex: "versioned",
      folder: "Extension scripts",
      metadata: { author_note: "preserved", _lumiverse_spindle_extension: { identifier: "spoof", version: "9" } },
    }, { extensionIdentifier: "extension.a", extensionFolderVersion: "2.4.0" }) as RegexScript;
    const unversioned = createRegexScript(USER_ID, {
      name: "Unversioned",
      find_regex: "unversioned",
      folder: "Extension scripts",
    }, { extensionIdentifier: "extension.a" }) as RegexScript;
    const unfiled = createRegexScript(USER_ID, {
      name: "Unfiled",
      find_regex: "unfiled",
    }, { extensionIdentifier: "extension.a", extensionFolderVersion: "2.4.0" }) as RegexScript;

    expect(versioned.metadata).toEqual({
      author_note: "preserved",
      _lumiverse_spindle_extension: { identifier: "extension.a", version: "2.4.0" },
    });
    expect(getSpindleExtensionRegexFolderVersion(versioned)).toBe("2.4.0");
    expect(getSpindleExtensionRegexFolderVersion(unversioned)).toBeNull();
    expect(getSpindleExtensionRegexFolderVersion(unfiled)).toBeNull();
  });

  test("preserves, replaces, and clears protected Spindle folder attribution on update", () => {
    const created = createRegexScript(USER_ID, {
      name: "Versioned",
      find_regex: "versioned",
      folder: "Extension scripts",
    }, { extensionIdentifier: "extension.a", extensionFolderVersion: "1.0.0" }) as RegexScript;

    const preserved = updateRegexScript(USER_ID, created.id, {
      metadata: { extension_value: true },
    }, { extensionIdentifier: "extension.a" }) as RegexScript;
    expect(preserved.metadata).toEqual({
      extension_value: true,
      _lumiverse_spindle_extension: { identifier: "extension.a", version: "1.0.0" },
    });

    const replaced = updateRegexScript(USER_ID, created.id, {}, {
      extensionIdentifier: "extension.a",
      extensionFolderVersion: "2.0.0",
    }) as RegexScript;
    expect(getSpindleExtensionRegexFolderVersion(replaced)).toBe("2.0.0");

    const cleared = updateRegexScript(USER_ID, created.id, {}, {
      extensionIdentifier: "extension.a",
      extensionFolderVersion: null,
    }) as RegexScript;
    expect(getSpindleExtensionRegexFolderVersion(cleared)).toBeNull();
    expect(cleared.metadata._lumiverse_spindle_extension).toBeUndefined();
  });

  test("rejects invalid Spindle folder-version values", () => {
    expect(createRegexScript(USER_ID, {
      name: "Invalid version",
      find_regex: "invalid",
      folder: "Extension scripts",
    }, { extensionIdentifier: "extension.a", extensionFolderVersion: 2 })).toBe(
      "folder_version must be a string or null",
    );
    expect(createRegexScript(USER_ID, {
      name: "Long version",
      find_regex: "long",
      folder: "Extension scripts",
    }, { extensionIdentifier: "extension.a", extensionFolderVersion: "v".repeat(101) })).toBe(
      "folder_version exceeds maximum length (100 characters)",
    );
  });

  test("stamps extension-created scripts and strips host-owned bindings", () => {
    const created = createRegexScript(USER_ID, {
      name: "Owned",
      find_regex: "owned",
      preset_id: "attempted-preset",
      pack_id: "attempted-pack",
      character_id: "attempted-character",
    }, { extensionIdentifier: "extension.a" });

    expect(typeof created).not.toBe("string");
    const script = created as RegexScript;
    expect(script.owner_extension_identifier).toBe("extension.a");
    expect(script.preset_id).toBeNull();
    expect(script.pack_id).toBeNull();
    expect(script.character_id).toBeNull();

    const updated = updateRegexScript(USER_ID, script.id, { name: "Updated" }, {
      extensionIdentifier: "extension.a",
    });
    expect(typeof updated).not.toBe("string");
    expect((updated as RegexScript).name).toBe("Updated");
  });

  test("treats unattributed, foreign, and preset-bound scripts as read-only without disabling them", async () => {
    const legacy = createRegexScript(USER_ID, { name: "Legacy", find_regex: "legacy" }) as RegexScript;
    const foreign = createRegexScript(USER_ID, { name: "Foreign", find_regex: "foreign" }, {
      extensionIdentifier: "extension.b",
    }) as RegexScript;
    const bound = createRegexScript(USER_ID, { name: "Bound", find_regex: "bound" }, {
      extensionIdentifier: "extension.a",
    }) as RegexScript;
    updateRegexScript(USER_ID, bound.id, { preset_id: "preset-1" });

    for (const script of [legacy, foreign, bound]) {
      expect(updateRegexScript(USER_ID, script.id, { name: "Hijacked" }, {
        extensionIdentifier: "extension.a",
      })).toBe("Regex script is not an unbound script owned by this extension");
      expect(deleteRegexScript(USER_ID, script.id, {
        extensionIdentifier: "extension.a",
      })).toBe("Regex script is not an unbound script owned by this extension");
      expect(getRegexScript(USER_ID, script.id)).not.toBeNull();
    }

    expect(await applyRegexScripts(
      "legacy",
      [mustGetScript(legacy.id)],
      "ai_output",
    )).toBe("");
  });

  test("allows explicitly-authorized editors to mutate protected scripts without taking ownership", () => {
    const legacy = createRegexScript(USER_ID, { name: "Legacy", find_regex: "legacy" }) as RegexScript;
    const foreign = createRegexScript(USER_ID, {
      name: "Foreign",
      find_regex: "foreign",
      folder: "Foreign extension",
    }, {
      extensionIdentifier: "extension.b",
      extensionFolderVersion: "2.4.0",
    }) as RegexScript;
    const bound = createRegexScript(USER_ID, { name: "Bound", find_regex: "bound" }) as RegexScript;
    updateRegexScript(USER_ID, bound.id, { preset_id: "preset-1" });

    const context = { extensionIdentifier: "editor.extension", allowUnownedMutation: true };
    const updatedLegacy = updateRegexScript(USER_ID, legacy.id, { name: "Edited legacy" }, context) as RegexScript;
    expect(updatedLegacy.name).toBe("Edited legacy");
    expect(updatedLegacy.owner_extension_identifier).toBeNull();

    const updatedForeign = updateRegexScript(USER_ID, foreign.id, {
      name: "Edited foreign",
      metadata: { editor_note: "preserved" },
    }, context) as RegexScript;
    expect(updatedForeign.owner_extension_identifier).toBe("extension.b");
    expect(updatedForeign.metadata.editor_note).toBe("preserved");
    expect(getSpindleExtensionRegexFolderVersion(updatedForeign)).toBe("2.4.0");

    expect((updateRegexScript(USER_ID, bound.id, { name: "Edited bound" }, context) as RegexScript).name)
      .toBe("Edited bound");
    expect(deleteRegexScript(USER_ID, foreign.id, context)).toBe(true);
    expect(getRegexScript(USER_ID, foreign.id)).toBeNull();
  });
});

describe("regex export", () => {
  test("can bind and unbind an existing regex script to a preset", () => {
    const created = createRegexScript(USER_ID, {
      name: "Bindable",
      find_regex: "one",
      disabled: false,
    });

    expect(typeof created).not.toBe("string");
    const id = (created as Exclude<typeof created, string>).id;

    const bound = updateRegexScript(USER_ID, id, { preset_id: "preset-1" }, { activePresetId: "preset-1" });
    expect(typeof bound).not.toBe("string");
    expect(bound && typeof bound !== "string" ? bound.preset_id : null).toBe("preset-1");

    const out = exportRegexScripts(USER_ID, { presetId: "preset-1" });
    expect(out.scripts.map((s) => s.name)).toEqual(["Bindable"]);
    expect(out.scripts[0].disabled).toBe(false);

    const unbound = updateRegexScript(USER_ID, id, { preset_id: null }, { activePresetId: "preset-1" });
    expect(unbound && typeof unbound !== "string" ? unbound.preset_id : "missing").toBeNull();
    expect(exportRegexScripts(USER_ID, { presetId: "preset-1" }).scripts).toHaveLength(0);
  });

  test("can export only scripts bound to a preset without ownership ids", () => {
    createRegexScript(USER_ID, {
      name: "Preset Script",
      find_regex: "one",
      preset_id: "preset-1",
      folder: "Preset Folder",
    }, { activePresetId: "preset-1" });
    createRegexScript(USER_ID, {
      name: "Other Script",
      find_regex: "two",
      preset_id: "preset-2",
      folder: "Preset Folder",
    }, { activePresetId: "preset-2" });

    const out = exportRegexScripts(USER_ID, { presetId: "preset-1" });
    expect(out.scripts).toHaveLength(1);
    expect(out.scripts[0].name).toBe("Preset Script");
    expect("id" in out.scripts[0]).toBe(false);
    expect("user_id" in out.scripts[0]).toBe(false);
    expect("preset_id" in out.scripts[0]).toBe(false);
  });

  test("preset export uses saved enablement even when preset is inactive", () => {
    const enabled = createRegexScript(USER_ID, {
      name: "Enabled In Preset",
      find_regex: "one",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    const disabled = createRegexScript(USER_ID, {
      name: "Disabled In Preset",
      find_regex: "two",
      preset_id: "preset-1",
      disabled: true,
    }, { activePresetId: "preset-1" });

    expect(typeof enabled).not.toBe("string");
    expect(typeof disabled).not.toBe("string");

    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-1", presetId: null });
    expect(mustGetScript((enabled as Exclude<typeof enabled, string>).id).disabled).toBe(true);
    expect(mustGetScript((disabled as Exclude<typeof disabled, string>).id).disabled).toBe(true);

    const out = exportRegexScripts(USER_ID, { presetId: "preset-1" });
    expect(out.scripts).toHaveLength(2);
    expect(out.scripts.find((s) => s.name === "Enabled In Preset")?.disabled).toBe(false);
    expect(out.scripts.find((s) => s.name === "Disabled In Preset")?.disabled).toBe(true);
  });

  test("can export only scripts in a folder", () => {
    createRegexScript(USER_ID, { name: "In Folder", find_regex: "one", folder: "Folder A" });
    createRegexScript(USER_ID, { name: "Elsewhere", find_regex: "two", folder: "Folder B" });

    const out = exportRegexScripts(USER_ID, { folder: "Folder A" });
    expect(out.scripts.map((s) => s.name)).toEqual(["In Folder"]);
  });
});

describe("preset-bound regex activation", () => {
  test("switching presets restores only the active preset's saved enabled set", () => {
    const presetOneEnabled = createRegexScript(USER_ID, {
      name: "Preset One Enabled",
      find_regex: "one",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    const presetOneDisabled = createRegexScript(USER_ID, {
      name: "Preset One Disabled",
      find_regex: "two",
      preset_id: "preset-1",
      disabled: true,
    }, { activePresetId: "preset-1" });
    const presetTwoEnabled = createRegexScript(USER_ID, {
      name: "Preset Two Enabled",
      find_regex: "three",
      preset_id: "preset-2",
      disabled: false,
    }, { activePresetId: "preset-2" });

    expect(typeof presetOneEnabled).not.toBe("string");
    expect(typeof presetOneDisabled).not.toBe("string");
    expect(typeof presetTwoEnabled).not.toBe("string");

    const presetOneEnabledId = (presetOneEnabled as Exclude<typeof presetOneEnabled, string>).id;
    const presetOneDisabledId = (presetOneDisabled as Exclude<typeof presetOneDisabled, string>).id;
    const presetTwoEnabledId = (presetTwoEnabled as Exclude<typeof presetTwoEnabled, string>).id;

    activatePresetBoundRegexScripts(USER_ID, "preset-1");
    expect(mustGetScript(presetOneEnabledId).disabled).toBe(false);
    expect(mustGetScript(presetOneDisabledId).disabled).toBe(true);
    expect(mustGetScript(presetTwoEnabledId).disabled).toBe(true);

    toggleRegexScript(USER_ID, presetOneEnabledId, true, { activePresetId: "preset-1" });
    expect(mustGetScript(presetOneEnabledId).disabled).toBe(true);

    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-1", presetId: "preset-2" });
    expect(mustGetScript(presetOneEnabledId).disabled).toBe(true);
    expect(mustGetScript(presetOneDisabledId).disabled).toBe(true);
    expect(mustGetScript(presetTwoEnabledId).disabled).toBe(false);

    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-2", presetId: "preset-1" });
    expect(mustGetScript(presetOneEnabledId).disabled).toBe(true);
    expect(mustGetScript(presetOneDisabledId).disabled).toBe(true);
    expect(mustGetScript(presetTwoEnabledId).disabled).toBe(true);
  });

  test("inactive preset toggles do not rewrite that preset's restore list", () => {
    const presetOneEnabled = createRegexScript(USER_ID, {
      name: "Preset One Enabled",
      find_regex: "one",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    const presetTwoEnabled = createRegexScript(USER_ID, {
      name: "Preset Two Enabled",
      find_regex: "two",
      preset_id: "preset-2",
      disabled: false,
    }, { activePresetId: "preset-2" });

    expect(typeof presetOneEnabled).not.toBe("string");
    expect(typeof presetTwoEnabled).not.toBe("string");

    const presetOneEnabledId = (presetOneEnabled as Exclude<typeof presetOneEnabled, string>).id;
    const presetTwoEnabledId = (presetTwoEnabled as Exclude<typeof presetTwoEnabled, string>).id;

    activatePresetBoundRegexScripts(USER_ID, "preset-1");
    const inactiveToggle = toggleRegexScript(USER_ID, presetTwoEnabledId, false, { activePresetId: "preset-1" });
    expect(inactiveToggle?.disabled).toBe(true);

    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-1", presetId: "preset-2" });
    expect(mustGetScript(presetOneEnabledId).disabled).toBe(true);
    expect(mustGetScript(presetTwoEnabledId).disabled).toBe(false);
  });
});

describe("regex folder toggle", () => {
  test("toggles every script in a folder", () => {
    const a = createRegexScript(USER_ID, { name: "A", find_regex: "a", folder: "Folder", disabled: false });
    const b = createRegexScript(USER_ID, { name: "B", find_regex: "b", folder: "Folder", disabled: false });
    createRegexScript(USER_ID, { name: "Other", find_regex: "o", folder: "Other", disabled: false });

    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");
    const aId = (a as Exclude<typeof a, string>).id;
    const bId = (b as Exclude<typeof b, string>).id;

    const result = toggleRegexScriptsByFolder(USER_ID, "Folder", true);
    expect(result.changedIds.sort()).toEqual([aId, bId].sort());
    expect(result.skippedIds).toEqual([]);
    expect(mustGetScript(aId).disabled).toBe(true);
    expect(mustGetScript(bId).disabled).toBe(true);
  });

  test("ignores scripts already in the target state", () => {
    const a = createRegexScript(USER_ID, { name: "A", find_regex: "a", folder: "Folder", disabled: true });
    const b = createRegexScript(USER_ID, { name: "B", find_regex: "b", folder: "Folder", disabled: true });

    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");

    const result = toggleRegexScriptsByFolder(USER_ID, "Folder", true);
    expect(result.changedIds).toEqual([]);
    expect(result.skippedIds).toEqual([]);
  });

  test("skips scripts bound to an inactive preset", () => {
    const active = createRegexScript(USER_ID, {
      name: "Active Preset Script",
      find_regex: "a",
      folder: "Folder",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    const inactive = createRegexScript(USER_ID, {
      name: "Inactive Preset Script",
      find_regex: "i",
      folder: "Folder",
      preset_id: "preset-2",
      disabled: false,
    }, { activePresetId: "preset-2" });

    expect(typeof active).not.toBe("string");
    expect(typeof inactive).not.toBe("string");
    const activeId = (active as Exclude<typeof active, string>).id;
    const inactiveId = (inactive as Exclude<typeof inactive, string>).id;

    const result = toggleRegexScriptsByFolder(USER_ID, "Folder", true, { activePresetId: "preset-1" });
    expect(result.changedIds).toEqual([activeId]);
    expect(result.skippedIds).toEqual([inactiveId]);
    expect(mustGetScript(activeId).disabled).toBe(true);
    expect(mustGetScript(inactiveId).disabled).toBe(false);
  });

  test("persists active preset enablement to the restore list", () => {
    const script = createRegexScript(USER_ID, {
      name: "Preset Script",
      find_regex: "a",
      folder: "Folder",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    expect(typeof script).not.toBe("string");
    const id = (script as Exclude<typeof script, string>).id;

    toggleRegexScriptsByFolder(USER_ID, "Folder", true, { activePresetId: "preset-1" });
    expect(mustGetScript(id).disabled).toBe(true);

    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-1", presetId: null });
    expect(mustGetScript(id).disabled).toBe(true);

    activatePresetBoundRegexScripts(USER_ID, "preset-1");
    expect(mustGetScript(id).disabled).toBe(true);

    toggleRegexScriptsByFolder(USER_ID, "Folder", false, { activePresetId: "preset-1" });
    switchPresetBoundRegexScripts(USER_ID, { previousPresetId: "preset-1", presetId: null });
    activatePresetBoundRegexScripts(USER_ID, "preset-1");
    expect(mustGetScript(id).disabled).toBe(false);
  });
});

describe("regex selection toggle", () => {
  test("toggles only the selected scripts and ignores duplicate or missing ids", () => {
    const a = createRegexScript(USER_ID, { name: "A", find_regex: "a", folder: "One", disabled: false });
    const b = createRegexScript(USER_ID, { name: "B", find_regex: "b", folder: "Two", disabled: false });
    const other = createRegexScript(USER_ID, { name: "Other", find_regex: "o", disabled: false });

    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");
    expect(typeof other).not.toBe("string");
    const aId = (a as Exclude<typeof a, string>).id;
    const bId = (b as Exclude<typeof b, string>).id;
    const otherId = (other as Exclude<typeof other, string>).id;

    const result = toggleRegexScriptsByIds(USER_ID, [aId, "missing", bId, aId], true);
    expect(result.changedIds).toEqual([aId, bId]);
    expect(result.skippedIds).toEqual([]);
    expect(mustGetScript(aId).disabled).toBe(true);
    expect(mustGetScript(bId).disabled).toBe(true);
    expect(mustGetScript(otherId).disabled).toBe(false);
  });

  test("skips selected scripts bound to an inactive preset", () => {
    const active = createRegexScript(USER_ID, {
      name: "Active",
      find_regex: "a",
      preset_id: "preset-1",
      disabled: false,
    }, { activePresetId: "preset-1" });
    const inactive = createRegexScript(USER_ID, {
      name: "Inactive",
      find_regex: "i",
      preset_id: "preset-2",
      disabled: false,
    }, { activePresetId: "preset-2" });

    expect(typeof active).not.toBe("string");
    expect(typeof inactive).not.toBe("string");
    const activeId = (active as Exclude<typeof active, string>).id;
    const inactiveId = (inactive as Exclude<typeof inactive, string>).id;

    const result = toggleRegexScriptsByIds(USER_ID, [activeId, inactiveId], true, { activePresetId: "preset-1" });
    expect(result.changedIds).toEqual([activeId]);
    expect(result.skippedIds).toEqual([inactiveId]);
    expect(mustGetScript(activeId).disabled).toBe(true);
    expect(mustGetScript(inactiveId).disabled).toBe(false);
  });
});

describe("regex scope binding", () => {
  test("rejects changing to character scope without a scope id", () => {
    const created = createRegexScript(USER_ID, {
      name: "Needs Character",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    const result = updateRegexScript(USER_ID, script.id, { scope: "character" });

    expect(typeof result).toBe("string");
    expect(mustGetScript(script.id).scope).toBe("global");
    expect(mustGetScript(script.id).scope_id).toBeNull();
  });

  test("clears scope id when changing back to global scope", () => {
    const created = createRegexScript(USER_ID, {
      name: "Character Bound",
      find_regex: "one",
      scope: "character",
      scope_id: "char-1",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    const updated = updateRegexScript(USER_ID, script.id, { scope: "global" });

    expect(updated && typeof updated !== "string" ? updated.scope : null).toBe("global");
    expect(updated && typeof updated !== "string" ? updated.scope_id : "missing").toBeNull();
  });
});

describe("character-bound regex imports", () => {
  test("duplicate character imports do not collide on embedded script_id", () => {
    const extensions = {
      regex_scripts: [
        {
          name: "Strip OOC",
          script_id: "strip_ooc",
          find_regex: "\\(\\(.*?\\)\\)",
          replace_string: "",
          flags: "g",
          placement: ["ai_output"],
          target: ["response"],
          disabled: false,
        },
        {
          name: "Fix Quotes",
          script_id: "fix_quotes",
          find_regex: "\"([^\"]+)\"",
          replace_string: "[$1]",
          flags: "g",
          placement: ["ai_output"],
          target: ["response"],
          disabled: false,
        },
      ],
    };

    expect(importCharacterBoundRegexScripts(USER_ID, "char-1", extensions)).toBe(2);
    expect(importCharacterBoundRegexScripts(USER_ID, "char-2", extensions)).toBe(2);

    const firstCharacterScripts = getCharacterBoundScripts(USER_ID, "char-1");
    const secondCharacterScripts = getCharacterBoundScripts(USER_ID, "char-2");

    expect(firstCharacterScripts).toHaveLength(2);
    expect(secondCharacterScripts).toHaveLength(2);
    expect(firstCharacterScripts.map((script) => script.script_id)).toEqual(["", ""]);
    expect(secondCharacterScripts.map((script) => script.script_id)).toEqual(["", ""]);
    expect(firstCharacterScripts.map((script) => script.metadata.imported_script_id)).toEqual(["strip_ooc", "fix_quotes"]);
    expect(secondCharacterScripts.map((script) => script.metadata.imported_script_id)).toEqual(["strip_ooc", "fix_quotes"]);
  });

  test("original imported script_id still resolves inside the matching character context", () => {
    const extensions = {
      regex_scripts: [
        {
          name: "Scoped Regex",
          script_id: "scoped_regex",
          find_regex: "alpha",
          replace_string: "beta",
          flags: "g",
          placement: ["ai_output"],
          target: ["response"],
          disabled: false,
        },
      ],
    };

    expect(importCharacterBoundRegexScripts(USER_ID, "char-1", extensions)).toBe(1);
    expect(importCharacterBoundRegexScripts(USER_ID, "char-2", extensions)).toBe(1);

    expect(getRegexScriptByScriptId(USER_ID, "scoped_regex", { characterId: "char-1" })?.scope_id).toBe("char-1");
    expect(getRegexScriptByScriptId(USER_ID, "scoped_regex", { characterId: "char-2" })?.scope_id).toBe("char-2");
  });
});

describe("regex performance reporting", () => {
  test("duplicate script_id returns a validation error instead of throwing", () => {
    const first = createRegexScript(USER_ID, {
      name: "One",
      find_regex: "one",
      script_id: "shared_id",
    });
    expect(typeof first).not.toBe("string");

    const second = createRegexScript(USER_ID, {
      name: "Two",
      find_regex: "two",
      script_id: "shared_id",
    });
    expect(second).toBe("script_id already exists");
  });

  test("flags a slow regex script in metadata", () => {
    const created = createRegexScript(USER_ID, {
      name: "Slow Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    const result = reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "display_client",
    });

    expect(result.newlyFlagged).toBe(true);
    expect(result.script?.metadata?.regex_performance?.slow).toBe(true);
    expect(result.script?.metadata?.regex_performance?.source).toBe("display_client");
    expect(result.script?.metadata?.regex_performance?.version).toBe(script.updated_at);
    expect(result.script?.metadata?.regex_performance?.engine_version).toBe(2);
  });

  test("clears performance warning metadata when regex definition changes", () => {
    const created = createRegexScript(USER_ID, {
      name: "Editable Slow Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "display_client",
    });

    const updated = updateRegexScript(USER_ID, script.id, { find_regex: "two" });
    expect(updated && typeof updated !== "string" ? updated.metadata.regex_performance : undefined).toBeUndefined();
  });

  test("clears a display warning after a fast run of the same script version", () => {
    const created = createRegexScript(USER_ID, {
      name: "Recovered Display Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "display_client",
    });

    const result = reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 20,
      source: "display_client",
    });

    expect(result.cleared).toBe(true);
    expect(result.script?.metadata?.regex_performance).toBeUndefined();
  });

  test("does not clear a warning from a different execution source", () => {
    const created = createRegexScript(USER_ID, {
      name: "Prompt Slow Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "prompt_backend",
    });

    const result = reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 20,
      source: "display_client",
    });

    expect(result.cleared).toBe(false);
    expect(result.script?.metadata?.regex_performance?.source).toBe("prompt_backend");
  });

  test("allows either display execution path to clear a display warning", () => {
    const created = createRegexScript(USER_ID, {
      name: "Backend Display Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "display_backend",
    });

    const result = reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 20,
      source: "display_client",
    });

    expect(result.cleared).toBe(true);
  });

  test("clears a matching backend warning after a fast backend execution", async () => {
    const created = createRegexScript(USER_ID, {
      name: "Recovered Prompt Script",
      find_regex: "one",
    });
    expect(typeof created).not.toBe("string");

    const script = created as Exclude<typeof created, string>;
    reportRegexScriptPerformance(USER_ID, script.id, {
      elapsedMs: 5200,
      source: "prompt_backend",
    });

    await applyRegexScripts(
      "one",
      [mustGetScript(script.id)],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "prompt_backend" },
    );

    expect(mustGetScript(script.id).metadata.regex_performance).toBeUndefined();
  });

  test("accepts the full JS regex flag set d/g/i/m/s/u/v/y", () => {
    for (const flag of ["d", "g", "i", "m", "s", "u", "v", "y"]) {
      const created = createRegexScript(USER_ID, {
        name: `Flag ${flag}`,
        find_regex: "abc",
        flags: flag,
      });
      expect(typeof created).not.toBe("string");
    }
  });

  test("rejects flags outside d/g/i/m/s/u/v/y", () => {
    for (const bad of ["x", "z", "a", "gx", "gd!"]) {
      const result = createRegexScript(USER_ID, {
        name: `Bad ${bad}`,
        find_regex: "abc",
        flags: bad,
      });
      expect(typeof result).toBe("string");
    }
  });

  test("rejects duplicate flag chars", () => {
    const result = createRegexScript(USER_ID, {
      name: "Dup",
      find_regex: "abc",
      flags: "gg",
    });
    expect(typeof result).toBe("string");
  });
});

describe("regex JSON overwrite imports", () => {
  test("standalone imports overwrite content while preserving preset ownership", () => {
    const created = createRegexScript(USER_ID, {
      name: "Original",
      script_id: "shared_import",
      find_regex: "old",
      preset_id: "preset-1",
      disabled: true,
    }, { activePresetId: "preset-1" });
    expect(typeof created).not.toBe("string");

    const result = importRegexScripts(USER_ID, {
      scripts: [{
        name: "Updated",
        script_id: "shared_import",
        find_regex: "new",
        preset_id: "stale-exported-preset",
        disabled: false,
      }],
    }, { activePresetId: "preset-1" });

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [], presetAuthorityChanged: false });
    const updated = mustGetScript((created as RegexScript).id);
    expect(updated.name).toBe("Updated");
    expect(updated.find_regex).toBe("new");
    expect(updated.preset_id).toBe("preset-1");
    expect(updated.disabled).toBe(false);
  });

  test("preset imports overwrite and rebind a colliding regex", () => {
    const created = createRegexScript(USER_ID, {
      name: "Old preset regex",
      script_id: "shared_preset_import",
      find_regex: "old",
      preset_id: "old-preset",
    }, { activePresetId: "old-preset" });
    expect(typeof created).not.toBe("string");

    const result = importRegexScripts(USER_ID, {
      preset_id: "new-preset",
      scripts: [{
        name: "New preset regex",
        script_id: "shared_preset_import",
        find_regex: "new",
        preset_id: "old-preset",
        disabled: false,
      }],
    }, { activePresetId: "new-preset" });

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [], presetAuthorityChanged: false });
    const updated = mustGetScript((created as RegexScript).id);
    expect(updated.find_regex).toBe("new");
    expect(updated.preset_id).toBe("new-preset");
    expect(updated.disabled).toBe(false);

    toggleRegexScript(USER_ID, updated.id, true, { activePresetId: "new-preset" });
    expect(mustGetScript(updated.id).disabled).toBe(true);
    toggleRegexScript(USER_ID, updated.id, false, { activePresetId: "new-preset" });
    expect(mustGetScript(updated.id).disabled).toBe(false);
  });

  test("isolates LumiHub preset script IDs and stamps version attribution", () => {
    const global = createRegexScript(USER_ID, {
      name: "User global",
      script_id: "shared_preset_import",
      find_regex: "global",
    });
    expect(typeof global).not.toBe("string");

    const result = importPresetBoundRegexScripts(
      USER_ID,
      "preset-historical",
      "Historical preset",
      [{
        name: "Bundled preset regex",
        script_id: "shared_preset_import",
        find_regex: "bundled",
        disabled: false,
      }],
      {
        source: "lumihub",
        hubPresetId: "hub-preset-1",
        presetVersion: "1.4.0",
      },
    );

    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(mustGetScript((global as RegexScript).id)).toMatchObject({
      find_regex: "global",
      preset_id: null,
      script_id: "shared_preset_import",
    });

    const [bundled] = getRegexScriptsByPresetId(USER_ID, "preset-historical");
    expect(bundled).toMatchObject({
      folder: "Historical preset · LumiHub",
      script_id: "",
      metadata: {
        imported_script_id: "shared_preset_import",
        _lumiverse_lumihub_preset: {
          id: "hub-preset-1",
          version: "1.4.0",
          folderName: "Historical preset",
        },
      },
    });
    expect(getRegexScriptByScriptId(USER_ID, "shared_preset_import", { presetId: "preset-historical" })?.id)
      .toBe(bundled.id);
  });

  test("archives only attributed older preset regexes and never a same-named local folder", () => {
    const local = createRegexScript(USER_ID, {
      name: "Local folder peer",
      find_regex: "local",
      folder: "Historical preset",
      disabled: false,
    }) as RegexScript;

    importPresetBoundRegexScripts(
      USER_ID,
      "preset-historical",
      "Historical preset",
      [{ name: "Bundled v1", find_regex: "v1", disabled: false }],
      { source: "lumihub", hubPresetId: "hub-preset-1", presetVersion: "1.0.0" },
    );
    const v1 = getRegexScriptsByPresetId(USER_ID, "preset-historical")[0];

    const retired = retireLumiHubPresetRegexScriptsForUpdate(USER_ID, {
      presetId: "preset-historical",
      hubPresetId: "hub-preset-1",
      previousHubPresetId: "hub-preset-1",
      previousVersion: "1.0.0",
      incomingVersion: "2.0.0",
      presetName: "Historical preset",
    });

    expect(retired).toEqual({ archivedIds: [v1.id], replacedIds: [] });
    expect(mustGetScript(v1.id)).toMatchObject({
      disabled: true,
      folder: "Historical preset · v1.0.0",
      metadata: { _lumiverse_lumihub_preset: { id: "hub-preset-1", version: "1.0.0" } },
    });
    expect(mustGetScript(local.id)).toMatchObject({
      disabled: false,
      folder: "Historical preset",
      metadata: {},
    });

    const currentFolder = resolveLumiHubPresetRegexInstallFolder(
      USER_ID,
      "preset-historical",
      "hub-preset-1",
      "Historical preset",
    );
    expect(currentFolder).toBe("Historical preset · LumiHub");

    importPresetBoundRegexScripts(
      USER_ID,
      "preset-historical",
      "Historical preset",
      [{ name: "Bundled v2", find_regex: "v2", disabled: false }],
      {
        source: "lumihub",
        hubPresetId: "hub-preset-1",
        presetVersion: "2.0.0",
        folderName: currentFolder,
      },
    );
    const v2 = getRegexScriptsByPresetId(USER_ID, "preset-historical")
      .find((script) => script.metadata._lumiverse_lumihub_preset?.version === "2.0.0")!;

    activatePresetBoundRegexScripts(USER_ID, "preset-historical");
    expect(mustGetScript(v1.id).disabled).toBe(true);
    expect(mustGetScript(v2.id)).toMatchObject({ disabled: false, folder: "Historical preset · LumiHub" });
    expect(mustGetScript(local.id).disabled).toBe(false);
  });

  test("moves a legacy unqualified LumiHub folder into the reserved namespace on update", () => {
    importPresetBoundRegexScripts(
      USER_ID,
      "preset-legacy-folder",
      "Legacy folder preset",
      [{ name: "Bundled v1", find_regex: "v1", disabled: false }],
      { source: "lumihub", hubPresetId: "hub-legacy-folder", presetVersion: "1.0.0" },
    );

    expect(resolveLumiHubPresetRegexInstallFolder(
      USER_ID,
      "preset-legacy-folder",
      "hub-legacy-folder",
      "Legacy folder preset",
    )).toBe("Legacy folder preset · LumiHub");

    installLumiHubPresetRegexScripts(USER_ID, {
      presetId: "preset-legacy-folder",
      presetName: "Legacy folder preset",
      hubPresetId: "hub-legacy-folder",
      presetVersion: "2.0.0",
      previous: {
        hubPresetId: "hub-legacy-folder",
        version: "1.0.0",
        presetName: "Legacy folder preset",
      },
      // Real LumiHub exports preserve the author's original folder on every
      // script. It must not override the host's dedicated LumiHub folder.
      scripts: [{
        name: "Bundled v2",
        find_regex: "v2",
        folder: "Legacy folder preset",
        disabled: false,
      }],
    });

    const bundled = getRegexScriptsByPresetId(USER_ID, "preset-legacy-folder");
    expect(bundled.find((script) => script.metadata._lumiverse_lumihub_preset?.version === "1.0.0"))
      .toMatchObject({ disabled: true, folder: "Legacy folder preset · v1.0.0" });
    expect(bundled.find((script) => script.metadata._lumiverse_lumihub_preset?.version === "2.0.0"))
      .toMatchObject({ folder: "Legacy folder preset · LumiHub" });
  });

  test("preserves every payload folder through a LumiHub update", () => {
    const install = (version: string) => installLumiHubPresetRegexScripts(USER_ID, {
      presetId: "preset-multiple-folders",
      presetName: "ThreadBare",
      hubPresetId: "hub-multiple-folders",
      presetVersion: version,
      previous: version === "1.0.0" ? undefined : {
        hubPresetId: "hub-multiple-folders",
        version: "1.0.0",
        presetName: "ThreadBare",
      },
      scripts: [
        { name: `Stella ${version}`, find_regex: `stella-${version}`, folder: "Stella Interactive Cards", disabled: false },
        { name: `Rules ${version}`, find_regex: `rules-${version}`, folder: "Thread Rules", disabled: false },
      ],
    });

    install("1.0.0");
    expect(getRegexScriptsByPresetId(USER_ID, "preset-multiple-folders").map((script) => script.folder).sort())
      .toEqual(["Stella Interactive Cards · LumiHub", "Thread Rules · LumiHub"]);

    install("2.0.0");
    const folders = getRegexScriptsByPresetId(USER_ID, "preset-multiple-folders")
      .map((script) => script.folder)
      .sort();
    expect(folders).toEqual([
      "Stella Interactive Cards · LumiHub",
      "Stella Interactive Cards · v1.0.0",
      "Thread Rules · LumiHub",
      "Thread Rules · v1.0.0",
    ]);
  });

  test("retroactively attributes legacy preset-owned regexes before archiving them", () => {
    const legacy = createRegexScript(USER_ID, {
      name: "Legacy bundled regex",
      find_regex: "legacy",
      folder: "Legacy preset",
      preset_id: "preset-legacy",
    }) as RegexScript;

    const retired = retireLumiHubPresetRegexScriptsForUpdate(USER_ID, {
      presetId: "preset-legacy",
      hubPresetId: "hub-new-id",
      previousHubPresetId: "hub-old-id",
      previousVersion: "0.9.0",
      incomingVersion: "1.0.0",
      presetName: "Legacy preset",
    });

    expect(retired.archivedIds).toEqual([legacy.id]);
    expect(mustGetScript(legacy.id)).toMatchObject({
      disabled: true,
      folder: "Legacy preset · v0.9.0",
      metadata: { _lumiverse_lumihub_preset: { id: "hub-new-id", version: "0.9.0" } },
    });
  });

  test("publishes the resolved authority only for a committed remote install", () => {
    insertAuthorityPreset("preset-safe-update");
    const committedEvents = eventBus.withBufferedEvents(() => installLumiHubPresetRegexScripts(USER_ID, {
      presetId: "preset-safe-update",
      presetName: "Safe update preset",
      hubPresetId: "hub-safe-update",
      presetVersion: "1.0.0",
      scripts: [{ name: "Bundled v1", find_regex: "v1", disabled: false }],
    }));
    expect(committedEvents.events.map((event) => event.event)).toEqual([
      EventType.REGEX_SCRIPT_CHANGED,
      EventType.PRESET_CHANGED,
    ]);
    expect(committedEvents.events[1]).toMatchObject({
      payload: {
        id: "preset-safe-update",
        preset: { id: "preset-safe-update", cache_revision: 1 },
      },
      userId: USER_ID,
    });
    expect(authorityRevision("preset-safe-update")).toBe(1);

    const [v1] = getRegexScriptsByPresetId(USER_ID, "preset-safe-update");
    activatePresetBoundRegexScripts(USER_ID, "preset-safe-update");
    expect(mustGetScript(v1.id).disabled).toBe(false);
    const committedRevision = authorityRevision("preset-safe-update");

    const rolledBackEvents = eventBus.withBufferedEvents(() => {
      try {
        installLumiHubPresetRegexScripts(USER_ID, {
          presetId: "preset-safe-update",
          presetName: "Safe update preset",
          hubPresetId: "hub-safe-update",
          presetVersion: "2.0.0",
          previous: {
            hubPresetId: "hub-safe-update",
            version: "1.0.0",
            presetName: "Safe update preset",
          },
          scripts: [
            { name: "Valid v2", find_regex: "v2", disabled: false },
            { name: "Invalid v2", find_regex: "(", disabled: false },
          ],
        });
        throw new Error("Expected partial install to fail");
      } catch (error) {
        return error;
      }
    });
    expect(rolledBackEvents.value).toBeInstanceOf(Error);
    expect((rolledBackEvents.value as Error).message).toBe("LumiHub preset regex import was incomplete (1/2)");
    expect(rolledBackEvents.events).toEqual([]);
    expect(authorityRevision("preset-safe-update")).toBe(committedRevision);

    expect(getRegexScriptsByPresetId(USER_ID, "preset-safe-update")).toHaveLength(1);
    expect(mustGetScript(v1.id)).toMatchObject({
      disabled: false,
      folder: "Safe update preset · LumiHub",
      metadata: { _lumiverse_lumihub_preset: { id: "hub-safe-update", version: "1.0.0" } },
    });
  });
});

describe("raw capture processing", () => {
  test("applies macros without transferring a 300-group match to the host", async () => {
    const groupCount = 300;
    const script = {
      id: "large-capture-script",
      user_id: USER_ID,
      name: "Large capture script",
      script_id: "large_capture_script",
      find_regex: "(a)".repeat(groupCount),
      replace_string: "{{upper::$1}}-$99-$100",
      actions: [],
      flags: "g",
      placement: ["ai_output"],
      scope: "global",
      scope_id: null,
      target: ["prompt"],
      min_depth: null,
      max_depth: null,
      substitute_macros: "raw",
      trim_strings: [],
      run_on_edit: false,
      disabled: false,
      sort_order: 0,
      description: "",
      folder: "",
      pack_id: null,
      preset_id: null,
      character_id: null,
      owner_extension_identifier: null,
      validation_error_code: null,
      metadata: {},
      created_at: 0,
      updated_at: 0,
    } satisfies RegexScript;
    const macroEnv = {
      commit: true,
      variables: {
        local: new Map<string, string>(),
        global: new Map<string, string>(),
        chat: new Map<string, string>(),
      },
      dynamicMacros: {},
      extra: {},
    } as any;

    expect(await applyRegexScripts(
      "a".repeat(groupCount),
      [script],
      "ai_output",
      undefined,
      macroEnv,
    )).toBe("A-a-a0");
  });
});


describe("ordinary replacement processing", () => {
  test("uses native GetSubstitution in after mode", async () => {
    const script = runtimeScript({
      find_regex: "(?<word>ab)(c)?",
      replace_string: "$10|$<word>|$`|$'|$$",
      substitute_macros: "after",
    });
    const macroEnv = {
      commit: true,
      variables: {
        local: new Map<string, string>(),
        global: new Map<string, string>(),
        chat: new Map<string, string>(),
      },
      dynamicMacros: {},
      extra: {},
    } as unknown as MacroEnv;
    const input = "xxabcYY";
    const expected = input.replace(
      /(?<word>ab)(c)?/,
      "$10|$<word>|$`|$'|$$",
    );
    expect(await applyRegexScripts(input, [script], "ai_output", undefined, macroEnv)).toBe(expected);
  });
});
describe("find-only macro processing", () => {
  test("resolves the find pattern without resolving the replacement", async () => {
    const script = runtimeScript({
      find_regex: "{{upper::a}}",
      replace_string: "{{upper::x}}",
      substitute_macros: "find",
    });
    const macroEnv = {
      commit: true,
      variables: {
        local: new Map<string, string>(),
        global: new Map<string, string>(),
        chat: new Map<string, string>(),
      },
      dynamicMacros: {},
      extra: {},
    } as any;

    expect(await applyRegexScripts(
      "A",
      [script],
      "ai_output",
      undefined,
      macroEnv,
    )).toBe("{{upper::x}}");
  });
});

describe("regex match actions", () => {
  test("moves only the first matching replacement to the top", async () => {
    const script = runtimeScript({
      find_regex: "\\[x\\]",
      replace_string: "<$&>",
      metadata: { match_actions: ["move_top"] },
    });

    expect(await applyRegexScripts(
      "a [x] b [x]",
      [script],
      "ai_output",
    )).toBe("<[x]>\na  b [x]");
  });

  test("moves a capture-expanded replacement to the bottom", async () => {
    const script = runtimeScript({
      find_regex: "\\[([^\\]]+)\\]",
      replace_string: "<$1>",
      metadata: { match_actions: ["move_bottom"] },
    });

    expect(await applyRegexScripts(
      "a [x] b",
      [script],
      "ai_output",
    )).toBe("a  b\n<x>");
  });

  test("repeats a previous same-role match only when the current text misses", async () => {
    const script = runtimeScript({
      find_regex: "<status>([^<]+)</status>",
      replace_string: "<strong>$1</strong>",
      metadata: {
        match_actions: ["repeat_back"],
        repeat_position: "end_nl",
      },
    });

    expect(await applyRegexScripts(
      "new",
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { previousContent: "old <status>ready</status>" },
    )).toBe("new\n<strong>ready</strong>");
    expect(await applyRegexScripts(
      "<status>new</status>",
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { previousContent: "old <status>ready</status>" },
    )).toBe("<strong>new</strong>");
  });

  test("can carry the original previous match without replacing it", async () => {
    const script = runtimeScript({
      find_regex: "<status>([^<]+)</status>",
      replace_string: "<strong>$1</strong>",
      metadata: {
        match_actions: ["repeat_back"],
        repeat_position: "end_nl",
        repeat_raw_match: true,
      },
    });

    expect(await applyRegexScripts(
      "new",
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { previousContent: "old <status>ready</status>" },
    )).toBe("new\n<status>ready</status>");
  });

  test("resolves captures before raw macros in a carried replacement", async () => {
    const script = runtimeScript({
      find_regex: "<status>([^<]+)</status>",
      replace_string: "<strong>{{upper::$1}}</strong>",
      substitute_macros: "raw",
      metadata: {
        match_actions: ["repeat_back"],
        repeat_position: "end_nl",
      },
    });
    const macroEnv = {
      commit: true,
      variables: {
        local: new Map<string, string>(),
        global: new Map<string, string>(),
        chat: new Map<string, string>(),
      },
      dynamicMacros: {},
      extra: {},
    } as any;

    expect(await applyRegexScripts(
      "new",
      [script],
      "ai_output",
      undefined,
      macroEnv,
      undefined,
      { previousContent: "old <status>ready</status>" },
    )).toBe("new\n<strong>READY</strong>");
  });

  test("uses explicit repeat position metadata after replacement normalization", async () => {
    const script = runtimeScript({
      find_regex: "\\[x\\]",
      replace_string: "$1",
      metadata: {
        match_actions: ["move_top", "repeat_back"],
        repeat_position: "$1",
      },
    });

    expect(await applyRegexScripts(
      "new",
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { previousContent: "old [x]" },
    )).toBe("new");
  });

  test("supports every repeat placement", async () => {
    const expected = {
      end: "new[x]",
      start: "[x]new",
      end_nl: "new\n[x]",
      start_nl: "[x]\nnew",
    } as const;

    for (const [repeatPosition, result] of Object.entries(expected)) {
      const script = runtimeScript({
        find_regex: "\\[x\\]",
        replace_string: "",
        metadata: {
          match_actions: ["repeat_back"],
          repeat_position: repeatPosition,
          repeat_raw_match: true,
        },
      });

      expect(await applyRegexScripts(
        "new",
        [script],
        "ai_output",
        undefined,
        undefined,
        undefined,
        { previousContent: "old [x]" },
      )).toBe(result);
    }
  });
});

describe("associative regex actions", () => {
  test("renders omitted optional named captures as empty action attributes", async () => {
    const created = createRegexScript(USER_ID, {
      name: "Optional requirement",
      find_regex: "<choice>(?<label>[^<]+)</choice>(?:<req>(?<req>[^<]*)</req>)?",
      replace_string: '<button data-req="$<req>" data-regex-action="choose">$<label></button>',
      placement: ["ai_output"],
      target: ["display"],
      actions: [{
        id: "choose",
        type: "send",
        multi_select: false,
        cost: "1",
        limit: "3",
        title: "$<label>",
        subtitle: "",
        content: "Choose $<label>",
      }],
    });
    expect(typeof created).not.toBe("string");

    const output = await applyRegexScripts(
      "<choice>North</choice>",
      [created as RegexScript],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "display_backend" },
    );

    expect(output).toContain('data-req=""');
    expect(output).not.toContain("$<req>");
  });

  test("persists actions and resolves their capture templates per replacement", async () => {
    const created = createRegexScript(USER_ID, {
      name: "Choices",
      find_regex: "\\[([^|]+)\\|([^\\]]+)\\]",
      replace_string: '<button data-regex-action="choose">$1</button>',
      placement: ["ai_output"],
      target: ["display"],
      actions: [{
        id: "choose",
        type: "append",
        multi_select: false,
        cost: "1",
        limit: "3",
        title: "Choose $1",
        subtitle: "Next turn",
        content: "The user chose $2",
        effects: [{ type: "set_state", key: "adventure.route", value: "$2" }],
      }],
    });
    expect(typeof created).not.toBe("string");
    const script = created as RegexScript;
    expect(script.actions).toHaveLength(1);

    const output = await applyRegexScripts(
      '[North|the trail]',
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "display_backend" },
    );
    expect(output).toContain('data-lumiverse-regex-action="');
    expect(output).toContain(">North</button>");
    const encoded = output.match(/data-lumiverse-regex-action="([^"]+)"/)?.[1];
    expect(encoded).toBeTruthy();
    const payload = JSON.parse(decodeURIComponent(encoded!));
    expect(payload).toMatchObject({
      id: "choose",
      type: "append",
      multi_select: false,
      cost: 1,
      limit: 0,
      title: "Choose North",
      subtitle: "Next turn",
      content: "The user chose the trail",
      scriptId: script.id,
      instanceId: `${script.id}:0:17`,
      effects: [{ type: "set_state", key: "adventure.route", value: "the trail" }],
    });
  });

  test("rejects captured state keys while preserving legacy actions without effects", () => {
    const legacy = createRegexScript(USER_ID, {
      name: "Legacy choice",
      find_regex: "choice",
      actions: [{
        id: "choose",
        type: "send",
        multi_select: false,
        cost: "1",
        limit: "3",
        title: "",
        subtitle: "",
        content: "Choose",
      }],
    });
    expect(typeof legacy).not.toBe("string");
    expect((legacy as RegexScript).actions[0].effects).toBeUndefined();

    const invalid = createRegexScript(USER_ID, {
      name: "Unsafe state key",
      find_regex: "choice",
      actions: [{
        id: "choose",
        type: "send",
        multi_select: false,
        cost: "1",
        limit: "3",
        title: "",
        subtitle: "",
        content: "Choose",
        effects: [{ type: "set_state", key: "$1", value: "$2" }],
      }],
    });
    expect(invalid).toBe("state effect key must start with a letter and contain only letters, numbers, _, :, . or -");
  });

  test("resolves combined state, draft, and fork effects without a legacy send", async () => {
    const created = createRegexScript(USER_ID, {
      name: "Composite branch",
      find_regex: "\\[route:([^\\]]+)\\]",
      replace_string: '<button data-regex-action="branch">Branch</button>',
      placement: ["ai_output"],
      target: ["display"],
      actions: [{
        id: "branch",
        type: "effects",
        multi_select: false,
        cost: "1",
        limit: "3",
        title: "Branch via $1",
        subtitle: "",
        content: "",
        effects: [
          { type: "set_state", key: "adventure.route", value: "$1" },
          { type: "fork" },
          { type: "draft", mode: "replace", content: "Let's take $1." },
        ],
      }],
    });
    expect(typeof created).not.toBe("string");
    const script = created as RegexScript;

    const output = await applyRegexScripts(
      "[route:the rooftops]",
      [script],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "display_backend" },
    );
    const encoded = output.match(/data-lumiverse-regex-action="([^"]+)"/)?.[1];
    expect(encoded).toBeTruthy();
    expect(JSON.parse(decodeURIComponent(encoded!))).toMatchObject({
      type: "effects",
      content: "",
      effects: [
        { type: "set_state", key: "adventure.route", value: "the rooftops" },
        { type: "fork" },
        { type: "draft", mode: "replace", content: "Let's take the rooftops." },
      ],
    });
  });

  test("documentation examples import and resolve their action captures", async () => {
    const scenePayload = await Bun.file(new URL(
      "../../user-docs/docs/assets/examples/regex-actions/scene-card-action.json",
      import.meta.url,
    )).json();
    const multiPayload = await Bun.file(new URL(
      "../../user-docs/docs/assets/examples/regex-actions/multi-select-scene-planner.json",
      import.meta.url,
    )).json();

    expect(importRegexScripts(USER_ID, scenePayload)).toMatchObject({ imported: 1, skipped: 0, errors: [] });
    expect(importRegexScripts(USER_ID, multiPayload)).toMatchObject({ imported: 1, skipped: 0, errors: [] });

    const sceneScript = getRegexScriptByScriptId(USER_ID, "demo_interactive_scene_card");
    const multiScript = getRegexScriptByScriptId(USER_ID, "demo_multi_select_scene_planner");
    expect(sceneScript).not.toBeNull();
    expect(multiScript).not.toBeNull();

    const sceneOutput = await applyRegexScripts(
      `<scene><location>Moonlit Courtyard</location><description>A silver gate waits.</description><choice>Open the gate</choice></scene>`,
      [sceneScript!],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "display_backend" },
    );
    const sceneEncoded = sceneOutput.match(/data-lumiverse-regex-action="([^"]+)"/)?.[1];
    expect(sceneEncoded).toBeTruthy();
    expect(JSON.parse(decodeURIComponent(sceneEncoded!))).toMatchObject({
      id: "choose-scene",
      multi_select: false,
      title: "Choose: Open the gate",
      subtitle: "Scene: Moonlit Courtyard",
      content: "I choose to Open the gate.",
    });

    const multiOutput = await applyRegexScripts(
      `<scene-options><title>Sleeping City</title><budget>3</budget><route cost="2">Take the rooftops</route><companion cost="1">Bring Lyra</companion><tone cost="1">Keep it tense</tone></scene-options>`,
      [multiScript!],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { source: "display_backend" },
    );
    const multiActions = [...multiOutput.matchAll(/data-lumiverse-regex-action="([^"]+)"/g)]
      .map((match) => JSON.parse(decodeURIComponent(match[1])));
    expect(multiActions).toHaveLength(3);
    expect(multiActions.map((action) => ({
      id: action.id,
      type: action.type,
      cost: action.cost,
      limit: action.limit,
      content: action.content,
    }))).toEqual([
      { id: "select-route", type: "send", cost: 2, limit: 3, content: "Route: Take the rooftops" },
      { id: "select-companion", type: "send", cost: 1, limit: 3, content: "Companion: Bring Lyra" },
      {
        id: "select-tone",
        type: "append",
        cost: 1,
        limit: 3,
        content: "Write the next scene with this direction: Keep it tense. Treat it as guidance, not dialogue spoken by the user.",
      },
    ]);
    expect(multiActions.every((action) => action.multi_select === true)).toBe(true);
  });
});

describe("bounded regex validation", () => {
  test("rejects UTF-8 pattern and empty trim without mutating local rows", () => {
    const before = Number((getDb().query("SELECT COUNT(*) AS count FROM regex_scripts").get() as { count: number }).count);
    const invalid = createRegexScript(USER_ID, {
      name: "Too large",
      find_regex: "😀".repeat(20_000),
      trim_strings: [""],
    });
    expect(typeof invalid).toBe("string");
    const after = Number((getDb().query("SELECT COUNT(*) AS count FROM regex_scripts").get() as { count: number }).count);
    expect(after).toBe(before);
  });

  test("retains invalid foreign imports disabled with a repair code", () => {
    const imported = createRegexScript(USER_ID, {
      name: "Imported invalid",
      find_regex: "[",
    }, { foreignImport: true });
    expect(typeof imported).not.toBe("string");
    expect((imported as RegexScript).disabled).toBe(true);
    expect((imported as RegexScript).validation_error_code).toBe("invalid_regex");
  });

  test("lazily quarantines invalid legacy rows before execution", () => {
    getDb().query(
      `INSERT INTO regex_scripts
       (id, user_id, name, script_id, find_regex, replace_string, actions, flags, placement,
        scope, target, trim_strings, metadata, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, '', '[]', 'g', ?, 'global', ?, ?, '{}', 0, 0)`,
    ).run(
      "legacy-invalid",
      USER_ID,
      "Legacy invalid",
      "[",
      JSON.stringify(["ai_output"]),
      JSON.stringify(["response"]),
      JSON.stringify([]),
    );
    const row = getRegexScript(USER_ID, "legacy-invalid");
    expect(row?.disabled).toBe(true);
    expect(row?.validation_error_code).toBe("invalid_regex");
    const stored = getDb().query("SELECT disabled, validation_error_code FROM regex_scripts WHERE id = ?").get("legacy-invalid") as {
      disabled: number;
      validation_error_code: string;
    };
    expect(stored).toEqual({ disabled: 1, validation_error_code: "invalid_regex" });
  });

  test("cancellation and deadline fail before isolate admission", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(applyRegexScripts(
      "x",
      [runtimeScript({ find_regex: "x", replace_string: "y" })],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { signal: controller.signal },
    )).rejects.toThrow();
    await expect(applyRegexScripts(
      "x",
      [runtimeScript({ find_regex: "x", replace_string: "y" })],
      "ai_output",
      undefined,
      undefined,
      undefined,
      { deadlineAt: Date.now() - 1 },
    )).rejects.toThrow();
  });
});

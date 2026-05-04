import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  activatePresetBoundRegexScripts,
  createRegexScript,
  exportRegexScripts,
  getRegexScript,
  reportRegexScriptPerformance,
  switchPresetBoundRegexScripts,
  toggleRegexScript,
  updateRegexScript,
} from "./regex-scripts.service";

const USER_ID = "u1";

function mustGetScript(id: string) {
  const script = getRegexScript(USER_ID, id);
  expect(script).not.toBeNull();
  return script!;
}

beforeAll(() => {
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
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
});

beforeEach(() => {
  const db = getDb();
  db.query("DELETE FROM regex_scripts").run();
  db.query("DELETE FROM settings").run();
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

describe("regex performance reporting", () => {
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
});

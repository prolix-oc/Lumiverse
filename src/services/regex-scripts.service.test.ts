import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  activatePresetBoundRegexScripts,
  createRegexScript,
  getRegexScript,
  switchPresetBoundRegexScripts,
  toggleRegexScript,
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

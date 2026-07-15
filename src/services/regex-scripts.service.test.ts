import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  activatePresetBoundRegexScripts,
  applyRegexScripts,
  createRegexScript,
  exportRegexScripts,
  getCharacterBoundScripts,
  getRegexScript,
  getRegexScriptByScriptId,
  importCharacterBoundRegexScripts,
  reportRegexScriptPerformance,
  switchPresetBoundRegexScripts,
  toggleRegexScript,
  updateRegexScript,
} from "./regex-scripts.service";
import { initMacros } from "../macros";
import type { RegexScript } from "../types/regex-script";

const USER_ID = "u1";

function mustGetScript(id: string) {
  const script = getRegexScript(USER_ID, id);
  expect(script).not.toBeNull();
  return script!;
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

  db.run(`CREATE UNIQUE INDEX idx_regex_scripts_script_id
    ON regex_scripts(user_id, script_id)
    WHERE script_id != ''`);
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

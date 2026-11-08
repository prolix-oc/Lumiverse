import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../db/connection";
import type { RegexAction } from "../types/regex-script";
import { extractCardFromCharx } from "./character-card.service";
import { exportAsCharx } from "./character-export.service";
import { createCharacter } from "./characters.service";
import { applyCharxModulesAndAssets } from "./charx-import.service";
import { applyDisplayRegex } from "./display-regex.service";
import { getCharacterBoundScripts, importCharacterBoundRegexScripts } from "./regex-scripts.service";

const USER_ID = "charx-regex-actions-user";
const actions: RegexAction[] = [
  { id: "send", type: "send", multi_select: false, cost: "1", limit: "3", title: "Choose $1", subtitle: "Continue", content: "Take $1" },
  { id: "option", type: "append", multi_select: true, cost: "$2", limit: "5", title: "Equip $1", subtitle: "Loadout", content: "Bring $1", effects: [{ type: "set_state", key: "loadout", value: "$1" }] },
  { id: "state", type: "effects", multi_select: false, cost: "1", limit: "3", title: "Prepare", subtitle: "", content: "", effects: [
    { type: "set_state", key: "scene", value: "$1" },
    { type: "draft", content: "I choose $1", mode: "replace" },
    { type: "fork" },
  ] },
];

describe("CHARX character regex actions", () => {
  beforeEach(async () => {
    closeDatabase();
    const db = initDatabase(":memory:");
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
  });
  afterEach(() => closeDatabase());

  test.each(["SillyTavern", "Lumiverse"])("preserves %s imported actions through CHARX export and re-import", async format => {
    const character = createCharacter(USER_ID, { name: "Interactive character" });
    const script = {
      name: "Scene choices", find_regex: "<choice>(.*?):(\\d+)</choice>",
      replace_string: '<button data-regex-action="send">$1</button><button data-regex-action="option">Equip</button><button data-regex-action="state">Prepare</button>',
      actions, flags: "g", placement: ["ai_output"], target: ["display"],
    };
    const extensions = format === "SillyTavern"
      ? { regex_scripts: [{ ...script, scriptName: script.name, findRegex: `/${script.find_regex}/g`, replaceString: script.replace_string, placement: [2], markdownOnly: true }] }
      : { lumiverse_modules: { regex_scripts: [script] } };
    expect(importCharacterBoundRegexScripts(USER_ID, character.id, extensions)).toBe(1);
    const [originalScript] = getCharacterBoundScripts(USER_ID, character.id);
    expect(originalScript.actions).toEqual(actions);

    const archive = await exportAsCharx(USER_ID, character.id);
    expect(archive).not.toBeNull();
    const extracted = await extractCardFromCharx(new File([new Uint8Array(archive!)], "interactive.charx"));
    expect(extracted.lumiverseModules?.regex_scripts?.[0].actions).toEqual(actions);

    const imported = createCharacter(USER_ID, extracted.card);
    const result = await applyCharxModulesAndAssets(USER_ID, imported, extracted);
    expect(result.lumiverseModulesSummary?.regex_script_count).toBe(1);
    const restoredScripts = getCharacterBoundScripts(USER_ID, imported.id);
    expect(restoredScripts).toHaveLength(1);
    const [restored] = restoredScripts;
    expect(restored.actions).toEqual(actions);
    expect(restored).toMatchObject({
      scope: "character", scope_id: imported.id, character_id: imported.id,
      find_regex: originalScript.find_regex, replace_string: originalScript.replace_string,
      placement: originalScript.placement, target: originalScript.target,
    });
    expect(restored.id).not.toBe(originalScript.id);

    const rendered = await applyDisplayRegex({
      content: "<choice>lantern:2</choice>", scripts: restoredScripts, userId: USER_ID,
      context: { character_id: imported.id, is_user: false, depth: 0 },
    });
    const renderedActions = [...rendered.result.matchAll(/data-lumiverse-regex-action="([^"]+)"/g)]
      .map(match => JSON.parse(decodeURIComponent(match[1])));
    expect(renderedActions).toHaveLength(3);
    expect(renderedActions[0]).toMatchObject({ id: "send", content: "Take lantern", scriptId: restored.id });
    expect(renderedActions[1]).toMatchObject({
      id: "option", multi_select: true, cost: 2, limit: 5,
      effects: [{ type: "set_state", key: "loadout", value: "lantern" }],
    });
    expect(renderedActions[2]).toMatchObject({
      type: "effects", effects: [
        { type: "set_state", key: "scene", value: "lantern" },
        { type: "draft", content: "I choose lantern", mode: "replace" }, { type: "fork" },
      ],
    });
  });

  test("older bundles without actions still import as plain replacements", () => {
    const character = createCharacter(USER_ID, { name: "Legacy character" });
    expect(importCharacterBoundRegexScripts(USER_ID, character.id, {
      lumiverse_modules: { regex_scripts: [{ name: "Legacy", find_regex: "old", replace_string: "new" }] },
    })).toBe(1);
    expect(getCharacterBoundScripts(USER_ID, character.id)[0].actions).toEqual([]);
  });
});

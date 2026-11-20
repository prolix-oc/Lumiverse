import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chats from "../services/chats.service";
import * as presets from "../services/presets.service";
import * as regex from "../services/regex-scripts.service";
import { chatsRoutes } from "./chats.routes";
import { regexScriptsRoutes } from "./regex-scripts.routes";
import { macrosRoutes } from "./macros.routes";
import { applyMessagePresetContext } from "../services/message-preset-context.service";

const user = "preset-context-test";
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", user); await next(); });
app.route("/", chatsRoutes);
app.route("/regex-scripts", regexScriptsRoutes);
app.route("/macros", macrosRoutes);

async function renderNative(chatId: string, messageId: string, presetId: string, rawContent: string, swipeIndex = 0) {
  const response = await app.request(`http://localhost/${chatId}/display-preprocess`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, rawContent, role: "assistant", swipeIndex }) });
  expect(response.status).toBe(200);
  const preprocessed = await response.json();
  const scripts = await (await app.request(`http://localhost/regex-scripts/active?target=display&chat_id=${chatId}&preset_id=${presetId}`)).json();
  const rendered = await app.request("http://localhost/regex-scripts/apply", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: preprocessed.content, scripts, context: { chat_id: chatId, message_id: messageId, swipe_index: swipeIndex, use_message_preset: true, is_user: false, depth: 0, role: "assistant" } }) });
  expect(rendered.status).toBe(200);
  const result = await rendered.json(); return { ...result, content: result.result, preprocessed, scripts };
}
beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(closeDatabase);

test("stored swipe variables drive body, regex fallback and template resolution independently", async () => {
  const preset = presets.createPreset(user, { name: "Inputs", provider: "loom" });
  const rule = regex.createRegexScript(user, { name: "Input", preset_id: preset.id, target: ["display"], placement: ["ai_output"],
    find_regex: "^TOKEN$", replace_string: "{{getvar::mode}}/{{getchatvar::place}}", substitute_macros: "after" });
  if (typeof rule === "string") throw new Error(rule);
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, `presetRegexEnabled:${preset.id}`, JSON.stringify([rule.id]));
  const chat = chats.createChat(user, {});
  const contexts = ['A', 'B'].map(mode => ({ preset_id: preset.id, variables: { local: { mode }, chat: { place: mode + '-chat' }, global: {} } }));
  const message = chats.createMessage(chat.id, { name: "Cat", is_user: false, content: "TOKEN", extra: { spindle_metadata: { preset_contexts: contexts } } }, user);
  chats.updateMessage(user, message.id, { swipes: ['TOKEN', 'TOKEN'], extra: { spindle_metadata: { preset_contexts: contexts } } });
  for (const [swipeIndex, mode] of ['A', 'B', 'A'].entries()) {
    const index = swipeIndex % 2;
    const result = await renderNative(chat.id, message.id, preset.id, 'TOKEN', index);
    expect(result.content).toBe(`${mode}/${mode}-chat`);
    const response = await app.request('http://localhost/macros/resolve-batch', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templates: { input: '{{var::mode}}' }, chat_id: chat.id, message_id: message.id, swipe_index: index, use_message_preset: true }) });
    expect(response.status).toBe(200); expect((await response.json()).resolved.input).toBe(mode);
  }
});

test("each swipe runs its complete source chain on the whole message, including nested and anchored patterns", async () => {
  const a = presets.createPreset(user, { name: "A", provider: "loom" });
  const b = presets.createPreset(user, { name: "B", provider: "loom" });
  const chat = chats.createChat(user, {});
  const make = (preset: string, find: string, replacement: string, order: number) => {
    const result = regex.createRegexScript(user, {
    name: `rule ${order}`, preset_id: preset, find_regex: find, replace_string: replacement, flags: "g", target: ["display"],
    placement: ["ai_output"], sort_order: order,
    });
    if (typeof result === "string") throw new Error(result); return result;
  };
  const scripts = [make(a.id, "⠀", " ", 0), make(a.id, "^<outer>([\\s\\S]*)</outer>$", "<section>$1</section>", 1),
    make(a.id, "(?<=<section>)<inner>(.*?)</inner>(?=</section>)", "<b>$1</b>", 2),
    make(a.id, "^", "A:", 3)];
  const bScript = make(b.id, "^", "B:", 0);
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, `presetRegexEnabled:${b.id}`, JSON.stringify([bScript.id]));
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, `presetRegexEnabled:${a.id}`, JSON.stringify(scripts.map(s => s.id)));
  for (const script of scripts) regex.updateRegexScript(user, script.id, { disabled: true });
  const raw = "<outer><inner>two⠀words</inner></outer>";
  const message = chats.createMessage(chat.id, { is_user: false, name: "Cat", content: raw }, user);
  chats.updateMessage(user, message.id, { swipes: [raw, raw],
    extra: { spindle_metadata: { preset_contexts: [{ preset_id: a.id }, { preset_id: b.id }] } } });
  const render = async (swipeIndex: number) => {
    return renderNative(chat.id, message.id, swipeIndex === 0 && chats.getMessage(user, message.id)!.swipes.length === 2 ? a.id : b.id, raw, swipeIndex);
  };
  const first = await render(0);
  expect(first.content).toBe("A:<section><b>two words</b></section>");
  expect(first.scripts.map((s: any) => s.id)).toEqual(scripts.map(s => s.id));
  expect(first.preprocessed.content).toBe(raw);
  expect(JSON.stringify(first.preprocessed)).not.toContain("find_regex");
  regex.updateRegexScript(user, scripts[3].id, { replace_string: "UPDATED:" });
  expect((await render(0)).content).toBe("UPDATED:<section><b>two words</b></section>");
  expect((await render(1)).content).toBe(`B:${raw}`);
  chats.deleteSwipe(user, message!.id, 0);
  expect(chats.getMessage(user, message!.id)!.extra.spindle_metadata.preset_contexts).toEqual([{ preset_id: b.id }]);
  expect((await render(0)).content).toBe(`B:${raw}`);
});

test("preset selection stays fresh after rule edits and honors empty, malformed and missing restore lists", () => {
  const a = presets.createPreset(user, { name: "A", provider: "loom" });
  const b = presets.createPreset(user, { name: "B", provider: "loom" });
  const make = (name: string, presetId?: string) => {
    const script = regex.createRegexScript(user, { name, preset_id: presetId, find_regex: name, target: ["display"], placement: ["ai_output"] });
    if (typeof script === "string") throw new Error(script); return script;
  };
  const global = make("global"), first = make("first", a.id), other = make("other", b.id);
  const setting = `presetRegexEnabled:${a.id}`;
  const save = (value: string) => getDb().query("INSERT OR REPLACE INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, setting, value);
  const read = () => regex.getActiveScriptsForPreset(user, { presetId: a.id, target: "display" });
  save(JSON.stringify([` ${first.id} `, first.id, 1]));
  expect(read().map(s => s.id).sort()).toEqual([global.id, first.id].sort());
  expect(read().some(s => s.id === other.id)).toBe(false);
  regex.updateRegexScript(user, first.id, { find_regex: "edited" });
  expect(read().find(s => s.id === first.id)?.find_regex).toBe("edited");
  for (const value of ["[]", "{broken", JSON.stringify({ value: first.id })]) {
    save(value); expect(read().map(s => s.id)).toEqual([global.id]);
  }
  getDb().query("DELETE FROM settings WHERE user_id=? AND key=?").run(user, setting);
  getDb().query("UPDATE regex_scripts SET disabled=0 WHERE id=?").run(first.id);
  expect(read().some(s => s.id === first.id)).toBe(true);
  regex.updateRegexScript(user, first.id, { metadata: { regex_evidence: { quarantined: true } } });
  expect(read().some(s => s.id === first.id)).toBe(false);
});

test("preset-specific interactive buttons remain claimable through the native pipeline", async () => {
  const preset = presets.createPreset(user, { name: "Interactive", provider: "loom" });
  const script = regex.createRegexScript(user, { name: "Choice", preset_id: preset.id, target: ["display"], placement: ["ai_output"],
    find_regex: "choice", replace_string: '<button data-regex-action="go">Continue</button>',
    actions: [{ id: "go", type: "send", multi_select: false, cost: "", limit: "", title: "", subtitle: "", content: "Continue" }] });
  if (typeof script === "string") throw new Error(script);
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, `presetRegexEnabled:${preset.id}`, JSON.stringify([script.id]));
  const chat = chats.createChat(user, {});
  const message = chats.createMessage(chat.id, { is_user: false, name: "Cat", content: "choice", extra: { spindle_metadata: { preset_contexts: [{ preset_id: preset.id }] } } }, user);
  const rendered = await renderNative(chat.id, message.id, preset.id, "choice");
  expect(rendered.scripts[0].actions).toEqual(script.actions);
  expect(rendered.preprocessed.content).toBe("choice");
  const payload = JSON.parse(decodeURIComponent(rendered.content.match(/data-lumiverse-regex-action="([^"]+)"/)[1]));
  const claimed = await app.request(`http://localhost/${chat.id}/messages/${message.id}/regex-action`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ script_id: script.id, action_id: "go", instance_id: payload.instanceId }) });
  expect(claimed.status).toBe(200);
});

test("preset action effects verify the same captured body macros shown to the user", async () => {
  const preset = presets.createPreset(user, { name: "Captured choice", provider: "loom" });
  const script = regex.createRegexScript(user, {
    name: "Choice effect", preset_id: preset.id, target: ["display"], placement: ["ai_output"],
    find_regex: "^choice$", replace_string: '<button data-regex-action="go">Continue</button>',
    actions: [{ id: "go", type: "effects", multi_select: false, cost: "", limit: "", title: "", subtitle: "", content: "",
      effects: [{ type: "set_state", key: "chosen", value: "yes" }] }],
  });
  if (typeof script === "string") throw new Error(script);
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)")
    .run(user, `presetRegexEnabled:${preset.id}`, JSON.stringify([script.id]));
  const chat = chats.createChat(user, {});
  const message = chats.createMessage(chat.id, {
    is_user: false, name: "Cat", content: "{{getvar::label}}",
    extra: { spindle_metadata: { preset_contexts: [{ preset_id: preset.id, variables: { local: { label: "choice" } } }] } },
  }, user);
  const rendered = await renderNative(chat.id, message.id, preset.id, message.content);
  const payload = JSON.parse(decodeURIComponent(rendered.content.match(/data-lumiverse-regex-action="([^"]+)"/)[1]));
  const claimed = await app.request(`http://localhost/${chat.id}/messages/${message.id}/regex-action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ script_id: script.id, action_id: "go", instance_id: payload.instanceId }),
  });
  expect(claimed.status).toBe(200);
  expect(chats.getChat(user, chat.id)!.metadata.chat_variables).toEqual({ chosen: "yes" });
});
test("backend cache separates captured defaults and selections", async () => {
  const preset = presets.createPreset(user, { name: "Cache boundary", provider: "loom" });
  const rule = regex.createRegexScript(user, { name: "Snapshot", preset_id: preset.id, target: ["display"], placement: ["ai_output"], find_regex: "^TOKEN$", replace_string: "{{varDefault::mode}}/{{var::choice::ison::x}}", substitute_macros: "after" });
  if (typeof rule === "string") throw new Error(rule);
  getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)").run(user, `presetRegexEnabled:${preset.id}`, JSON.stringify([rule.id]));
  const chat = chats.createChat(user, {});
  const contexts = ["A", "B"].map(mode => ({ preset_id: preset.id, variables: { local: {}, global: {}, chat: {}, prompt_defaults: { mode }, prompt_selections: { choice: mode === "A" ? ["x"] : [] } } }));
  const message = chats.createMessage(chat.id, { name: "Assistant", is_user: false, content: "TOKEN" }, user);
  chats.updateMessage(user, message.id, { swipes: ["TOKEN", "TOKEN"], extra: { spindle_metadata: { preset_contexts: contexts } } });
  expect((await renderNative(chat.id, message.id, preset.id, "TOKEN", 0)).content).toBe("A/true");
  expect((await renderNative(chat.id, message.id, preset.id, "TOKEN", 1)).content).toBe("B/false");
  expect((await renderNative(chat.id, message.id, preset.id, "TOKEN", 0)).content).toBe("A/true");
});

test("message preset routes reject foreign, missing and invalid sources without using the active preset", async () => {
  const preset = presets.createPreset(user, { name: "Source", provider: "loom" });
  const foreign = presets.createPreset("other-user", { name: "Foreign", provider: "loom" });
  const chat = chats.createChat(user, {});
  const otherChat = chats.createChat(user, {});
  const message = chats.createMessage(chat.id, { name: "Assistant", is_user: false, content: "body",
    extra: { spindle_metadata: { preset_contexts: [{ preset_id: preset.id }] } } }, user);
  const resolve = (overrides: Record<string, unknown> = {}) => app.request("http://localhost/macros/resolve-batch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      templates: { value: "{{var::mode}}" }, use_message_preset: true, chat_id: chat.id, message_id: message.id, ...overrides,
    }),
  });
  for (const index of [-1, 1, 0.5, "0", null]) expect((await resolve({ swipe_index: index })).status).toBe(404);
  expect((await resolve({ chat_id: otherChat.id })).status).toBe(404);
  expect((await resolve({ message_id: "missing" })).status).toBe(404);
  expect((await resolve({ message_id: null })).status).toBe(400);
  for (const id of [foreign.id, "missing"]) {
    chats.updateMessage(user, message.id, { extra: { spindle_metadata: { preset_contexts: [{ preset_id: id }] } } });
    expect((await resolve()).status).toBe(404);
    expect((await app.request(`http://localhost/regex-scripts/active?target=display&preset_id=${id}`)).status).toBe(404);
    const applied = await app.request("http://localhost/regex-scripts/apply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "body", scripts: [],
        context: { chat_id: chat.id, message_id: message.id, use_message_preset: true } }),
    });
    expect(applied.status).toBe(404);
  }
  chats.updateMessage(user, message.id, { extra: { spindle_metadata: { preset_contexts: [{ preset_id: preset.id }] } } });
  presets.deletePreset(user, preset.id);
  expect((await resolve()).status).toBe(404);
  const preprocessed = await app.request(`http://localhost/${chat.id}/display-preprocess`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId: message.id, rawContent: "{{var::mode}}", role: "assistant" }),
  });
  expect((await preprocessed.json()).content).toBe("{{var::mode}}");
});

test("render snapshots are transient and unmarked macro resolution retains its response shape", async () => {
  const preset = presets.createPreset(user, { name: "Source", provider: "loom" });
  const chat = chats.createChat(user, {});
  const env = chats.buildMacroEnvForChat(user, chat.id)!;
  env.commit = true;
  const context = { preset_id: preset.id, variables: { local: { key: "captured" } } };
  expect(applyMessagePresetContext(env, user, context)).toBe(true);
  expect(env.commit).toBe(false);
  env.variables.local.set("key", "render-only");
  expect(context.variables.local.key).toBe("captured");
  const response = await app.request("http://localhost/macros/resolve-batch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templates: { value: "plain text" } }),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(Object.keys(result).sort()).toEqual(["cacheable", "resolved", "touched_vars"]);
  expect(result.resolved.value).toBe("plain text");
});

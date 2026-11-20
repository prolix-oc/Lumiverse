import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as chats from "../services/chats.service";
import * as presets from "../services/presets.service";
import * as regex from "../services/regex-scripts.service";
import { messageContentProcessorChain } from "../spindle/message-content-processor";
import { regexActionSignature } from "../utils/regex-action-signature";
import { chatsRoutes } from "./chats.routes";
import { regexScriptsRoutes } from "./regex-scripts.routes";

const user = "regex-action-verification";
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", user); await next(); });
app.route("/", chatsRoutes);
app.route("/regex-scripts", regexScriptsRoutes);
const cleanups: Array<() => void> = [];
beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(() => { while (cleanups.length) cleanups.pop()!(); closeDatabase(); });

function fixture(content: string, options: { preset?: boolean; captures?: boolean; multi?: boolean } = {}) {
  const preset = options.preset ? presets.createPreset(user, { name: "Source", provider: "loom" }) : undefined;
  const script = regex.createRegexScript(user, {
    name: "Choice", ...(preset ? { preset_id: preset.id } : {}),
    target: ["display"], placement: ["ai_output"], flags: "g",
    find_regex: options.captures ? "choice:([\\w-]+)" : "choice",
    replace_string: '<button data-regex-action="go">Go</button>',
    actions: [{ id: "go", type: "send", multi_select: !!options.multi, cost: "1", limit: "5", title: "", subtitle: "",
      content: options.captures ? "Continue $1" : "Continue",
      effects: [{ type: "set_state", key: "chosen", value: options.captures ? "$1" : "yes" }],
    }],
  });
  if (typeof script === "string") throw new Error(script);
  if (preset) getDb().query("INSERT INTO settings (user_id,key,value,updated_at) VALUES (?,?,?,0)")
    .run(user, `presetRegexEnabled:${preset.id}`, JSON.stringify([script.id]));
  const chat = chats.createChat(user, { metadata: { chat_variables: { label: "hello" } } });
  const message = chats.createMessage(chat.id, {
    name: "Assistant", is_user: false, content,
    ...(preset ? { extra: { spindle_metadata: { preset_contexts: [{ preset_id: preset.id, variables: { chat: { label: "captured-long" } } }] } } } : {}),
  }, user);
  return { chat, message, script, preset };
}
type Fixture = ReturnType<typeof fixture>;
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function render(f: Fixture, rawContent = f.message.content, honorPreset = true) {
  const pre = await app.request(`http://localhost/${f.chat.id}/display-preprocess`, json({
    messageId: f.message.id, rawContent, role: "assistant", messageIndex: 0, swipeIndex: 0,
  }));
  expect(pre.status).toBe(200);
  const scripts = await (await app.request(`http://localhost/regex-scripts/active?target=display&chat_id=${f.chat.id}${f.preset ? `&preset_id=${f.preset.id}` : ""}`)).json();
  const rendered = await app.request("http://localhost/regex-scripts/apply", json({
    content: (await pre.json()).content, scripts, preprocessed: true,
    context: { chat_id: f.chat.id, message_id: f.message.id, message_index: 0, is_user: false, depth: 0, role: "assistant",
      ...(f.preset && honorPreset ? { use_message_preset: true, swipe_index: 0 } : {}),
    },
  }));
  expect(rendered.status).toBe(200);
  const html = (await rendered.json()).result as string;
  return [...html.matchAll(/data-lumiverse-regex-action="([^"]+)"/g)].map(match => JSON.parse(decodeURIComponent(match[1])));
}
function selection(f: Fixture, payload: any) {
  return { message_id: f.message.id, script_id: f.script.id, action_id: "go", instance_id: payload.instanceId,
    action_signature: regexActionSignature(payload) };
}
function claim(f: Fixture, payload: any, overrides: Record<string, unknown> = {}) {
  return app.request(`http://localhost/${f.chat.id}/messages/${f.message.id}/regex-action`, json({ ...selection(f, payload), ...overrides }));
}

for (const preset of [false, true]) {
  test(`body macros and a non-idempotent processor run once per display/claim (preset=${preset})`, async () => {
    const f = fixture("{{getchatvar::label}} choice", { preset });
    let calls = 0;
    cleanups.push(messageContentProcessorChain.register({ extensionId: "review", userId: user, priority: 0,
      handler: async ctx => { calls++; return { content: "prefix " + ctx.content }; },
    }));
    const [payload] = await render(f);
    expect(calls).toBe(1);
    expect((await claim(f, payload)).status).toBe(200);
    expect(calls).toBe(2);
    expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "yes" });
  });
  test(`tag removal relocates the correct captured choice and remains one-shot (preset=${preset})`, async () => {
    const f = fixture("<status>hidden</status>choice:north choice:south", { preset, captures: true });
    // MessageContent removes intercepted tags before the native pipeline.
    const payloads = await render(f, "choice:north choice:south");
    expect(payloads).toHaveLength(2);
    expect((await claim(f, payloads[1])).status).toBe(200);
    expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "south" });
    expect((await claim(f, payloads[1], { instance_id: `${f.script.id}:999:1000` })).status).toBe(409);
    expect((await claim(f, payloads[0])).status).toBe(200);
    expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "north" });
  });
}

test("older clients can relocate a single constant-effect block without a signature", async () => {
  const f = fixture("<status>hidden</status>choice");
  const [payload] = await render(f, "choice");
  expect((await claim(f, payload, { action_signature: undefined })).status).toBe(200);
  expect((await claim(f, payload, { action_signature: undefined, instance_id: `${f.script.id}:100:106` })).status).toBe(409);
});

test("a relocated display offset overlapping another source block does not consume that block", async () => {
  const cleaned = "choice:north" + " ".repeat(11) + "choice:south";
  const f = fixture("<status>hidden</status>" + cleaned, { captures: true });
  const [north, south] = await render(f, cleaned);
  expect(south.instanceId).toBe(`${f.script.id}:23:35`);
  expect((await claim(f, north)).status).toBe(200);
  expect(chats.getMessage(user, f.message.id)!.extra.associative_regex_action_usage[south.instanceId]).toBeUndefined();
  expect((await claim(f, south)).status).toBe(200);
  const [sourceNorth] = await render(f);
  expect(sourceNorth.instanceId).toBe(south.instanceId);
  expect((await claim(f, sourceNorth)).status).toBe(409);
});

test("verification uses the displayed active swipe when the content column differs", async () => {
  const f = fixture("choice:north", { captures: true });
  getDb().query("UPDATE messages SET swipes = ? WHERE id = ?").run(JSON.stringify(["choice:south"]), f.message.id);
  const [payload] = await render(f, "choice:south");
  expect((await claim(f, payload)).status).toBe(200);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "south" });
});

test("usage saved before the upgrade still prevents a relocated claim", async () => {
  const f = fixture("<status>hidden</status>choice");
  const [source] = await render(f);
  const [cleaned] = await render(f, "choice");
  chats.updateMessage(user, f.message.id, { extra: { associative_regex_action_usage: {
    [source.instanceId]: { script_id: f.script.id, action_id: "go", used_at: 1 },
  } } });
  expect((await claim(f, cleaned)).status).toBe(409);
});

test("a relocated state action also consumes its sibling Send action without effects", async () => {
  const f = fixture("<status>hidden</status>choice");
  regex.updateRegexScript(user, f.script.id, {
    replace_string: '<button data-regex-action="go">State</button><button data-regex-action="other">Send</button>',
    actions: [...f.script.actions, { ...f.script.actions[0], id: "other", content: "Other", effects: [] }],
  });
  const [state] = await render(f, "choice");
  expect((await claim(f, state)).status).toBe(200);
  const [, other] = await render(f);
  expect((await claim(f, other, { action_id: "other" })).status).toBe(409);
});

test("signature verification preserves Send actions on user messages without effects", async () => {
  const f = fixture("choice");
  regex.updateRegexScript(user, f.script.id, { placement: ["user_input"], actions: [{ ...f.script.actions[0], effects: [] }] });
  chats.updateMessage(user, f.message.id, { content: "choice" });
  getDb().query("UPDATE messages SET is_user = 1 WHERE id = ?").run(f.message.id);
  const script = regex.getRegexScript(user, f.script.id)!;
  const response = await app.request("http://localhost/regex-scripts/apply", json({ content: "choice", scripts: [script], preprocessed: true,
    context: { chat_id: f.chat.id, message_id: f.message.id, role: "user", is_user: true, depth: 0 } }));
  const html = (await response.json()).result as string;
  const userPayload = JSON.parse(decodeURIComponent(html.match(/data-lumiverse-regex-action="([^"]+)"/)![1]));
  expect((await claim(f, userPayload)).status).toBe(200);
});

test("relocated effects-only choices retain their captured draft and fork effects", async () => {
  const f = fixture("<status>hidden</status>choice:north", { captures: true });
  regex.updateRegexScript(user, f.script.id, { actions: [{ ...f.script.actions[0], type: "effects", content: "", effects: [
    { type: "set_state", key: "chosen", value: "$1" }, { type: "draft", mode: "replace", content: "Take $1" }, { type: "fork" },
  ] }] });
  const [payload] = await render(f, "choice:north");
  const response = await claim(f, payload);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.effects).toContainEqual({ type: "draft", mode: "replace", content: "Take north" });
  expect(result.forked_chat.id).not.toBe(f.chat.id);
  expect((await claim(f, payload)).status).toBe(409);
});

test("ambiguous relocated matches and forged captured values fail without writes", async () => {
  const f = fixture("<status>hidden</status>choice:north choice:north", { captures: true });
  const [payload] = await render(f, "choice:north choice:north");
  expect((await claim(f, payload)).status).toBe(404);
  const forged = { ...payload, effects: [{ type: "set_state", key: "chosen", value: "forged" }] };
  expect((await claim(f, forged)).status).toBe(404);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toEqual({ label: "hello" });
  expect(chats.getMessage(user, f.message.id)!.extra.associative_regex_action_usage).toBeUndefined();
});

test("legacy extension live variables verify against the source preset and share snapshot usage", async () => {
  const f = fixture("choice", { preset: true, captures: true });
  const prefix = regex.createRegexScript(user, { name: "Prefix", target: ["display"], placement: ["ai_output"],
    find_regex: "^choice$", replace_string: "choice:{{getchatvar::label}}", substitute_macros: "after", sort_order: -1 });
  if (typeof prefix === "string") throw new Error(prefix);
  const [live] = await render(f, "choice", false);
  expect(live.effects[0].value).toBe("hello");
  expect((await claim(f, live)).status).toBe(200);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "hello" });
  const [captured] = await render(f);
  expect(captured.effects[0].value).toBe("captured-long");
  expect((await claim(f, captured)).status).toBe(409);
});

test("batch claims relocate captured choices together and reject reused aliases", async () => {
  const f = fixture("<status>hidden</status>choice:north choice:south", { captures: true, multi: true });
  const payloads = await render(f, "choice:north choice:south");
  const url = `http://localhost/${f.chat.id}/messages/regex-actions/claim`;
  const response = await app.request(url, json({ selections: payloads.map(payload => selection(f, payload)) }));
  expect(response.status).toBe(200);
  expect((await response.json()).usages).toHaveLength(2);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toMatchObject({ chosen: "south" });
  expect((await app.request(url, json({ selections: [{ ...selection(f, payloads[1]), instance_id: `${f.script.id}:500:506` }] }))).status).toBe(409);
});

test("an unverifiable batch selection does not commit earlier valid effects", async () => {
  const f = fixture("choice:north choice:south", { captures: true, multi: true });
  const payloads = await render(f);
  const response = await app.request(`http://localhost/${f.chat.id}/messages/regex-actions/claim`, json({ selections: [
    selection(f, payloads[0]), { ...selection(f, payloads[1]), action_signature: "forged" },
  ] }));
  expect(response.status).toBe(404);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toEqual({ label: "hello" });
  expect(chats.getMessage(user, f.message.id)!.extra.associative_regex_action_usage).toBeUndefined();
});

test("stored decorated attributes cannot manufacture an action during verification", async () => {
  const f = fixture("no matching source");
  const fake = { ...f.script.actions[0], cost: 1, limit: 0, scriptId: f.script.id, instanceId: `${f.script.id}:0:6` };
  chats.updateMessage(user, f.message.id, { content: `<button data-lumiverse-regex-action="${encodeURIComponent(JSON.stringify(fake))}">Fake</button>` });
  expect((await claim(f, fake)).status).toBe(404);
});

test("changed source captures and malformed signatures cannot apply stale effects", async () => {
  const f = fixture("choice:north", { captures: true });
  const [payload] = await render(f);
  chats.updateMessage(user, f.message.id, { content: "choice:south" });
  expect((await claim(f, payload)).status).toBe(404);
  expect((await claim(f, payload, { action_signature: {} })).status).toBe(400);
  expect(chats.getChat(user, f.chat.id)!.metadata.chat_variables).toEqual({ label: "hello" });
});

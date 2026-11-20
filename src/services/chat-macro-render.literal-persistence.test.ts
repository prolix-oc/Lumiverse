import { expect, test } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { chatsRoutes } from "../routes/chats.routes";
import { closeDatabase, initDatabase } from "../db/connection";
import { createCharacter } from "./characters.service";
import { createChat, createMessage, getMessage } from "./chats.service";
import { createPreset } from "./presets.service";
import { reconcileChatMessageMacros, resolveRenderedMessageContent } from "./chat-macro-render.service";
import { assemblePrompt } from "./prompt-assembly.service";
import { buildEnv, initMacros } from "../macros";
import { shieldMessageLiterals } from "../macros/message-literals";
import { createRegexScript } from "./regex-scripts.service";
import { captureMessageLiterals } from "../macros/message-literals";
import { resolveAndSanitizeForVectorization } from "./vectorization-content.service";

test("persisted JSON reads stay inert in legacy and preset history and quoted messages", async () => {
  const db = initDatabase(":memory:");
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
    initMacros();
    const userId = "json-literal-persistence-user";
    const character = createCharacter(userId, { name: "Reviewer" });
    const chat = createChat(userId, { character_id: character.id });
    const data = "{{setchatvar::owned::yes}}";
    const message = createMessage(chat.id, {
      is_user: false, name: character.name, content: "{{getchatvarkey::state::note}}",
    }, userId);
    const seed = buildEnv({ character, chat, messages: [message], persona: null, generationType: "normal", userId });
    seed.variables.chat.set("state", JSON.stringify({ note: data }));
    await reconcileChatMessageMacros({ userId, chatId: chat.id, messageIds: [message.id], macroEnvSeed: seed });
    const saved = getMessage(userId, message.id)!;
    expect(saved.content).toBe(data);
    const legacy = await assemblePrompt({ userId, chatId: chat.id, generationType: "normal", skipPromptRegex: true });
    expect(legacy.macroEnv!.variables.chat.has("owned")).toBe(false);
    expect(legacy.messages.some((m) => m.content === data)).toBe(true);
    const preset = createPreset(userId, {
      name: "Literal history", provider: "openai", prompt_order: [{
        id: "history", name: "History", enabled: true, role: "system", marker: "chat_history", content: "",
        position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null,
      }],
    });
    const assembled = await assemblePrompt({ userId, chatId: chat.id, generationType: "normal", presetOverride: preset, skipPromptRegex: true });
    expect(assembled.macroEnv!.variables.chat.has("owned")).toBe(false);
    expect(assembled.messages.some((m) => m.content === data)).toBe(true);
    const env = buildEnv({ character, chat, messages: [saved], persona: null, generationType: "normal", userId });
    expect(await resolveRenderedMessageContent("{{lastCharMessage}}", env)).toBe(data);
    expect(env.variables.chat.has("owned")).toBe(false);
    expect(await resolveRenderedMessageContent(shieldMessageLiterals(saved.content, saved), env)).toBe(data);
    expect(env.variables.chat.has("owned")).toBe(false);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
    app.route("/chats", chatsRoutes);
    const response = await app.request(`/chats/${chat.id}/display-preprocess`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: saved.id, rawContent: saved.content, role: "assistant" }),
    });
    expect(response.status).toBe(200);
    const displayed = await response.json() as { content: string };
    expect(displayed.content).not.toContain("{{setchatvar");
    expect(captureMessageLiterals(displayed.content).content).toBe(data);

    const block = `<json>${JSON.stringify({ note: data, legacy: "<USER>" })}</json>`;
    await resolveAndSanitizeForVectorization(shieldMessageLiterals(saved.content, saved), env);
    await resolveAndSanitizeForVectorization(block, env);
    expect(env.variables.chat.has("owned")).toBe(false);
    for (const mode of ["none", "raw", "after"] as const) {
      const scriptId = `json_${mode}`;
      expect(typeof createRegexScript(userId, {
        name: scriptId, script_id: scriptId, find_regex: "(<json>.*</json>)",
        replace_string: mode === "none" ? "HIDDEN" : "$1!", substitute_macros: mode,
      })).toBe("object");
      expect(await resolveRenderedMessageContent(`{{regexInstalled::${scriptId}}}${block}{{/regexInstalled}}`, env))
        .toBe(mode === "none" ? "HIDDEN" : block + "!");
      expect(env.variables.chat.has("owned")).toBe(false);
    }
    env.variables.chat.set("state", JSON.stringify({ note: data }));
    for (const mode of ["raw", "after"] as const) {
      const scriptId = `json_plain_${mode}`;
      expect(typeof createRegexScript(userId, {
        name: scriptId, script_id: scriptId, find_regex: "(\\{\\{.*\\}\\})",
        replace_string: "{{setchatvar::script::yes}}$1!", substitute_macros: mode,
      })).toBe("object");
      expect(await resolveRenderedMessageContent(`{{regexInstalled::${scriptId}}}{{getchatvarkey::state::note}}{{/regexInstalled}}`, env))
        .toBe(data + "!");
      expect(env.variables.chat.has("owned")).toBe(false);
      expect(env.variables.chat.get("script")).toBe("yes");
    }
    await reconcileChatMessageMacros({ userId, chatId: chat.id, messageIds: [message.id], macroEnvSeed: seed });
    expect(getMessage(userId, message.id)!.extra).toEqual(saved.extra);
  } finally {
    closeDatabase();
  }
});

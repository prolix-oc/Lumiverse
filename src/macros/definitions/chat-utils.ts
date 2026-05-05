import { registry } from "../MacroRegistry";

interface SimpleMessage {
  content: string;
  name: string;
  is_user: boolean;
}

export function registerChatUtilsMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "messageAt",
    category: "Chat Utils",
    description: "Get message content at a specific index (0-based). Negative indexes count from end.",
    returnType: "string",
    args: [{ name: "index", description: "Message index (0-based, negative counts from end)" }],
    aliases: ["message_at", "msgAt"],
    handler: (ctx) => {
      const messages = getMessages(ctx.env.extra);
      if (!messages.length) return "";
      let idx = parseInt(ctx.args[0], 10) || 0;
      if (idx < 0) idx = messages.length + idx;
      return messages[idx]?.content ?? "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    name: "messagesBy",
    category: "Chat Utils",
    description: "Get last N messages from a specific speaker, most recent first",
    returnType: "string",
    args: [
      { name: "name", description: "Speaker name" },
      { name: "count", optional: true, description: "Max messages (default 3)" },
    ],
    aliases: ["messages_by", "msgBy"],
    handler: (ctx) => {
      const messages = getMessages(ctx.env.extra);
      const name = (ctx.args[0] ?? "").trim();
      const count = parseInt(ctx.args[1], 10) || 3;
      if (!name || !messages.length) return "";
      const matches: string[] = [];
      for (let i = messages.length - 1; i >= 0 && matches.length < count; i--) {
        if (messages[i].name === name) {
          matches.push(messages[i].content);
        }
      }
      return matches.join("\n");
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    volatile: true,
    name: "chatAge",
    category: "Chat Utils",
    description: "Human-readable time since the chat was created",
    returnType: "string",
    aliases: ["chat_age"],
    handler: (ctx) => {
      const created = ctx.env.extra.chatCreatedAt as number | undefined;
      if (!created) return "unknown";
      const diffMs = Date.now() - created * 1000;
      return formatDuration(Math.max(diffMs, 0));
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    volatile: true,
    name: "counter",
    category: "Chat Utils",
    description: "Increment a named counter (local variable) and return the new value",
    returnType: "integer",
    args: [{ name: "name", description: "Counter name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      if (!key) return "0";
      const current = parseInt(ctx.env.variables.local.get(key) || "0", 10) || 0;
      const next = String(current + 1);
      ctx.env.variables.local.set(key, next);
      return next;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    volatile: true,
    name: "toggle",
    category: "Chat Utils",
    description: "Toggle a named boolean (local variable) and return the new value",
    returnType: "boolean",
    args: [{ name: "name", description: "Toggle name" }],
    handler: (ctx) => {
      const key = (ctx.args[0] || "").trim();
      if (!key) return "false";
      const current = ctx.env.variables.local.get(key);
      const next = current === "true" ? "false" : "true";
      ctx.env.variables.local.set(key, next);
      return next;
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "charTags",
    category: "Chat Utils",
    description: "Comma-separated list of the character's tags",
    returnType: "string",
    aliases: ["char_tags", "characterTags"],
    handler: (ctx) => {
      const tags = ctx.env.extra.characterTags as string[] | undefined;
      return Array.isArray(tags) ? tags.join(", ") : "";
    },
  });

  registry.registerMacro({
    builtIn: true,
    terminal: true,
    name: "charTag",
    category: "Chat Utils",
    description: "Check if the character has a specific tag (returns 'true' or 'false')",
    returnType: "boolean",
    args: [{ name: "tag", description: "Tag to check" }],
    aliases: ["char_tag", "hasTag", "has_tag"],
    handler: (ctx) => {
      const tags = ctx.env.extra.characterTags as string[] | undefined;
      const tag = (ctx.args[0] ?? "").trim().toLowerCase();
      if (!Array.isArray(tags) || !tag) return "false";
      return tags.some((t) => t.toLowerCase() === tag) ? "true" : "false";
    },
  });
}

function getMessages(extra: Record<string, any>): SimpleMessage[] {
  const messages = extra.messages;
  return Array.isArray(messages) ? messages : [];
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

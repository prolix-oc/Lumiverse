import { registry } from "../MacroRegistry";

export function registerChatMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "lastMessage",
    category: "Chat",
    description: "Content of the last chat message",
    returnType: "string",
    aliases: ["last_message"],
    handler: (ctx) => ctx.env.chat.lastMessage,
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastMessageId",
    category: "Chat",
    description: "Index of the last message in chat",
    returnType: "integer",
    aliases: ["last_message_id"],
    handler: (ctx) => String(ctx.env.chat.lastMessageId),
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastUserMessage",
    category: "Chat",
    description: "Content of the last user message",
    returnType: "string",
    aliases: ["last_user_message"],
    handler: (ctx) => ctx.env.chat.lastUserMessage,
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastCharMessage",
    category: "Chat",
    description: "Content of the last character message",
    returnType: "string",
    aliases: ["last_char_message", "lastBotMessage"],
    handler: (ctx) => ctx.env.chat.lastCharMessage,
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastMessageName",
    category: "Chat",
    description: "Name of the sender of the last message",
    returnType: "string",
    handler: (ctx) => ctx.env.chat.lastMessageName,
  });

  registry.registerMacro({
    builtIn: true,
    name: "messageCount",
    category: "Chat",
    description: "Total number of messages in chat",
    returnType: "integer",
    aliases: ["message_count", "messagecount"],
    handler: (ctx) => String(ctx.env.chat.messageCount),
  });

  registry.registerMacro({
    builtIn: true,
    name: "chatId",
    category: "Chat",
    description: "Current chat ID",
    returnType: "string",
    aliases: ["chat_id"],
    handler: (ctx) => ctx.env.chat.id,
  });

  registry.registerMacro({
    builtIn: true,
    name: "firstIncludedMessageId",
    category: "Chat",
    description: "Index of the first message included in the prompt",
    returnType: "integer",
    handler: (ctx) => String(ctx.env.chat.firstIncludedMessageId),
  });

  registry.registerMacro({
    builtIn: true,
    name: "firstDisplayedMessageId",
    category: "Chat",
    description: "Index of the first displayed message (same as firstIncludedMessageId)",
    returnType: "integer",
    handler: (ctx) => String(ctx.env.chat.firstIncludedMessageId),
  });

  registry.registerMacro({
    builtIn: true,
    name: "lastSwipeId",
    category: "Chat",
    description: "Index of the last swipe on the last message",
    returnType: "integer",
    handler: (ctx) => String(ctx.env.chat.lastSwipeId),
  });

  registry.registerMacro({
    builtIn: true,
    name: "currentSwipeId",
    category: "Chat",
    description: "Index of the currently active swipe",
    returnType: "integer",
    handler: (ctx) => String(ctx.env.chat.currentSwipeId),
  });
}

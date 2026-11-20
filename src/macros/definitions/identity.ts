import { registry } from "../MacroRegistry";

export function registerNamesMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "user",
    category: "Names",
    description: "Current user/persona name",
    returns: "The user's display name",
    returnType: "string",
    handler: (ctx) => ctx.env.names.user,
  });

  registry.registerMacro({
    builtIn: true,
    name: "char",
    category: "Names",
    description: "Current character name",
    returns: "The character's name",
    returnType: "string",
    aliases: ["charName"],
    handler: (ctx) => ctx.env.names.char,
  });

  registry.registerMacro({
    builtIn: true,
    name: "group",
    category: "Names",
    description: "Comma-separated list of group member names",
    returnType: "string",
    handler: (ctx) => ctx.env.names.group,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupNotMuted",
    category: "Names",
    description: "Comma-separated list of non-muted group member names",
    returnType: "string",
    aliases: ["group_not_muted"],
    handler: (ctx) => ctx.env.names.groupNotMuted,
  });

  registry.registerMacro({
    builtIn: true,
    name: "notChar",
    category: "Names",
    description: "Name of the not-character (usually the user)",
    returnType: "string",
    aliases: ["not_char"],
    handler: (ctx) => ctx.env.names.notChar,
  });

  // ---- Group chat macros ----

  registry.registerMacro({
    builtIn: true,
    name: "charGroupFocused",
    category: "Names",
    description: "Name of the focused/target character in a group chat. Empty in non-group chats.",
    returnType: "string",
    aliases: ["charFocused", "char_group_focused"],
    handler: (ctx) => ctx.env.names.charGroupFocused,
  });

  registry.registerMacro({
    builtIn: true,
    name: "isGroupChat",
    category: "Names",
    description: "Whether the current chat is a group chat",
    returns: "\"yes\" or \"no\"",
    returnType: "string",
    aliases: ["is_group_chat"],
    handler: (ctx) => ctx.env.names.isGroupChat,
  });

  registry.registerMacro({
    builtIn: true,
    name: "isNarrator",
    category: "Names",
    description: "Whether the active persona is a narrator (not a self-insert)",
    returns: "\"yes\" or \"no\"",
    returnType: "string",
    aliases: ["is_narrator"],
    handler: (ctx) => ctx.env.names.isNarrator,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupOthers",
    category: "Names",
    description: "Comma-separated group member names excluding the focused character. Empty in non-group chats.",
    returnType: "string",
    aliases: ["group_others"],
    handler: (ctx) => ctx.env.names.groupOthers,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupMemberCount",
    category: "Names",
    description: "Number of characters in the group chat. \"0\" in non-group chats.",
    returnType: "string",
    aliases: ["group_member_count"],
    handler: (ctx) => ctx.env.names.groupMemberCount,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupLastSpeaker",
    category: "Names",
    description: "Name of the last non-user character who spoke. Empty if none or non-group chat.",
    returnType: "string",
    aliases: ["group_last_speaker"],
    handler: (ctx) => ctx.env.names.groupLastSpeaker,
  });

  registry.registerMacro({
    builtIn: true,
    name: "groupCardMode",
    category: "Names",
    description: "Card composition mode for the active chat.",
    returns: "\"solo\" | \"swap\" | \"merge\" | \"merge_ignore_muted\"",
    returnType: "string",
    aliases: ["group_card_mode"],
    handler: (ctx) => ctx.env.names.groupCardMode,
  });
}

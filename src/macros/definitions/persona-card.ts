import { registry } from "../MacroRegistry";

export function registerCharacterMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "description",
    category: "Character",
    description: "Character description",
    returnType: "string",
    aliases: ["charDescription"],
    handler: (ctx) => ctx.env.character.description,
  });

  registry.registerMacro({
    builtIn: true,
    name: "personality",
    category: "Character",
    description: "Character personality",
    returnType: "string",
    aliases: ["charPersonality"],
    handler: (ctx) => ctx.env.character.personality,
  });

  registry.registerMacro({
    builtIn: true,
    name: "scenario",
    category: "Character",
    description: "Character scenario",
    returnType: "string",
    aliases: ["charScenario"],
    handler: (ctx) => ctx.env.character.scenario,
  });

  registry.registerMacro({
    builtIn: true,
    name: "persona",
    category: "Character",
    description: "User persona description",
    returnType: "string",
    aliases: ["userPersona"],
    handler: (ctx) => ctx.env.character.persona,
  });

  registry.registerMacro({
    builtIn: true,
    name: "mesExamples",
    category: "Character",
    description: "Character example dialogue messages",
    returnType: "string",
    aliases: ["mes_examples", "exampleMessages"],
    handler: (ctx) => ctx.env.character.mesExamples,
  });

  registry.registerMacro({
    builtIn: true,
    name: "mesExamplesRaw",
    category: "Character",
    description: "Raw example dialogue (unprocessed)",
    returnType: "string",
    handler: (ctx) => ctx.env.character.mesExamplesRaw,
  });

  registry.registerMacro({
    builtIn: true,
    name: "system",
    category: "Character",
    description: "Character system prompt",
    returnType: "string",
    aliases: ["charPrompt", "charSystem"],
    handler: (ctx) => ctx.env.character.systemPrompt,
  });

  registry.registerMacro({
    builtIn: true,
    name: "charPostHistoryInstructions",
    category: "Character",
    description: "Character jailbreak/post-history instructions",
    returnType: "string",
    aliases: ["charInstruction", "jailbreak", "charJailbreak"],
    handler: (ctx) => ctx.env.character.postHistoryInstructions,
  });

  registry.registerMacro({
    builtIn: true,
    name: "charDepthPrompt",
    category: "Character",
    description: "Character depth prompt (extension)",
    returnType: "string",
    aliases: ["depth_prompt"],
    handler: (ctx) => ctx.env.character.depthPrompt,
  });

  registry.registerMacro({
    builtIn: true,
    name: "charCreatorNotes",
    category: "Character",
    description: "Character creator notes",
    returnType: "string",
    aliases: ["creatorNotes"],
    handler: (ctx) => ctx.env.character.creatorNotes,
  });

  registry.registerMacro({
    builtIn: true,
    name: "charVersion",
    category: "Character",
    description: "Character card version",
    returnType: "string",
    handler: (ctx) => ctx.env.character.version,
  });

  registry.registerMacro({
    builtIn: true,
    name: "charCreator",
    category: "Character",
    description: "Character creator name",
    returnType: "string",
    handler: (ctx) => ctx.env.character.creator,
  });

  registry.registerMacro({
    builtIn: true,
    name: "firstMessage",
    category: "Character",
    description: "Character's first message / greeting",
    returnType: "string",
    aliases: ["firstMes", "first_message"],
    handler: (ctx) => ctx.env.character.firstMessage,
  });

  registry.registerMacro({
    builtIn: true,
    name: "original",
    category: "Character",
    description: "Alias for character description (original card text)",
    returnType: "string",
    handler: (ctx) => ctx.env.character.description,
  });
}

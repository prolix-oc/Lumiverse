/**
 * Loom system macros — Lumiverse narrative engine.
 *
 * All macros read from ctx.env.extra which is populated by prompt-assembly.service.ts
 * before the assembly loop. The data shape is:
 *
 *   env.extra.loom          – summary
 *   env.extra.sovereignHand – enabled, excludeLastMessage, includeMessageInPrompt
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSovereign(ctx: MacroExecContext) {
  return (ctx.env.extra.sovereignHand ?? {
    enabled: false,
    excludeLastMessage: true,
    includeMessageInPrompt: true,
  }) as {
    enabled: boolean;
    excludeLastMessage: boolean;
    includeMessageInPrompt: boolean;
  };
}

function getLoom(ctx: MacroExecContext) {
  return (ctx.env.extra.loom ?? {}) as {
    summary: string;
    selectedStyles?: any[];
    selectedUtils?: any[];
    selectedRetrofits?: any[];
  };
}

/** Check if the last message in the chat was from the character (not user). */
function wasCharacterLastSpeaker(ctx: MacroExecContext): boolean {
  // lastMessageName is populated, but we need to know if it was a user message.
  // We rely on the fact that lastCharMessage is populated AND is the same as lastMessage.
  const last = ctx.env.chat.lastMessage;
  const lastChar = ctx.env.chat.lastCharMessage;
  return !!last && last === lastChar;
}

// ---------------------------------------------------------------------------
// Sovereign Hand prompt builders
// ---------------------------------------------------------------------------

function buildSovereignHandPrompt(ctx: MacroExecContext): string {
  const sov = getSovereign(ctx);
  if (!sov.enabled) return "";

  const userName = ctx.env.names.user || "the user";
  const charName = ctx.env.names.char || "the character";
  const lastUserMsg = ctx.env.chat.lastUserMessage;
  const charWasLast = wasCharacterLastSpeaker(ctx);

  const lines: string[] = [];

  lines.push("## Sovereign Hand — Co-Pilot Mode\n");
  lines.push("You are operating under the Sovereign Hand directive. The user's message is a **divine mandate** — an authorial instruction from outside the narrative.\n");

  lines.push("### Core Principles:");
  lines.push("1. **Interpret, don't transcribe.** The user's words are stage directions, not dialogue. Transform their intent into narrative action.");
  lines.push(`2. **${userName} is the author.** Their message describes what should happen — you make it happen with prose, character voice, and scene-craft.`);
  lines.push("3. **Maintain narrative continuity.** Everything should feel like a natural extension of the story, not a sudden break.");
  lines.push(`4. **${charName} acts on the directive** as if the impulse came from within the story world.\n`);

  // User message section
  if (sov.includeMessageInPrompt && lastUserMsg && !charWasLast) {
    lines.push("### Primary Directive:\n");
    lines.push(`> ${lastUserMsg}\n`);

    if (!sov.excludeLastMessage) {
      lines.push("*Note: This message also appears in the chat history. Do NOT duplicate it — the above is the authoritative version.*\n");
    }
  }

  // Continuation mode
  if (charWasLast) {
    lines.push("### Continuation Mode\n");
    lines.push(`${charName} was the last speaker. Continue the narrative naturally from where it left off.`);
    lines.push(`- Maintain ${charName}'s voice and the scene's momentum.`);
    lines.push("- Advance the plot or deepen the current moment.");
    lines.push("- Do NOT repeat or rephrase the last message.\n");
  }

  return lines.join("\n");
}

function buildContinuePrompt(ctx: MacroExecContext): string {
  const sov = getSovereign(ctx);
  if (!sov.enabled) return "";
  if (!wasCharacterLastSpeaker(ctx)) return "";

  const charName = ctx.env.names.char || "the character";

  return `## Continuation

${charName} was the last to speak. Continue the narrative from their perspective:
- Pick up exactly where the last message left off.
- Maintain the same tone, pacing, and voice.
- Advance the scene — don't stall or repeat.`;
}

// ---------------------------------------------------------------------------
// Summary directive prompt
// ---------------------------------------------------------------------------

function buildSummaryDirectivePrompt(ctx: MacroExecContext): string {
  const userName = ctx.env.names.user || "the user";
  const charName = ctx.env.names.char || "the character";

  return `<loom_summary_directive>
## LOOM SUMMARY DIRECTIVE

<context>You are reviewing the story so far to create a structured summary that will serve as persistent memory across future generations.</context>

<sections>

### 1. Completed Story Beats
Events, scenes, or character moments that have fully concluded. Record key outcomes and consequences.

### 2. Ongoing Story Beats
Active plot threads, unresolved conflicts, and scenes currently in progress. Note the current state and momentum.

### 3. Looming Elements
Foreshadowed events, Chekhov's guns, unresolved tensions, and narrative seeds that haven't yet bloomed. These are story elements that may become important later.

### 4. Current Scene Context
The immediate setting, time of day, atmosphere, and what's physically happening right now.

### 5. Character Status
**${charName}:** Current emotional state, physical condition, goals, and relationship dynamics.
**${userName}:** Last known actions, stated intentions, and emotional tone.

</sections>

<format>
- Use concise, information-dense prose.
- Prioritize story-critical details over flavor text.
- Wrap your entire summary in \`<loom_sum>\` tags.
- The summary replaces the previous one entirely — include everything important.
</format>
</loom_summary_directive>`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLoomMacros(): void {
  // ---- loomSummary ----
  registry.registerMacro({
    builtIn: true,
    name: "loomSummary",
    category: "Loom",
    description: "Stored Loom summary from chat metadata (from most recent <loom_sum> block).",
    returnType: "string",
    handler: (ctx) => {
      const loom = getLoom(ctx);
      return loom.summary || "";
    },
  });

  // ---- loomSummaryPrompt ----
  registry.registerMacro({
    builtIn: true,
    name: "loomSummaryPrompt",
    category: "Loom",
    description: "Loom summarization directive prompt with section structure.",
    returnType: "string",
    handler: (ctx) => buildSummaryDirectivePrompt(ctx),
  });

  // ---- loomLastUserMessage ----
  registry.registerMacro({
    builtIn: true,
    name: "loomLastUserMessage",
    category: "Loom",
    description: "Last user message content (alias for lastUserMessage).",
    returnType: "string",
    handler: (ctx) => ctx.env.chat.lastUserMessage || "",
  });

  // ---- loomSovHandActive ----
  registry.registerMacro({
    builtIn: true,
    name: "loomSovHandActive",
    category: "Loom",
    description: "Returns 'yes' or 'no' for Sovereign Hand mode. Conditional compatible.",
    returnType: "boolean",
    handler: (ctx) => {
      const sov = getSovereign(ctx);
      return sov.enabled ? "yes" : "no";
    },
  });

  // ---- lastMessageName (alias — may already exist in chat macros) ----
  // Registered as loom-scoped alias for clarity
  registry.registerMacro({
    builtIn: true,
    name: "loomLastMessageName",
    category: "Loom",
    description: "Name of whoever sent the last message (alias for lastMessageName).",
    returnType: "string",
    aliases: [],
    handler: (ctx) => ctx.env.chat.lastMessageName || "",
  });

  // ---- loomLastCharMessage ----
  registry.registerMacro({
    builtIn: true,
    name: "loomLastCharMessage",
    category: "Loom",
    description: "Content of last character/assistant message (alias for lastCharMessage).",
    returnType: "string",
    handler: (ctx) => ctx.env.chat.lastCharMessage || "",
  });

  // ---- loomContinuePrompt ----
  registry.registerMacro({
    builtIn: true,
    name: "loomContinuePrompt",
    category: "Loom",
    description: "Continuation instructions when Sovereign Hand is enabled and character was last speaker. Empty otherwise.",
    returnType: "string",
    handler: (ctx) => buildContinuePrompt(ctx),
  });

  // ---- loomSovHand ----
  registry.registerMacro({
    builtIn: true,
    name: "loomSovHand",
    category: "Loom",
    description: "Full Sovereign Hand co-pilot mode prompt. Includes user directive interpretation and continuation logic.",
    returnType: "string",
    handler: (ctx) => buildSovereignHandPrompt(ctx),
  });
}

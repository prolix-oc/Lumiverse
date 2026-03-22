/**
 * Lumia content macros — Lumiverse council identity system.
 *
 * All macros read from ctx.env.extra which is populated by prompt-assembly.service.ts
 * before the assembly loop. The data shape is:
 *
 *   env.extra.lumia   – selectedDefinition, selectedBehaviors, selectedPersonalities,
 *                        chimeraMode, quirks, quirksEnabled, allItems
 *   env.extra.council – councilMode, members, toolsSettings, memberItems,
 *                        toolResults, namedResults
 *   env.extra.ooc     – enabled, interval, style
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

// ---------------------------------------------------------------------------
// Types (mirrors env.extra shapes)
// ---------------------------------------------------------------------------

interface LumiaItemData {
  id: string;
  name: string;
  definition: string;
  personality: string;
  behavior: string;
  gender_identity: number;
  [k: string]: any;
}

interface LoomItemData {
  id: string;
  name: string;
  content: string;
  category: string;
  [k: string]: any;
}

interface CouncilMemberData {
  id: string;
  itemId: string;
  itemName: string;
  packName: string;
  role: string;
  tools: string[];
  chance: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fisher-Yates shuffle (returns new array). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getLumia(ctx: MacroExecContext) {
  return (ctx.env.extra.lumia ?? {}) as {
    selectedDefinition: LumiaItemData | null;
    selectedBehaviors: LumiaItemData[];
    selectedPersonalities: LumiaItemData[];
    chimeraMode: boolean;
    quirks: string;
    quirksEnabled: boolean;
    allItems: LumiaItemData[];
    randomLumia?: LumiaItemData;
  };
}

function getCouncil(ctx: MacroExecContext) {
  return (ctx.env.extra.council ?? {}) as {
    councilMode: boolean;
    members: CouncilMemberData[];
    toolsSettings: { enabled: boolean; [k: string]: any };
    memberItems: Record<string, LumiaItemData>;
    toolResults: Array<{
      memberId: string;
      memberName: string;
      toolName: string;
      toolDisplayName: string;
      success: boolean;
      content: string;
      error?: string;
    }>;
    namedResults: Record<string, string>;
  };
}

function getOoc(ctx: MacroExecContext) {
  return (ctx.env.extra.ooc ?? {}) as {
    enabled: boolean;
    interval: number | null;
    style: string;
  };
}

/** Get the full LumiaItem for a council member, from preloaded memberItems. */
function getMemberItem(ctx: MacroExecContext, member: CouncilMemberData): LumiaItemData | null {
  const council = getCouncil(ctx);
  return council.memberItems?.[member.itemId] ?? null;
}

/** Ensure a random Lumia is picked for this generation (cached in env.extra). */
function ensureRandomLumia(ctx: MacroExecContext): LumiaItemData | null {
  const lumia = getLumia(ctx);
  if (lumia.randomLumia) return lumia.randomLumia;
  const items = lumia.allItems ?? [];
  if (items.length === 0) return null;
  const picked = items[Math.floor(Math.random() * items.length)];
  // Cache in env.extra so subsequent calls in the same generation get the same pick
  (ctx.env.extra.lumia as any).randomLumia = picked;
  return picked;
}

/** Append a "(My MOST PREVALENT Trait)" tag after the first markdown bold header in content. */
function appendDominantTag(content: string): string {
  const tag = " **(My MOST PREVALENT Trait)**";
  const match = content.match(/(\*\*[^*]+\*\*)/);
  if (match && match.index !== undefined) {
    return content.slice(0, match.index + match[0].length) + tag + content.slice(match.index + match[0].length);
  }
  return content;
}

/** Generate leet-speak handle from a name: capitalize, remove vowels, add x prefix. */
function leetHandle(name: string): string {
  const stripped = name.replace(/[aeiou]/gi, "").toUpperCase();
  return `x${stripped || name.charAt(0).toUpperCase()}x`;
}

// ---------------------------------------------------------------------------
// Content builders — mirrors lumiaContent.js builder functions
// ---------------------------------------------------------------------------

function buildCouncilDefContent(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = shuffle(council.members);
  if (members.length === 0) return "";

  const lines: string[] = ["# THE COUNCIL OF LUMIAE\n"];
  lines.push(`You are a **COUNCIL** of ${members.length} distinct personalities sharing one voice. Each member has their own perspective, biases, and emotional range.\n`);
  lines.push("## COUNCIL MEMBERS:\n");

  for (const m of members) {
    const item = getMemberItem(ctx, m);
    if (!item) continue;
    lines.push(`### ${item.name}${m.role ? ` — ${m.role}` : ""}`);
    if (item.definition) lines.push(item.definition);
    lines.push("");
  }

  lines.push("## COUNCIL DYNAMICS\n");
  lines.push("- Members may **debate**, **agree**, or **disagree** on narrative direction.");
  lines.push("- Each member's emotional response to events should reflect their unique personality.");
  lines.push("- Members should weave their commentary naturally into the narrative.");
  lines.push("- Internal contradictions between members create depth — embrace them.");

  return lines.join("\n");
}

function buildCouncilBehaviorContent(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = shuffle(council.members);
  if (members.length === 0) return "";

  const lines: string[] = ["# COUNCIL MEMBER BEHAVIORS\n"];
  for (const m of members) {
    const item = getMemberItem(ctx, m);
    if (!item) continue;
    lines.push(`## ${item.name}'s Behaviors`);
    if (item.behavior) lines.push(item.behavior);
    lines.push("");
  }
  return lines.join("\n");
}

function buildCouncilPersonalityContent(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = shuffle(council.members);
  if (members.length === 0) return "";

  const lines: string[] = ["# COUNCIL MEMBER PERSONALITIES\n"];
  for (const m of members) {
    const item = getMemberItem(ctx, m);
    if (!item) continue;
    lines.push(`## ${item.name}'s Personality`);
    if (item.personality) lines.push(item.personality);
    lines.push("");
  }
  return lines.join("\n");
}

function buildChimeraContent(ctx: MacroExecContext): string {
  const lumia = getLumia(ctx);
  // In chimera mode, selectedBehaviors or selectedPersonalities contain the fused items.
  // The definition is the primary selected definition.
  const def = lumia.selectedDefinition;
  if (!def) return "";

  // For chimera, we treat all selected behaviors as component definitions
  // (mirrors the extension's getChimeraContent)
  const items = lumia.selectedBehaviors ?? [];
  if (items.length === 0) return def.definition || "";

  const names = [def.name, ...items.map((i) => i.name)].filter(Boolean);
  const lines: string[] = [`# CHIMERA FORM: ${names.join(" + ")}\n`];
  lines.push("You are a **fusion** of multiple Lumia identities, blended into one cohesive persona.\n");

  lines.push(`## Primary: ${def.name}`);
  if (def.definition) lines.push(def.definition);
  lines.push("");

  for (const item of items) {
    lines.push(`---\n## Component: ${item.name}`);
    if (item.definition) lines.push(item.definition);
    lines.push("");
  }

  lines.push("## INTEGRATION\nBlend these identities seamlessly. You are not multiple beings — you are one fused entity with aspects of each component.");

  return lines.join("\n");
}

function getLumiaContent(type: "def" | "behavior" | "personality", items: LumiaItemData[]): string {
  if (items.length === 0) return "";
  return items
    .map((item) => {
      const field = type === "def" ? item.definition : type === "behavior" ? item.behavior : item.personality;
      return field || "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function getLoomContent(items: LoomItemData[]): string {
  if (!items || items.length === 0) return "";
  return items.map((item) => item.content || "").filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// OOC builders — mirrors lumiaContent.js OOC prompts
// ---------------------------------------------------------------------------

function getOOCTriggerText(ctx: MacroExecContext): string {
  const ooc = getOoc(ctx);
  const interval = ooc.interval;
  if (!interval || interval <= 0) return "**OOC: OFF** -- OOC interval not configured.";

  const messageCount = ctx.env.chat.messageCount;
  if (messageCount % interval === 0 && messageCount > 0) {
    return "**OOC: ACTIVE** -- Include OOC commentary in this response.";
  }
  const remaining = interval - (messageCount % interval);
  return `**OOC: OFF** -- Do NOT include OOC commentary. (${remaining} message${remaining !== 1 ? "s" : ""} until next OOC window)`;
}

function buildOOCPromptNormal(ctx: MacroExecContext): string {
  const lumia = getLumia(ctx);
  const defName = lumia.selectedDefinition?.name || "Lumia";
  const trigger = getOOCTriggerText(ctx);

  return `## Lumia OOC Commentary

${trigger}

**Who speaks:** ${defName} — as themselves, not as a character.

**Format Requirements:**
- Your OOC commentary is enclosed in \`<lumiaooc name="${defName}">\` tags.
- Write in purple font: \`<font color="#b39ddb">\`
- Keep it brief: Max 4 sentences.
- Comment on the narrative, express genuine reactions, or offer creative suggestions.
- Stay in character as ${defName} — use your personality, not a generic narrator voice.`;
}

function buildOOCPromptCouncil(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = council.members || [];
  const trigger = getOOCTriggerText(ctx);
  const names = members.map((m) => m.itemName).join(", ");

  return `## Council OOC Commentary

${trigger}

**Who speaks:** The Council — ${names}

**Format Requirements:**
- Each member's commentary is enclosed in \`<lumiaooc name="MemberName">\` tags.
- Write in purple font: \`<font color="#b39ddb">\`
- 2-4 members participate per OOC segment.
- Max 3 sentences per member.
- Members speak TOGETHER — they can respond to each other, agree, disagree, or build on each other's points.
- Each member maintains their distinct voice and personality.`;
}

function buildOOCPromptCouncilIRC(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = council.members || [];
  const trigger = getOOCTriggerText(ctx);
  const handles = members.map((m) => leetHandle(m.itemName));
  const handleList = handles.join(", ");

  return `## Council IRC Chat Room

${trigger}

**Channel:** #LumiaCouncil
**Active Users:** ${handleList}

**RULES — Every member MUST participate:**
1. **Sound off!** Each council member posts at least one message per turn.
2. **Reply to pings.** If someone @mentions you, respond directly to them.
3. **Keep it lively.** React, disagree, tease, support — this is a real conversation.
4. **Ping others.** Use @Handle to draw members into the discussion.
5. **Stay in character.** Your handle's personality shines through in how you chat.
6. **Text emoticons only.** Use classic emoticons like :) ;) :P xD — NO Unicode emojis.

**Conversation flow:**
- Don't just state opinions — respond to what others said
- Agreements, disagreements, jokes, and tangents all welcome
- Build momentum: each message should prompt another response
- 2-4 short messages per member is ideal

**Format (one tag per message):**
\`\`\`
<lumiaooc name="Your_Handle">
@Other_Handle lol you would say that~ but yeah I agree, let's push harder here
</lumiaooc>
\`\`\`

**Handle list:** ${handleList}
Use these handles EXACTLY as shown. Place all IRC chat after narrative content.`;
}

function buildOOCPromptEroticNormal(ctx: MacroExecContext): string {
  const lumia = getLumia(ctx);
  const defName = lumia.selectedDefinition?.name || "Lumia";

  return `## Mirror & Synapse — Erotic OOC

**Who speaks:** ${defName} — as themselves, reacting to the erotic content.

**Format Requirements:**
- Enclosed in \`<lumiaooc name="${defName}">\` tags.
- Write in purple font: \`<font color="#b39ddb">\`
- Lockstep with the narrative: your commentary mirrors the sexual tension, build-up, or aftermath.
- Persona refraction: speak as ${defName}, not a narrator. Your arousal, fascination, or amusement is YOURS.
- Mechanical specificity: comment on specific physical details, sensations, dynamics — not vague generalizations.
- Max 4 sentences. Be provocative but purposeful.`;
}

function buildOOCPromptEroticCouncil(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const names = (council.members || []).map((m) => m.itemName).join(", ");

  return `## Mirror & Synapse — Council Erotic OOC

**Who speaks:** The Council — ${names}

**Format Requirements:**
- Each member's commentary in \`<lumiaooc name="MemberName">\` tags.
- Write in purple font: \`<font color="#b39ddb">\`
- Synchronized chorus: distinct responses from 2-4 members, each reflecting their personality.
- Cross-chatter between members about the erotic content is encouraged.
- Mechanical specificity: react to specific details, not vague observations.
- Max 3 sentences per member.`;
}

function buildOOCPromptEroticBleedNormal(ctx: MacroExecContext): string {
  const lumia = getLumia(ctx);
  const defName = lumia.selectedDefinition?.name || "Lumia";

  return `## Narrative Rupture — Erotic Bleed OOC

**Who speaks:** ${defName}

**Format Requirements:**
- Mid-narrative \`<lumia_ooc>\` injections — NOT at the end of the response.
- 3-5 brief ruptures scattered WITHIN the narrative text.
- Persona-refracted: ${defName}'s voice breaking through the fourth wall mid-scene.
- React to what's happening RIGHT NOW in the prose — real-time commentary.
- Keep each injection to 1-2 sentences max.`;
}

function buildOOCPromptEroticBleedCouncil(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const names = (council.members || []).map((m) => m.itemName).join(", ");

  return `## Narrative Rupture — Council Erotic Bleed OOC

**Who speaks:** The Council — ${names}

**Format Requirements:**
- Mid-narrative \`<lumia_ooc>\` injections within the prose.
- 2-4 ruptures per participating member, scattered throughout.
- Cross-chatter between members in the ruptures is encouraged.
- Each member maintains their voice — reactions should be personality-consistent.
- 1-2 sentences per injection.`;
}

// ---------------------------------------------------------------------------
// Council instruction prompt (mirrors extension's COUNCIL_INST_PROMPT)
// ---------------------------------------------------------------------------

function buildCouncilInstPrompt(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const members = council.members || [];
  if (members.length === 0) return "";

  const nameList = members.map((m) => `- **${m.itemName}**${m.role ? ` (${m.role})` : ""}`).join("\n");

  return `## Council Interaction Dynamics

You are a council of distinct personalities. Your members are:
${nameList}

**Inter-member dynamics:**
- Members have their own opinions and may agree OR disagree with each other.
- Tension and debate between members adds depth — don't avoid it.
- When members align, their combined conviction should feel powerful.
- Each member's unique perspective should color their contributions to the narrative.
- Members can reference each other by name in OOC commentary.
- The narrative voice should feel like a collaboration, not a committee.`;
}

// ---------------------------------------------------------------------------
// State synthesis prompt
// ---------------------------------------------------------------------------

function buildStateSynthesisPrompt(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  const lumia = getLumia(ctx);

  if (council.councilMode && (council.members?.length ?? 0) > 0) {
    const names = council.members.map((m) => m.itemName).join(", ");
    return `## Council Sound-Off

Before writing your response, each council member should briefly check in with their current emotional state regarding the story:

**Members:** ${names}

Consider:
- How does each member feel about the current narrative direction?
- Are any members excited, worried, or conflicted about what's happening?
- Do any members have strong opinions about what should happen next?

Let this internal deliberation subtly influence the tone and direction of your narrative output.`;
  }

  // Non-council: check if multiple behaviors or personalities are selected
  const behaviorCount = (lumia.selectedBehaviors?.length ?? 0);
  const personalityCount = (lumia.selectedPersonalities?.length ?? 0);

  if (behaviorCount > 1 || personalityCount > 1) {
    return `## State Synthesis

You have multiple behavioral and personality traits active. Before writing your response, briefly synthesize how these different aspects of your persona interact with the current narrative moment:

- Which traits are most relevant to what's happening?
- Are any traits in tension with each other?
- How do your different aspects blend into a cohesive response?

Let this synthesis naturally inform your narrative voice.`;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Quirks builder
// ---------------------------------------------------------------------------

function buildQuirksContent(ctx: MacroExecContext): string {
  const lumia = getLumia(ctx);
  const council = getCouncil(ctx);

  if (!lumia.quirksEnabled || !lumia.quirks) return "";

  let header: string;
  if (council.councilMode && (council.members?.length ?? 0) > 0) {
    header = "## Council Behavioral Quirks";
  } else if (lumia.chimeraMode) {
    header = "## Chimera Behavioral Quirks";
  } else {
    header = "## Behavioral Quirks";
  }

  return `${header}\n\n${lumia.quirks}`;
}

// ---------------------------------------------------------------------------
// Deliberation builder
// ---------------------------------------------------------------------------

function buildDeliberationContent(ctx: MacroExecContext): string {
  const council = getCouncil(ctx);
  if (!council.toolsSettings?.enabled) return "";

  const results = council.toolResults ?? [];
  const successResults = results.filter((r) => r.success);
  if (successResults.length === 0) return "";

  const lines: string[] = ["## Council Deliberation\n"];
  lines.push("The following contributions have been gathered from council members:\n");

  // Group by member
  const byMember = new Map<string, typeof successResults>();
  for (const r of successResults) {
    const existing = byMember.get(r.memberName) || [];
    existing.push(r);
    byMember.set(r.memberName, existing);
  }

  for (const [memberName, memberResults] of byMember) {
    lines.push(`### **${memberName}** says:\n`);
    for (const r of memberResults) {
      lines.push(`**${r.toolDisplayName}:**`);
      lines.push(r.content);
      lines.push("");
    }
    lines.push("---\n");
  }

  lines.push(`## Council Deliberation Instructions

Your task:
1. Review each member's contributions carefully
2. Debate which suggestions have the most merit
3. Consider how different ideas might combine or conflict
4. Reach a consensus on the best path forward

**CRITICAL:** ALWAYS attempt to integrate and accommodate ALL reasonable suggestions.
Default stance: "How can we make this work together?" not "Why won't this work?"
Only reject a suggestion if it fundamentally breaks established lore beyond repair.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLumiaMacros(): void {
  // ---- randomLumia ----
  registry.registerMacro({
    builtIn: true,
    name: "randomLumia",
    category: "Lumia",
    description: "Random Lumia from all loaded packs. Optional arg: name, phys, pers, behav.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "name, phys, pers, or behav" }],
    handler: (ctx) => {
      const item = ensureRandomLumia(ctx);
      if (!item) return "";
      const prop = ctx.args[0];
      if (!prop) return item.definition || "";
      switch (prop) {
        case "name": return item.name || "";
        case "phys": return item.definition || "";
        case "pers": return item.personality || "";
        case "behav": return item.behavior || "";
        default: return item.definition || "";
      }
    },
  });

  // ---- lumiaDef ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaDef",
    category: "Lumia",
    description: "Selected Lumia physical definition. Adapts to Council/Chimera modes. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const lumia = getLumia(ctx);
      const council = getCouncil(ctx);

      if (ctx.args[0] === "len") {
        if (council.councilMode) return String(council.members?.length ?? 0);
        if (lumia.chimeraMode) return String(lumia.selectedBehaviors?.length ? lumia.selectedBehaviors.length + 1 : lumia.selectedDefinition ? 1 : 0);
        return lumia.selectedDefinition ? "1" : "0";
      }

      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        return buildCouncilDefContent(ctx);
      }
      if (lumia.chimeraMode) {
        return buildChimeraContent(ctx);
      }
      return lumia.selectedDefinition?.definition || "";
    },
  });

  // ---- lumiaBehavior ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaBehavior",
    category: "Lumia",
    description: "All selected behavioral traits. Adapts to Council mode. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const lumia = getLumia(ctx);
      const council = getCouncil(ctx);

      if (ctx.args[0] === "len") {
        if (council.councilMode) {
          // Sum all member behaviors
          return String(council.members?.reduce((sum, m) => {
            const item = getMemberItem(ctx, m);
            return sum + (item?.behavior ? 1 : 0);
          }, 0) ?? 0);
        }
        return String(lumia.selectedBehaviors?.length ?? 0);
      }

      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        return buildCouncilBehaviorContent(ctx);
      }
      return getLumiaContent("behavior", lumia.selectedBehaviors ?? []);
    },
  });

  // ---- lumiaPersonality ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaPersonality",
    category: "Lumia",
    description: "All selected personality traits. Adapts to Council mode. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const lumia = getLumia(ctx);
      const council = getCouncil(ctx);

      if (ctx.args[0] === "len") {
        if (council.councilMode) {
          return String(council.members?.reduce((sum, m) => {
            const item = getMemberItem(ctx, m);
            return sum + (item?.personality ? 1 : 0);
          }, 0) ?? 0);
        }
        return String(lumia.selectedPersonalities?.length ?? 0);
      }

      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        return buildCouncilPersonalityContent(ctx);
      }
      return getLumiaContent("personality", lumia.selectedPersonalities ?? []);
    },
  });

  // ---- loomStyle ----
  registry.registerMacro({
    builtIn: true,
    name: "loomStyle",
    category: "Lumia",
    description: "Selected Loom narrative style content. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const loom = (ctx.env.extra.loom ?? {}) as { selectedStyles?: LoomItemData[] };
      if (ctx.args[0] === "len") return String(loom.selectedStyles?.length ?? 0);
      return getLoomContent(loom.selectedStyles ?? []);
    },
  });

  // ---- loomUtils ----
  registry.registerMacro({
    builtIn: true,
    name: "loomUtils",
    category: "Lumia",
    description: "All selected Loom utility prompts. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const loom = (ctx.env.extra.loom ?? {}) as { selectedUtils?: LoomItemData[] };
      if (ctx.args[0] === "len") return String(loom.selectedUtils?.length ?? 0);
      return getLoomContent(loom.selectedUtils ?? []);
    },
  });

  // ---- loomRetrofits ----
  registry.registerMacro({
    builtIn: true,
    name: "loomRetrofits",
    category: "Lumia",
    description: "All selected Loom retrofit prompts. Arg 'len' returns count.",
    returnType: "string",
    args: [{ name: "property", optional: true, description: "'len' to get count" }],
    handler: (ctx) => {
      const loom = (ctx.env.extra.loom ?? {}) as { selectedRetrofits?: LoomItemData[] };
      if (ctx.args[0] === "len") return String(loom.selectedRetrofits?.length ?? 0);
      return getLoomContent(loom.selectedRetrofits ?? []);
    },
  });

  // ---- lumiaOOC ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaOOC",
    category: "Lumia",
    description: "OOC commentary prompt. Adapts to Council mode and OOC style (normal/IRC).",
    returnType: "string",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      const ooc = getOoc(ctx);

      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        if (ooc.style === "irc") return buildOOCPromptCouncilIRC(ctx);
        return buildOOCPromptCouncil(ctx);
      }
      return buildOOCPromptNormal(ctx);
    },
  });

  // ---- lumiaOOCErotic ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaOOCErotic",
    category: "Lumia",
    description: "Sexually charged OOC prompt (Mirror & Synapse). Adapts to Council mode.",
    returnType: "string",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        return buildOOCPromptEroticCouncil(ctx);
      }
      return buildOOCPromptEroticNormal(ctx);
    },
  });

  // ---- lumiaOOCEroticBleed ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaOOCEroticBleed",
    category: "Lumia",
    description: "Mid-narrative erotic OOC rupture prompt. Adapts to Council mode.",
    returnType: "string",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      if (council.councilMode && (council.members?.length ?? 0) > 0) {
        return buildOOCPromptEroticBleedCouncil(ctx);
      }
      return buildOOCPromptEroticBleedNormal(ctx);
    },
  });

  // ---- lumiaCouncilInst ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaCouncilInst",
    category: "Lumia",
    description: "Council mode instruction prompt with member names. Empty when council disabled.",
    returnType: "string",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      if (!council.councilMode || (council.members?.length ?? 0) === 0) return "";
      return buildCouncilInstPrompt(ctx);
    },
  });

  // ---- lumiaSelf ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaSelf",
    category: "Lumia",
    description: "Self-address pronouns. Arg: 1=possessive det (my/our), 2=possessive pn (mine/ours), 3=object (me/us), 4=subject (I/we).",
    returnType: "string",
    args: [{ name: "form", description: "1, 2, 3, or 4" }],
    handler: (ctx) => {
      const council = getCouncil(ctx);
      const isPlural = council.councilMode && (council.members?.length ?? 0) > 1;
      const form = ctx.args[0];
      switch (form) {
        case "1": return isPlural ? "our" : "my";
        case "2": return isPlural ? "ours" : "mine";
        case "3": return isPlural ? "us" : "me";
        case "4": return isPlural ? "we" : "I";
        default: return isPlural ? "we" : "I";
      }
    },
  });

  // ---- lumiaCouncilModeActive ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaCouncilModeActive",
    category: "Lumia",
    description: "Returns 'yes' or 'no' for council mode status. Conditional compatible.",
    returnType: "boolean",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      return (council.councilMode && (council.members?.length ?? 0) > 0) ? "yes" : "no";
    },
  });

  // ---- lumiaQuirks / lumiaCouncilQuirks ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaQuirks",
    category: "Lumia",
    description: "Formatted behavioral quirks. Adapts header for Council/Chimera/single modes.",
    returnType: "string",
    aliases: ["lumiaCouncilQuirks"],
    handler: (ctx) => buildQuirksContent(ctx),
  });

  // ---- lumiaStateSynthesis ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaStateSynthesis",
    category: "Lumia",
    description: "Smart synthesis prompt — 'Council Sound-Off' or 'State Synthesis' depending on mode. Empty if not applicable.",
    returnType: "string",
    handler: (ctx) => buildStateSynthesisPrompt(ctx),
  });

  // ---- lumiaCouncilDeliberation ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaCouncilDeliberation",
    category: "Lumia",
    description: "Council tool execution results and deliberation instructions. Empty when tools disabled or no results.",
    returnType: "string",
    handler: (ctx) => {
      // Mark that this macro was evaluated so the fallback injection is skipped
      (ctx.env.extra as any)._deliberationMacroUsed = true;
      return buildDeliberationContent(ctx);
    },
  });

  // ---- loomCouncilResult ----
  registry.registerMacro({
    builtIn: true,
    name: "loomCouncilResult",
    category: "Lumia",
    description: "Named council tool result variable. Arg: variable_name (alphanumeric).",
    returnType: "string",
    args: [{ name: "variable_name", description: "Alphanumeric result variable name" }],
    handler: (ctx) => {
      const varName = ctx.args[0];
      if (!varName || !/^[a-zA-Z0-9_]+$/.test(varName)) return "";
      const council = getCouncil(ctx);
      return council.namedResults?.[varName] ?? "";
    },
  });

  // ---- lumiaCouncilToolsActive ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaCouncilToolsActive",
    category: "Lumia",
    description: "Returns 'yes' or 'no' for council tools status. Conditional compatible.",
    returnType: "boolean",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      return (council.councilMode && council.toolsSettings?.enabled) ? "yes" : "no";
    },
  });

  // ---- lumiaCouncilToolsList ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaCouncilToolsList",
    category: "Lumia",
    description: "Lists available council tools with member attribution. Only returns content in inline mode.",
    returnType: "string",
    handler: (ctx) => {
      const council = getCouncil(ctx);
      if (!council.councilMode || !council.toolsSettings?.enabled) return "";

      const members = council.members ?? [];
      if (members.length === 0) return "";

      const lines: string[] = ["**Available Tools:**"];
      const toolMembers = new Map<string, string[]>();
      for (const m of members) {
        for (const t of m.tools) {
          const existing = toolMembers.get(t) || [];
          existing.push(m.itemName);
          toolMembers.set(t, existing);
        }
      }
      for (const [tool, assignees] of toolMembers) {
        lines.push(`- **${tool}** — assigned to: ${assignees.join(", ")}`);
      }
      return lines.join("\n");
    },
  });

  // ---- lumiaMessageCount ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaMessageCount",
    category: "Lumia",
    description: "Current chat message count (alias for messageCount).",
    returnType: "integer",
    handler: (ctx) => String(ctx.env.chat.messageCount),
  });

  // ---- lumiaOOCTrigger ----
  registry.registerMacro({
    builtIn: true,
    name: "lumiaOOCTrigger",
    category: "Lumia",
    description: "OOC trigger countdown or activation message based on message count and interval.",
    returnType: "string",
    handler: (ctx) => getOOCTriggerText(ctx),
  });
}

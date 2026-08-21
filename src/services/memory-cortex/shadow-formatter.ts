/**
 * Memory Cortex — Shadow Prompt Formatter.
 *
 * Converts structured cortex data (entities, memories, relationships)
 * into narrative-register context that the LLM treats as internalized
 * knowledge rather than facts to recite.
 *
 * The core principle: the LLM mirrors the register of its context.
 * Give it bullet points, it writes bullet points.
 * Give it prose, it writes prose.
 *
 * Modes:
 *   "shadow"     — Narrative prose with "do not recite" instruction (default)
 *   "attributed" — Character-perspective memories with temporal distance
 *   "clinical"   — Original structured format (for lore-obsessed users)
 *   "minimal"    — Just memory chunks, no entity data
 */

import type {
  CortexMemory,
  EntitySnapshot,
  RelationEdge,
  VaultCortexData,
  InterlinkCortexData,
} from "./types";
import { formatEntitySnapshots as formatEntitySnapshotsClinical, formatRelationships as formatRelationshipsClinical } from "./entity-context";

// ─── Types ─────────────────────────────────────────────────────

export type FormatterMode = "shadow" | "attributed" | "clinical" | "minimal";

export interface FormatOptions {
  mode: FormatterMode;
  tokenBudget: number;
  currentSpeakerName?: string;
}

export interface ShadowPromptResult {
  text: string;
  tokensUsed: number;
  entitiesIncluded: number;
  memoriesIncluded: number;
  componentsIncluded: string[];
}

// ─── Token Estimation ──────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

// ─── Shadow Mode: Entities as Narrative Prose ──────────────────

function formatEntitiesShadow(
  snapshots: EntitySnapshot[],
  budget: number,
): string {
  if (snapshots.length === 0) return "";

  const parts: string[] = [];
  let used = 0;

  for (const snap of snapshots) {
    const lines: string[] = [];

    const statusNote = snap.status !== "active" ? ` (currently ${snap.status})` : "";
    let intro = `${snap.name} is a ${snap.type}${statusNote}`;
    if (snap.description) {
      intro += ` — ${snap.description}`;
    }
    lines.push(intro + ".");

    if (snap.topFacts.length > 0) {
      const factStr = snap.topFacts.join(". ");
      lines.push(factStr + (factStr.endsWith(".") ? "" : "."));
    }

    if (snap.relationships.length > 0) {
      const relParts = snap.relationships.map((r) => {
        const sentiment = r.sentiment > 0.3 ? "close" : r.sentiment < -0.3 ? "hostile" : "";
        const label = r.label || r.type;
        return sentiment
          ? `${sentiment} ${label} with ${r.targetName}`
          : `${label} with ${r.targetName}`;
      });
      lines.push(`Key connections: ${relParts.join("; ")}.`);
    }

    const block = lines.join(" ");
    const blockTokens = estimateTokens(block);
    if (used + blockTokens > budget) break;

    parts.push(block);
    used += blockTokens;
  }

  if (parts.length === 0) return "";

  return (
    "[Narrative context — weave naturally into the scene, never recite directly]\n" +
    "The story has established the following. Reference only when organic to the moment:\n\n" +
    parts.join("\n\n")
  );
}

// ─── Memory Formatting ─────────────────────────────────────────

function formatMemoriesShadow(
  memories: CortexMemory[],
  budget: number,
): string {
  if (memories.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const block = memory.source === "consolidation"
      ? `Scene continuity: ${memory.content.trim()}`
      : memory.content.trim();
    const tokens = estimateTokens(block);
    if (used + tokens > budget) break;
    parts.push(block);
    used += tokens;
  }
  if (parts.length === 0) return "";
  return (
    "[Relevant continuity — internalize and weave naturally; never recite this block]\n" +
    parts.join("\n\n")
  );
}

function formatMemoriesAttributed(
  memories: CortexMemory[],
  budget: number,
  speakerName?: string,
): string {
  if (memories.length === 0) return "";

  const parts: string[] = [];
  let used = 0;

  for (const mem of memories) {
    const evidenceRange = mem.messageRange[0] > 0 && mem.messageRange[1] > 0
      ? (mem.messageRange[0] === mem.messageRange[1]
          ? `message #${mem.messageRange[0]}`
          : `messages #${mem.messageRange[0]}–#${mem.messageRange[1]}`)
      : "earlier in the story";

    // Determine narrative ownership
    let perspective: string;
    if (speakerName && mem.entityNames.includes(speakerName)) {
      perspective = `${speakerName} experienced this`;
    } else if (mem.entityNames.length === 1) {
      perspective = `From ${mem.entityNames[0]}'s experience`;
    } else {
      perspective = "The characters involved";
    }

    const emotionalHint = mem.emotionalTags.length > 0
      ? ` The emotional undertone was ${mem.emotionalTags.slice(0, 2).join(" and ")}.`
      : "";

    const memoryKind = mem.source === "consolidation" ? "Scene continuity" : perspective;
    const block = `[${evidenceRange}] ${memoryKind}: ${mem.content.trim()}${emotionalHint}`;
    const blockTokens = estimateTokens(block);
    if (used + blockTokens > budget) break;

    parts.push(block);
    used += blockTokens;
  }

  if (parts.length === 0) return "";

  return (
    "[What the characters remember — reference through their perspective, not as exposition]\n" +
    parts.join("\n\n")
  );
}

function formatMemoriesMinimal(memories: CortexMemory[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const memory of memories) {
    if (memory.source !== "chunk") continue;
    const block = memory.content.trim();
    const tokens = estimateTokens(block);
    if (used + tokens > budget) break;
    parts.push(block);
    used += tokens;
  }
  return parts.join("\n\n");
}

// ─── Relationship Formatting ───────────────────────────────────

function formatRelationshipsShadow(
  edges: RelationEdge[],
  budget: number,
): string {
  if (edges.length === 0) return "";

  const parts: string[] = [];
  let used = 0;

  for (const edge of edges) {
    const sentiment =
      edge.sentiment > 0.3 ? "warmth" :
      edge.sentiment < -0.3 ? "tension" :
      "complexity";

    const label = edge.label || edge.type;
    const line = `Between ${edge.sourceName} and ${edge.targetName} there is ${sentiment} — ${label}.`;
    const tokens = estimateTokens(line);
    if (used + tokens > budget) break;

    parts.push(line);
    used += tokens;
  }

  if (parts.length === 0) return "";
  return parts.join(" ");
}

// ─── Arc Summary ───────────────────────────────────────────────

function formatArc(
  arcContext: string | null,
  budget: number,
  mode: Exclude<FormatterMode, "minimal">,
): string {
  if (!arcContext) return "";
  const tokens = estimateTokens(arcContext);
  const prefix = mode === "clinical"
    ? "[ARC CONTINUITY]\n"
    : mode === "attributed"
      ? "[Shared story continuity — remember without reciting] "
      : "[Story so far — internal continuity, not narration instructions] ";
  if (tokens > budget) {
    const chars = Math.floor(budget * 3.8);
    return prefix + arcContext.slice(0, chars).trim() + "...";
  }
  return prefix + arcContext;
}

// ─── Main Formatter ────────────────────────────────────────────

/**
 * Format all cortex data into a single prompt section, respecting a token budget.
 *
 * Budget allocation (shadow/attributed modes):
 *   - Memories:      45% (most narratively useful)
 *   - Entities:      30% (character/world state)
 *   - Relationships: 15% (interpersonal dynamics)
 *   - Arc:           10% (broad story context)
 */
export function formatShadowPrompt(
  memories: CortexMemory[],
  entities: EntitySnapshot[],
  relationships: RelationEdge[],
  arcContext: string | null,
  options: FormatOptions,
): ShadowPromptResult {
  const { mode, tokenBudget } = options;

  if (mode === "clinical") {
    return formatClinical(memories, entities, relationships, arcContext, tokenBudget);
  }

  if (mode === "minimal") {
    const memText = formatMemoriesMinimal(memories, tokenBudget);
    return {
      text: memText,
      tokensUsed: estimateTokens(memText),
      entitiesIncluded: 0,
      memoriesIncluded: memories.length,
      componentsIncluded: memText ? ["memories"] : [],
    };
  }

  // Shadow and Attributed modes
  const memoryBudget = Math.floor(tokenBudget * 0.45);
  const entityBudget = Math.floor(tokenBudget * 0.30);
  const relBudget = Math.floor(tokenBudget * 0.15);
  const arcBudget = Math.floor(tokenBudget * 0.10);

  const sections: string[] = [];
  const components: string[] = [];

  const memSection = mode === "attributed"
    ? formatMemoriesAttributed(memories, memoryBudget, options.currentSpeakerName)
    : formatMemoriesShadow(memories, memoryBudget);
  if (memSection) { sections.push(memSection); components.push("memories"); }

  const entSection = formatEntitiesShadow(entities, entityBudget);
  if (entSection) { sections.push(entSection); components.push("entities"); }

  const relSection = formatRelationshipsShadow(relationships, relBudget);
  if (relSection) { sections.push(relSection); components.push("relationships"); }

  const arcSection = formatArc(arcContext, arcBudget, mode);
  if (arcSection) { sections.push(arcSection); components.push("arc"); }

  const text = sections.join("\n\n");

  return {
    text,
    tokensUsed: estimateTokens(text),
    entitiesIncluded: entities.length,
    memoriesIncluded: memories.length,
    componentsIncluded: components,
  };
}

/**
 * Format only the non-memory cortex context sections (entities, relationships,
 * arc) using the shadow/attributed style. Used by the chat-memory-formatting
 * path so entity/relationship/arc context is preserved alongside the user's
 * custom memory templates.
 */
export function formatContextSections(
  entities: EntitySnapshot[],
  relationships: RelationEdge[],
  arcContext: string | null,
  options: FormatOptions,
): string {
  if (options.mode === "minimal") return "";
  if (options.mode === "clinical") {
    return formatClinical([], entities, relationships, arcContext, options.tokenBudget).text;
  }

  const budget = options.tokenBudget;
  const entityBudget = Math.floor(budget * 0.55);
  const relBudget = Math.floor(budget * 0.25);
  const arcBudget = Math.floor(budget * 0.20);

  const sections: string[] = [];

  const entSection = formatEntitiesShadow(entities, entityBudget);
  if (entSection) sections.push(entSection);

  const relSection = formatRelationshipsShadow(relationships, relBudget);
  if (relSection) sections.push(relSection);

  const arcSection = formatArc(arcContext, arcBudget, options.mode);
  if (arcSection) sections.push(arcSection);

  return sections.join("\n\n");
}

// ─── Clinical Fallback ─────────────────────────────────────────

function formatClinical(
  memories: CortexMemory[],
  entities: EntitySnapshot[],
  relationships: RelationEdge[],
  arcContext: string | null,
  budget: number,
): ShadowPromptResult {
  const entText = formatEntitySnapshotsClinical(entities);
  const relText = formatRelationshipsClinical(relationships);
  const memText = memories.map((memory) => {
    const kind = memory.source === "consolidation" ? "SCENE CONTINUITY" : "MEMORY";
    const range = memory.messageRange[0] > 0 && memory.messageRange[1] > 0
      ? ` | #${memory.messageRange[0]}–#${memory.messageRange[1]}`
      : "";
    return `[${kind}${range}]\n${memory.content}`;
  }).join("\n---\n");

  const arcText = formatArc(arcContext, budget, "clinical");
  const parts = [entText, relText, memText, arcText].filter(Boolean);
  const text = parts.join("\n\n");
  const truncated = text.slice(0, Math.floor(budget * 3.8));

  return {
    text: truncated,
    tokensUsed: estimateTokens(truncated),
    entitiesIncluded: entities.length,
    memoriesIncluded: memories.length,
    componentsIncluded: ["entities", "relationships", "memories", "arc"].filter(
      (_, i) => !![entText, relText, memText, arcText][i],
    ),
  };
}

// ─── Linked Cortex Formatter ──────────────────────────────────

export interface LinkedFormatResult {
  text: string;
  tokensUsed: number;
}

/**
 * Format linked cortex data (vaults + interlinks) with provenance headers.
 * Uses the same mode as the main formatter. Budget is for the entire linked section.
 */
export function formatLinkedCortexSection(
  vaults: VaultCortexData[],
  interlinks: InterlinkCortexData[],
  options: FormatOptions,
): LinkedFormatResult {
  const totalSources = vaults.length + interlinks.length;
  if (totalSources === 0) return { text: "", tokensUsed: 0 };

  const { tokenBudget } = options;
  const perSourceBudget = Math.floor(tokenBudget / totalSources);
  const sections: string[] = [];

  // Format vault data (entities/relations + optional source chat memories)
  for (const vault of vaults) {
    const header = `[Knowledge from vault "${vault.vaultName}"]`;
    const formatted = formatShadowPrompt(
      vault.memories ?? [],
      vault.entities,
      vault.relations,
      vault.arcContext ?? null,
      { ...options, tokenBudget: Math.max(0, perSourceBudget - estimateTokens(header)) },
    ).text;
    if (formatted) sections.push(`${header}\n${formatted}`);
  }

  // Format interlink data
  for (const interlink of interlinks) {
    const header = `[Shared memories from "${interlink.targetChatName}"]`;
    const { memories, entityContext, activeRelationships, arcContext } = interlink.result;
    const formatted = formatShadowPrompt(
      memories,
      entityContext,
      activeRelationships,
      arcContext,
      { ...options, tokenBudget: Math.max(0, perSourceBudget - estimateTokens(header)) },
    ).text;
    if (formatted) sections.push(`${header}\n${formatted}`);
  }

  const text = sections.join("\n\n");
  return { text, tokensUsed: estimateTokens(text) };
}

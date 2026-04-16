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

// ─── Attributed Mode: Character-Perspective Memories ───────────

function formatMemoriesAttributed(
  memories: CortexMemory[],
  budget: number,
  speakerName?: string,
): string {
  if (memories.length === 0) return "";

  const parts: string[] = [];
  let used = 0;

  for (const mem of memories) {
    const distance = mem.messageRange[1] > 0
      ? `~${mem.messageRange[1]} messages ago`
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

    const block = `[${distance}] ${perspective}: ${mem.content.trim()}${emotionalHint}`;
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

function formatArcShadow(arcContext: string | null, budget: number): string {
  if (!arcContext) return "";
  const tokens = estimateTokens(arcContext);
  if (tokens > budget) {
    const chars = Math.floor(budget * 3.8);
    return "[Story so far] " + arcContext.slice(0, chars).trim() + "...";
  }
  return "[Story so far] " + arcContext;
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
    const memText = formatMemoriesAttributed(memories, tokenBudget, options.currentSpeakerName);
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

  const memSection = formatMemoriesAttributed(memories, memoryBudget, options.currentSpeakerName);
  if (memSection) { sections.push(memSection); components.push("memories"); }

  const entSection = formatEntitiesShadow(entities, entityBudget);
  if (entSection) { sections.push(entSection); components.push("entities"); }

  const relSection = formatRelationshipsShadow(relationships, relBudget);
  if (relSection) { sections.push(relSection); components.push("relationships"); }

  const arcSection = formatArcShadow(arcContext, arcBudget);
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
  const memText = memories.map((m) => m.content).join("\n---\n");

  const parts = [entText, relText, memText, arcContext].filter(Boolean);
  const text = parts.join("\n\n");
  const truncated = text.slice(0, Math.floor(budget * 3.8));

  return {
    text: truncated,
    tokensUsed: estimateTokens(truncated),
    entitiesIncluded: entities.length,
    memoriesIncluded: memories.length,
    componentsIncluded: ["entities", "relationships", "memories", "arc"].filter(
      (_, i) => !![entText, relText, memText, arcContext][i],
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

  const { mode, tokenBudget } = options;
  const perSourceBudget = Math.floor(tokenBudget / totalSources);
  const sections: string[] = [];

  // Format vault data (entities/relations + optional source chat memories)
  for (const vault of vaults) {
    const budget = perSourceBudget;
    const header = `[Knowledge from vault "${vault.vaultName}"]`;
    let sectionParts: string[] = [header];
    let remaining = budget - estimateTokens(header);

    const hasMemories = vault.memories && vault.memories.length > 0;

    if (mode === "clinical") {
      const entText = formatEntitySnapshotsClinical(vault.entities);
      const relText = formatRelationshipsClinical(vault.relations);
      const memText = hasMemories ? vault.memories!.map((m) => m.content).join("\n---\n") : "";
      const combined = [entText, relText, memText].filter(Boolean).join("\n");
      sectionParts.push(combined.slice(0, Math.floor(remaining * 3.8)));
    } else if (hasMemories) {
      // With memories: use same proportions as interlink formatting
      const memBudget = Math.floor(remaining * 0.35);
      const entBudget = Math.floor(remaining * 0.35);
      const relBudget = Math.floor(remaining * 0.20);
      const arcBudget = Math.floor(remaining * 0.10);

      const memSection = formatMemoriesAttributed(vault.memories!, memBudget, options.currentSpeakerName);
      if (memSection) sectionParts.push(memSection);

      const entSection = formatEntitiesShadow(vault.entities, entBudget);
      if (entSection) sectionParts.push(entSection);

      const relSection = formatRelationshipsShadow(vault.relations, relBudget);
      if (relSection) sectionParts.push(relSection);

      const arcSection = formatArcShadow(vault.arcContext ?? null, arcBudget);
      if (arcSection) sectionParts.push(arcSection);
    } else {
      // No memories: original entity/relation only proportions
      const entBudget = Math.floor(remaining * 0.6);
      const relBudget = Math.floor(remaining * 0.4);

      const entSection = formatEntitiesShadow(vault.entities, entBudget);
      if (entSection) sectionParts.push(entSection);

      const relSection = formatRelationshipsShadow(vault.relations, relBudget);
      if (relSection) sectionParts.push(relSection);
    }

    const block = sectionParts.join("\n");
    if (estimateTokens(block) > estimateTokens(header) + 5) {
      sections.push(block);
    }
  }

  // Format interlink data
  for (const interlink of interlinks) {
    const budget = perSourceBudget;
    const header = `[Shared memories from "${interlink.targetChatName}"]`;
    let sectionParts: string[] = [header];
    let remaining = budget - estimateTokens(header);

    const { memories, entityContext, activeRelationships, arcContext } = interlink.result;

    if (mode === "clinical") {
      const entText = formatEntitySnapshotsClinical(entityContext);
      const relText = formatRelationshipsClinical(activeRelationships);
      const memText = memories.map((m) => m.content).join("\n---\n");
      const combined = [entText, relText, memText].filter(Boolean).join("\n");
      sectionParts.push(combined.slice(0, Math.floor(remaining * 3.8)));
    } else if (mode === "minimal") {
      const memSection = formatMemoriesAttributed(memories, remaining, options.currentSpeakerName);
      if (memSection) sectionParts.push(memSection);
    } else {
      // Same proportions as main formatter
      const memBudget = Math.floor(remaining * 0.45);
      const entBudget = Math.floor(remaining * 0.30);
      const relBudget = Math.floor(remaining * 0.15);
      const arcBudget = Math.floor(remaining * 0.10);

      const memSection = formatMemoriesAttributed(memories, memBudget, options.currentSpeakerName);
      if (memSection) sectionParts.push(memSection);

      const entSection = formatEntitiesShadow(entityContext, entBudget);
      if (entSection) sectionParts.push(entSection);

      const relSection = formatRelationshipsShadow(activeRelationships, relBudget);
      if (relSection) sectionParts.push(relSection);

      const arcSection = formatArcShadow(arcContext, arcBudget);
      if (arcSection) sectionParts.push(arcSection);
    }

    const block = sectionParts.join("\n");
    if (estimateTokens(block) > estimateTokens(header) + 5) {
      sections.push(block);
    }
  }

  const text = sections.join("\n\n");
  return { text, tokensUsed: estimateTokens(text) };
}

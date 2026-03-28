/**
 * Memory Cortex — Entity context assembly for prompt injection.
 *
 * Builds compact, structured snapshots of active entities and their
 * relationships for injection into the prompt via {{entities}} and
 * {{relationships}} macros.
 */

import { getDb } from "../../db/connection";
import * as entityGraph from "./entity-graph";
import type {
  EntitySnapshot,
  RelationEdge,
  MemoryEntity,
  MemoryRelation,
} from "./types";

// ─── Snapshot Assembly ─────────────────────────────────────────

/**
 * Build entity snapshots for the given entity IDs.
 * Each snapshot includes the entity's current state, top facts,
 * emotional profile, and immediate relationships.
 */
export function assembleEntitySnapshots(
  chatId: string,
  entityIds: string[],
  maxSnapshots: number,
): EntitySnapshot[] {
  if (entityIds.length === 0) return [];

  const entities = entityGraph.getEntitiesByIds(entityIds);
  const relations = entityGraph.getRelationsForEntities(chatId, entityIds);

  // Build a lookup for entity names by ID
  const allRelatedIds = new Set<string>();
  for (const rel of relations) {
    allRelatedIds.add(rel.sourceEntityId);
    allRelatedIds.add(rel.targetEntityId);
  }
  const relatedEntities = entityGraph.getEntitiesByIds([...allRelatedIds]);
  const nameById = new Map<string, string>();
  for (const e of [...entities, ...relatedEntities]) {
    nameById.set(e.id, e.name);
  }

  // Sort entities by salience (most important first) and limit
  const sorted = entities
    .sort((a, b) => b.salienceAvg - a.salienceAvg)
    .slice(0, maxSnapshots);

  return sorted.map((entity) => {
    // Get relationships involving this entity
    const entityRelations = relations.filter(
      (r) => r.sourceEntityId === entity.id || r.targetEntityId === entity.id,
    );

    const relationships = entityRelations
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5) // Max 5 relationships per entity
      .map((rel) => {
        const isSource = rel.sourceEntityId === entity.id;
        const targetId = isSource ? rel.targetEntityId : rel.sourceEntityId;
        return {
          targetName: nameById.get(targetId) ?? "unknown",
          type: rel.relationType,
          label: rel.relationLabel,
          strength: rel.strength,
          sentiment: rel.sentiment,
        };
      });

    return {
      id: entity.id,
      name: entity.name,
      type: entity.entityType,
      status: entity.status,
      description: entity.description,
      lastSeenAt: entity.lastSeenAt,
      mentionCount: entity.mentionCount,
      topFacts: entity.facts.slice(-6), // Most recent 6 facts
      emotionalProfile: entity.emotionalValence,
      relationships,
    };
  });
}

/**
 * Get active relationships between the given entity IDs.
 * Returns edges with resolved names.
 */
export function getActiveRelationEdges(
  chatId: string,
  entityIds: string[],
  maxEdges: number,
): RelationEdge[] {
  const relations = entityGraph.getRelationsForEntities(chatId, entityIds);

  // Collect all entity IDs involved
  const allIds = new Set<string>();
  for (const rel of relations) {
    allIds.add(rel.sourceEntityId);
    allIds.add(rel.targetEntityId);
  }

  const entities = entityGraph.getEntitiesByIds([...allIds]);
  const nameById = new Map<string, string>();
  for (const e of entities) {
    nameById.set(e.id, e.name);
  }

  return relations
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxEdges)
    .map((rel) => ({
      sourceName: nameById.get(rel.sourceEntityId) ?? "unknown",
      targetName: nameById.get(rel.targetEntityId) ?? "unknown",
      type: rel.relationType,
      label: rel.relationLabel,
      strength: rel.strength,
      sentiment: rel.sentiment,
    }));
}

// ─── Formatting for Prompt Injection ───────────────────────────

/**
 * Format entity snapshots into compact text for prompt injection.
 */
export function formatEntitySnapshots(snapshots: EntitySnapshot[]): string {
  if (snapshots.length === 0) return "";

  const lines: string[] = ["[KNOWN ENTITIES]"];

  for (const snap of snapshots) {
    const statusStr = snap.status !== "active" ? ` (${snap.status})` : "";
    lines.push(`\n* ${snap.name} (${snap.type}${statusStr})`);

    if (snap.description) {
      lines.push(`  ${snap.description}`);
    }

    if (snap.topFacts.length > 0) {
      lines.push(`  Facts: ${snap.topFacts.join(". ")}.`);
    }

    if (snap.relationships.length > 0) {
      const relStrs = snap.relationships.map((r) => {
        const label = r.label ? ` — ${r.label}` : "";
        return `${r.targetName} (${r.type}${label})`;
      });
      lines.push(`  Relations: ${relStrs.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format relationship edges into compact text for prompt injection.
 */
export function formatRelationships(edges: RelationEdge[]): string {
  if (edges.length === 0) return "";

  const lines: string[] = ["[ACTIVE RELATIONSHIPS]"];

  for (const edge of edges) {
    const label = edge.label ? ` (${edge.label})` : "";
    const sentimentStr = edge.sentiment > 0.3
      ? " [positive]"
      : edge.sentiment < -0.3
        ? " [hostile]"
        : "";
    lines.push(`* ${edge.sourceName} -> ${edge.targetName}: ${edge.type}${label}${sentimentStr}`);
  }

  return lines.join("\n");
}

// ─── Active Entity Resolution ──────────────────────────────────

/**
 * Resolve entity IDs that are active in the given query text.
 * Matches against entity names and aliases.
 */
export function resolveActiveEntityIds(chatId: string, queryText: string): string[] {
  // Use getActiveEntities with a cap to avoid scanning 500+ entities at scale
  const entities = entityGraph.getActiveEntities(chatId, 300);
  const matched: string[] = [];
  const lowerQuery = queryText.toLowerCase();

  for (const entity of entities) {
    const names = [entity.name, ...entity.aliases];
    for (const name of names) {
      if (name.length >= 3 && lowerQuery.includes(name.toLowerCase())) {
        matched.push(entity.id);
        break;
      }
    }
  }

  return matched;
}

/**
 * Resolve entity IDs by name filter (exact or fuzzy).
 */
export function resolveEntityIdsByNames(chatId: string, names: string[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const entity = entityGraph.findEntityByName(chatId, name);
    if (entity) ids.push(entity.id);
  }
  return ids;
}

/**
 * Memory Cortex — Macro definitions.
 *
 * Provides prompt-injectable macros for cortex-enhanced memory data:
 *   {{entities}}        — Active entity snapshots with facts and relationships
 *   {{entityFacts}}     — Facts about a specific entity: {{entityFacts::Kael}}
 *   {{relationships}}   — Active relationship edges between entities
 *   {{arc}}             — Current narrative arc summary
 *   {{memorySalience}}  — Highest-salience memory in retrieved set
 *   {{cortexActive}}    — "yes" if cortex is enabled and produced results
 *   {{entityCount}}     — Number of entities in the current context
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";
import type {
  CortexMemory,
  EntitySnapshot,
  RelationEdge,
} from "../../services/memory-cortex/types";

interface CortexEnvData {
  memories: CortexMemory[];
  entityContext: EntitySnapshot[];
  activeRelationships: RelationEdge[];
  arcContext: string | null;
}

function getCortex(ctx: MacroExecContext): CortexEnvData | null {
  return ctx.env.extra.cortex ?? null;
}

export function registerCortexMacros(): void {
  // {{entities}} — Active entity snapshots
  registry.registerMacro({
    name: "entities",
    category: "memory",
    description: "Active entity snapshots with facts and relationships from the Memory Cortex.",
    args: [
      { name: "count", type: "integer", optional: true, description: "Max entities to include" },
    ],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      if (!cortex?.entityContext?.length) return "";

      const count = ctx.args[0] ? parseInt(ctx.args[0], 10) : 0;
      const snapshots = count > 0
        ? cortex.entityContext.slice(0, count)
        : cortex.entityContext;

      return formatEntitySnapshots(snapshots);
    },
  });

  // {{entityFacts::Name}} — Facts about a specific entity
  registry.registerMacro({
    name: "entityFacts",
    category: "memory",
    description: "Key facts about a named entity. Usage: {{entityFacts::Kael}}",
    args: [
      { name: "entityName", description: "Name of the entity to look up" },
    ],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const entityName = (ctx.args[0] || "").trim();
      if (!entityName) return "";

      const cortex = getCortex(ctx);
      if (!cortex?.entityContext?.length) return "";

      const entity = cortex.entityContext.find(
        (e) => e.name.toLowerCase() === entityName.toLowerCase(),
      );
      if (!entity || entity.topFacts.length === 0) return "";

      return entity.topFacts.join("\n");
    },
  });

  // {{relationships}} — Active relationship edges
  registry.registerMacro({
    name: "relationships",
    category: "memory",
    description: "Active relationship edges between entities in the current scene.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      if (!cortex?.activeRelationships?.length) return "";

      return formatRelationships(cortex.activeRelationships);
    },
  });

  // {{arc}} — Current narrative arc summary
  registry.registerMacro({
    name: "arc",
    category: "memory",
    description: "Current narrative arc summary from the Memory Cortex consolidation layer.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      return cortex?.arcContext ?? "";
    },
  });

  // {{memorySalience}} — Highest-salience memory chunk
  registry.registerMacro({
    name: "memorySalience",
    category: "memory",
    description: "The highest narrative-importance memory from the current retrieval set.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      if (!cortex?.memories?.length) return "";

      const top = cortex.memories.reduce(
        (a, b) => (a.components.salience > b.components.salience ? a : b),
      );
      return top.content;
    },
  });

  // {{cortexActive}} — Conditional check
  registry.registerMacro({
    name: "cortexActive",
    category: "memory",
    description: "Returns 'yes' if the Memory Cortex is enabled and produced results, 'no' otherwise.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      return cortex && cortex.memories.length > 0 ? "yes" : "no";
    },
  });

  // {{entityCount}} — Number of active entities
  registry.registerMacro({
    name: "entityCount",
    category: "memory",
    description: "Number of entities active in the current retrieval context.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const cortex = getCortex(ctx);
      return String(cortex?.entityContext?.length ?? 0);
    },
  });
}

// ─── Formatting (mirrors entity-context.ts for macro independence) ──

function formatEntitySnapshots(snapshots: EntitySnapshot[]): string {
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

function formatRelationships(edges: RelationEdge[]): string {
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

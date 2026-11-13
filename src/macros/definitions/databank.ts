/**
 * Databank macros — document knowledge bank retrieval.
 *
 * All macros read from ctx.env.extra.databank which is populated by
 * prompt-assembly.service.ts before the assembly loop.
 *
 * Data shape:
 *   env.extra.databank.chunks     — Array<DatabankSearchResult>
 *   env.extra.databank.formatted  — Pre-rendered string with headers
 *   env.extra.databank.count      — Number of retrieved chunks
 *   env.extra.databank.enabled    — Whether any active banks exist
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

interface DatabankChunkData {
  content: string;
  score: number;
  documentName: string;
  metadata: any;
}

interface DatabankEnvData {
  chunks: DatabankChunkData[];
  formatted: string;
  count: number;
  enabled: boolean;
}

function getDatabank(ctx: MacroExecContext): DatabankEnvData {
  return (ctx.env.extra.databank ?? {
    chunks: [],
    formatted: "",
    count: 0,
    enabled: false,
  }) as DatabankEnvData;
}

function formatChunks(chunks: DatabankChunkData[], withHeader: boolean): string {
  if (chunks.length === 0) return "";

  const rendered = chunks.map((c) => {
    return `[Source: ${c.documentName}]\n${c.content}`;
  });

  const joined = rendered.join("\n---\n");
  if (!withHeader) return joined;
  return `[Relevant reference material from the user's knowledge bank]\n${joined}`;
}

export function registerDatabankMacros(): void {
  // {{databank}} — main macro, retrieves + formats databank chunks
  registry.registerMacro({
    name: "databank",
    category: "memory",
    description: "Retrieved databank document chunks relevant to the current context.",
    args: [{ name: "count", type: "integer", optional: true, description: "Override number of chunks to include" }],
    aliases: ["databankMemory", "documents", "knowledgeBank"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const db = getDatabank(ctx);
      if (!db.enabled || db.count === 0) return "";

      const countArg = ctx.args[0] ? parseInt(ctx.args[0], 10) : 0;
      if (countArg > 0 && countArg < db.chunks.length) {
        return formatChunks(db.chunks.slice(0, countArg), true);
      }

      return db.formatted;
    },
  });

  // {{databankActive}} — conditional check
  registry.registerMacro({
    name: "databankActive",
    category: "memory",
    description: "Returns 'yes' if databank is enabled and chunks were retrieved, 'no' otherwise.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const db = getDatabank(ctx);
      return (db.enabled && db.count > 0) ? "yes" : "no";
    },
  });

  // {{databankCount}} — number of chunks retrieved
  registry.registerMacro({
    name: "databankCount",
    category: "memory",
    description: "Number of databank chunks retrieved this generation.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const db = getDatabank(ctx);
      return db.count.toString();
    },
  });

  // {{databankRaw}} — raw chunks without header wrapper
  registry.registerMacro({
    name: "databankRaw",
    category: "memory",
    description: "Raw databank chunks joined by separator, without header wrapper.",
    args: [{ name: "count", type: "integer", optional: true, description: "Override number of chunks to include" }],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const db = getDatabank(ctx);
      if (!db.enabled || db.count === 0) return "";

      const countArg = ctx.args[0] ? parseInt(ctx.args[0], 10) : 0;
      const chunks = (countArg > 0 && countArg < db.chunks.length)
        ? db.chunks.slice(0, countArg)
        : db.chunks;

      return formatChunks(chunks, false);
    },
  });
}

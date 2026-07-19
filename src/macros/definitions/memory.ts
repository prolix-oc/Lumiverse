/**
 * Long-term memory macros — chat vector memory retrieval.
 *
 * All macros read from ctx.env.extra.memory which is populated by
 * prompt-assembly.service.ts before the assembly loop.
 *
 * Data shape:
 *   env.extra.memory.chunks     — Array<{ content, score, metadata }>
 *   env.extra.memory.formatted  — Pre-rendered string using templates
 *   env.extra.memory.count      — Number of retrieved chunks
 *   env.extra.memory.enabled    — Whether memory is active
 *   env.extra.memory.settings   — ChatMemorySettings for re-formatting
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

interface MemoryChunk {
  content: string;
  // null when the hit has no vector distance (keyword-only or recency fallback).
  score: number | null;
  metadata: any;
}

interface MemoryEnvData {
  chunks: MemoryChunk[];
  formatted: string;
  count: number;
  enabled: boolean;
  settings: {
    chunkTemplate: string;
    chunkSeparator: string;
    memoryHeaderTemplate: string;
  };
}

const DEFAULT_MEMORY_HEADER_TEMPLATE = `Long-term continuity notes from earlier in this conversation.
These are retrieval results, not live chat history.
Use them only to preserve continuity.
Do not quote, continue, imitate, or replay their wording, actions, emotional beats, or dialogue.
If an event appears complete, treat it as background consequence rather than repeating it.

{{memories}}`;

const DEFAULT_MEMORY_CHUNK_TEMPLATE = `Earlier retrieved context:
{{content}}

Use only the continuity-relevant facts/state above. Do not reuse its phrasing.`;

function getMemory(ctx: MacroExecContext): MemoryEnvData {
  return (ctx.env.extra.memory ?? {
    chunks: [],
    formatted: "",
    count: 0,
    enabled: false,
    settings: {
      chunkTemplate: DEFAULT_MEMORY_CHUNK_TEMPLATE,
      chunkSeparator: "\n---\n",
      memoryHeaderTemplate: DEFAULT_MEMORY_HEADER_TEMPLATE,
    },
  }) as MemoryEnvData;
}

function formatChunks(
  chunks: MemoryChunk[],
  settings: MemoryEnvData["settings"],
  withHeader: boolean,
): string {
  if (chunks.length === 0) return "";

  const renderedChunks = chunks.map(c => {
    let rendered = settings.chunkTemplate;
    rendered = rendered.replace(/\{\{content\}\}/g, c.content);
    rendered = rendered.replace(/\{\{score\}\}/g, c.score != null ? c.score.toFixed(4) : "n/a");
    const meta = c.metadata ?? {};
    rendered = rendered.replace(/\{\{startIndex\}\}/g, String(meta.startIndex ?? "?"));
    rendered = rendered.replace(/\{\{endIndex\}\}/g, String(meta.endIndex ?? "?"));
    return rendered;
  });

  const joined = renderedChunks.join(settings.chunkSeparator);
  if (!withHeader) return joined;
  return settings.memoryHeaderTemplate.replace(/\{\{memories\}\}/g, joined);
}

export function registerMemoryMacros(): void {
  // {{memories}} — main macro, retrieves + formats using templates
  registry.registerMacro({
    name: "memories",
    category: "memory",
    description: "Retrieved long-term memory chunks, formatted with header template.",
    args: [{ name: "count", type: "integer", optional: true, description: "Override number of chunks to include" }],
    aliases: ["longTermMemory", "chatMemory", "ltm"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const mem = getMemory(ctx);
      if (!mem.enabled || mem.count === 0) return "";

      const countArg = ctx.args[0] ? parseInt(ctx.args[0], 10) : 0;
      if (countArg > 0 && countArg < mem.chunks.length) {
        return formatChunks(mem.chunks.slice(0, countArg), mem.settings, true);
      }

      return mem.formatted;
    },
  });

  // {{memoriesActive}} — conditional: are memories enabled and were any retrieved?
  registry.registerMacro({
    name: "memoriesActive",
    category: "memory",
    description: "Returns 'yes' if memories are enabled and chunks were retrieved, 'no' otherwise.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const mem = getMemory(ctx);
      return (mem.enabled && mem.count > 0) ? "yes" : "no";
    },
  });

  // {{memoriesCount}} — how many chunks were retrieved
  registry.registerMacro({
    name: "memoriesCount",
    category: "memory",
    description: "Number of memory chunks retrieved this generation.",
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const mem = getMemory(ctx);
      return mem.count.toString();
    },
  });

  // {{memoriesRaw}} — raw chunks joined by separator, no header template
  registry.registerMacro({
    name: "memoriesRaw",
    category: "memory",
    description: "Raw memory chunks joined by separator, without header wrapper.",
    args: [{ name: "count", type: "integer", optional: true, description: "Override number of chunks to include" }],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const mem = getMemory(ctx);
      if (!mem.enabled || mem.count === 0) return "";

      const countArg = ctx.args[0] ? parseInt(ctx.args[0], 10) : 0;
      const chunks = (countArg > 0 && countArg < mem.chunks.length)
        ? mem.chunks.slice(0, countArg)
        : mem.chunks;

      return formatChunks(chunks, mem.settings, false);
    },
  });
}

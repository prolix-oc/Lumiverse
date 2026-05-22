import { getDb } from "../../db/connection";
import type { CouncilToolCategory } from "lumiverse-spindle-types";
import type { RuntimeCouncilToolDefinition } from "./tool-runtime";

const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] };

/**
 * Parse a stored input_schema JSON column into a usable schema object.
 * A corrupted row would otherwise crash the whole council-tools listing.
 */
function parseSchemaSafe(raw: unknown): Record<string, unknown> {
  if (!raw) return { ...EMPTY_SCHEMA };
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : { ...EMPTY_SCHEMA };
    } catch {
      return { ...EMPTY_SCHEMA };
    }
  }
  return { ...EMPTY_SCHEMA };
}

/**
 * Query the loom_tools table for tools flagged for deliberation,
 * converting them to CouncilToolDefinition format.
 */
export function getDLCTools(userId: string): RuntimeCouncilToolDefinition[] {
  const rows = getDb()
    .query(
      `SELECT lt.* FROM loom_tools lt
       JOIN packs p ON lt.pack_id = p.id
       WHERE p.user_id = ? AND lt.store_in_deliberation = 1
       ORDER BY lt.sort_order ASC`
    )
    .all(userId) as any[];

  return rows.map((row): RuntimeCouncilToolDefinition => ({
    name: row.tool_name,
    displayName: row.display_name || row.tool_name,
    description: row.description || "",
    category: "story_direction" as CouncilToolCategory,
    execution: "llm",
    prompt: row.prompt || "",
    inputSchema: parseSchemaSafe(row.input_schema),
    resultVariable: row.result_variable || undefined,
    storeInDeliberation: true,
  }));
}

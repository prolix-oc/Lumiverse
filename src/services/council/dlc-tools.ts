import { getDb } from "../../db/connection";
import type { CouncilToolDefinition, CouncilToolCategory } from "lumiverse-spindle-types";

/**
 * Query the loom_tools table for tools flagged for deliberation,
 * converting them to CouncilToolDefinition format.
 */
export function getDLCTools(userId: string): CouncilToolDefinition[] {
  const rows = getDb()
    .query(
      `SELECT lt.* FROM loom_tools lt
       JOIN packs p ON lt.pack_id = p.id
       WHERE p.user_id = ? AND lt.store_in_deliberation = 1
       ORDER BY lt.sort_order ASC`
    )
    .all(userId) as any[];

  return rows.map((row): CouncilToolDefinition => ({
    name: row.tool_name,
    displayName: row.display_name || row.tool_name,
    description: row.description || "",
    category: "story_direction" as CouncilToolCategory,
    prompt: row.prompt || "",
    inputSchema: typeof row.input_schema === "string"
      ? JSON.parse(row.input_schema)
      : row.input_schema || { type: "object", properties: {}, required: [] },
    resultVariable: row.result_variable || undefined,
    storeInDeliberation: true,
  }));
}

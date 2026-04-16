import type { CouncilSettings, CouncilToolDefinition } from "lumiverse-spindle-types";
import { COUNCIL_SETTINGS_DEFAULTS, COUNCIL_TOOLS_DEFAULTS, SIDECAR_DEFAULTS } from "lumiverse-spindle-types";
import * as settingsSvc from "../settings.service";
import { BUILTIN_COUNCIL_TOOLS, BUILTIN_TOOLS_MAP } from "./builtin-tools";
import { getDLCTools } from "./dlc-tools";
import { getMcpToolsAsCouncilTools } from "./mcp-tools";
import { toolRegistry } from "../../spindle/tool-registry";
import * as managerSvc from "../../spindle/manager.service";

const SETTINGS_KEY = "council_settings";
const MIN_COUNCIL_TOOL_TIMEOUT_MS = 15_000;

function normalizeCouncilSettings(settings: CouncilSettings): CouncilSettings {
  return {
    ...settings,
    toolsSettings: {
      ...settings.toolsSettings,
      timeoutMs: Math.max(MIN_COUNCIL_TOOL_TIMEOUT_MS, settings.toolsSettings.timeoutMs || 0),
    },
  };
}

/** Load the full council settings for a user, falling back to defaults (deep merge). */
export function getCouncilSettings(userId: string): CouncilSettings {
  const row = settingsSvc.getSetting(userId, SETTINGS_KEY);
  if (!row) {
    return normalizeCouncilSettings({
      ...COUNCIL_SETTINGS_DEFAULTS,
      toolsSettings: { ...COUNCIL_TOOLS_DEFAULTS },
    });
  }

  const stored = row.value as Partial<CouncilSettings>;
  const storedTools = stored.toolsSettings ?? {};

  // Preserve legacy sidecar field if present (for backwards compat fallback)
  const legacySidecar = (storedTools as any).sidecar;

  return normalizeCouncilSettings({
    ...COUNCIL_SETTINGS_DEFAULTS,
    ...stored,
    toolsSettings: {
      ...COUNCIL_TOOLS_DEFAULTS,
      ...storedTools,
      ...(legacySidecar ? { sidecar: { ...SIDECAR_DEFAULTS, ...legacySidecar } } : {}),
    },
  });
}

/** Partial-merge update of council settings. */
export function putCouncilSettings(userId: string, partial: Partial<CouncilSettings>): CouncilSettings {
  const current = getCouncilSettings(userId);
  const merged = normalizeCouncilSettings({
    ...current,
    ...partial,
    toolsSettings: partial.toolsSettings
      ? {
          ...current.toolsSettings,
          ...partial.toolsSettings,
        }
      : current.toolsSettings,
  });
  settingsSvc.putSetting(userId, SETTINGS_KEY, merged);
  return merged;
}

/**
 * Return the full list of available council tools (extension + DLC + built-in).
 * Built-in tools take priority over DLC and extension tools with the same name.
 */
export async function getAvailableTools(userId: string): Promise<CouncilToolDefinition[]> {
  const dlc = getDLCTools(userId);

  // Build extension ID → display name lookup
  const extNameMap = new Map<string, string>();
  try {
    for (const ext of await managerSvc.list()) {
      extNameMap.set(ext.id, ext.name);
    }
  } catch { /* spindle DB may not be ready */ }

  const extensionTools = toolRegistry.getCouncilTools().map(
    (reg): CouncilToolDefinition => ({
      name: toolRegistry.getQualifiedName(reg),
      displayName: reg.display_name,
      description: reg.description,
      category: "extension",
      prompt: reg.description,
      inputSchema: reg.parameters,
      storeInDeliberation: true,
      extensionName: extNameMap.get(reg.extension_id) || reg.extension_id,
    })
  );
  // MCP tools from connected servers
  const mcpTools = getMcpToolsAsCouncilTools(userId);

  const merged = new Map<string, CouncilToolDefinition>();

  // MCP tools first (lowest priority)
  for (const tool of mcpTools) {
    merged.set(tool.name, tool);
  }
  // Extension tools next
  for (const tool of extensionTools) {
    merged.set(tool.name, tool);
  }
  // DLC next so they overwrite extension on collision
  for (const tool of dlc) {
    merged.set(tool.name, tool);
  }
  // Built-ins last so they overwrite everything on collision
  for (const tool of BUILTIN_COUNCIL_TOOLS) {
    merged.set(tool.name, tool);
  }

  return Array.from(merged.values());
}

/**
 * Transforms pack data from various formats (Lucid.cards, extension exports, etc.)
 * into the normalized PackImportPayload shape expected by the backend.
 *
 * Shared between Pack Browser and Creator Workshop import flows.
 */

/** Transform from Lucid.cards / extension raw format to PackImportPayload */
function normalizeImportedGenderIdentity(value: unknown): 0 | 1 | 2 | 3 {
  const num = Number(value)
  if (num === 0 || num === 1 || num === 2 || num === 3) return num
  return 3
}

export function transformLucidPack(packData: any, catalogEntry: any) {
  const cat = (c: string) => {
    const lower = (c || '').toLowerCase()
    if (lower.includes('utility') || lower.includes('utilities')) return 'loom_utility' as const
    if (lower.includes('retrofit')) return 'retrofit' as const
    return 'narrative_style' as const
  }

  return {
    name: packData.name || packData.packName || catalogEntry.packName || 'Unknown Pack',
    author: packData.author ?? packData.packAuthor ?? catalogEntry.packAuthor ?? '',
    coverUrl: packData.coverUrl || catalogEntry.coverUrl || undefined,
    version: String(packData.version || 1),
    sourceUrl: catalogEntry.slug ? `https://lucid.cards/api/lumia-dlc/${catalogEntry.slug}` : undefined,
    extras: packData.packExtras?.length ? { items: packData.packExtras } : {},
    lumiaItems: (packData.lumiaItems || []).map((item: any) => ({
      name: item.lumiaName || item.name || 'Unknown',
      avatarUrl: item.avatarUrl || undefined,
      authorName: item.authorName || '',
      definition: item.lumiaDefinition || item.definition || '',
      personality: item.lumiaPersonality || item.personality || '',
      behavior: item.lumiaBehavior || item.behavior || '',
      genderIdentity: normalizeImportedGenderIdentity(item.genderIdentity ?? item.gender_identity),
      version: String(item.version || 1),
    })),
    loomItems: (packData.loomItems || []).map((item: any) => ({
      name: item.loomName || item.name || 'Unknown',
      content: item.loomContent || item.content || '',
      category: cat(item.loomCategory || item.category || ''),
      authorName: item.authorName || '',
      version: String(item.version || 1),
    })),
    loomTools: (packData.loomTools || []).map((tool: any) => ({
      toolName: tool.toolName || tool.tool_name || 'unknown_tool',
      displayName: tool.displayName || tool.display_name || '',
      description: tool.description || '',
      prompt: tool.prompt || '',
      inputSchema: tool.inputSchema || tool.input_schema || {},
      resultVariable: tool.resultVariable || tool.result_variable || '',
      storeInDeliberation: tool.storeInDeliberation ?? tool.store_in_deliberation ?? false,
      authorName: tool.authorName || '',
      version: String(tool.version || 1),
    })),
  }
}

/**
 * Detect format and normalize raw parsed JSON into a PackImportPayload.
 * Handles:
 *   - { pack: {...} } wrapper (extension export format)
 *   - Lucid.cards format (packName, lumiaName/lumiaDefinition fields)
 *   - Native format (passed through as-is)
 */
export function normalizePackJson(raw: any): Record<string, any> {
  // Extension export wrapper: { pack: {...} }
  if (raw.pack && typeof raw.pack === 'object' && !Array.isArray(raw.pack)) {
    return transformLucidPack(raw.pack, raw.pack)
  }
  // Lucid.cards / extension format detection
  if (raw.packName || raw.lumiaItems?.some((i: any) => i.lumiaName || i.lumiaDefinition)) {
    return transformLucidPack(raw, raw)
  }
  // Already in native format
  return raw
}

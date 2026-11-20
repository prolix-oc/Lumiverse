export interface GuidedGenerationAutoEnable {
  scope: "connection" | "chat" | "character";
  id: string;
}

export interface GuidedGeneration {
  id: string;
  name: string;
  content: string;
  position: "system" | "user_prefix" | "user_suffix";
  mode: "persistent" | "oneshot";
  enabled: boolean;
  autoEnable?: GuidedGenerationAutoEnable | null;
}

export interface GuidedGenerationContext {
  connectionProfileId?: string | null;
  chatId?: string | null;
  characterId?: string | null;
}

function normalizeAutoEnable(input: unknown): GuidedGenerationAutoEnable | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<GuidedGenerationAutoEnable>;
  if (
    candidate.scope !== "connection"
    && candidate.scope !== "chat"
    && candidate.scope !== "character"
  ) return null;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) return null;
  return { scope: candidate.scope, id: candidate.id.trim() };
}

export function isGuideAutoEnabled(
  autoEnable: unknown,
  context: GuidedGenerationContext,
): boolean {
  const rule = normalizeAutoEnable(autoEnable);
  if (!rule) return false;
  if (rule.scope === "connection") return rule.id === context.connectionProfileId;
  if (rule.scope === "chat") return rule.id === context.chatId;
  return rule.id === context.characterId;
}

/** Validate saved guides and retain only those active in this generation context. */
export function normalizeGuidedGenerations(
  input: unknown,
  context: GuidedGenerationContext,
): GuidedGeneration[] {
  if (!Array.isArray(input)) return [];
  const out: GuidedGeneration[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const guide = item as Partial<GuidedGeneration>;
    const autoEnable = normalizeAutoEnable(guide.autoEnable);
    if (!guide.enabled && !isGuideAutoEnabled(autoEnable, context)) continue;
    if (typeof guide.content !== "string" || !guide.content.trim()) continue;
    const position = guide.position === "user_prefix" || guide.position === "user_suffix"
      ? guide.position
      : "system";
    out.push({
      id: typeof guide.id === "string" ? guide.id : "",
      name: typeof guide.name === "string" && guide.name.trim()
        ? guide.name
        : "Guided Generation",
      content: guide.content,
      position,
      mode: guide.mode === "oneshot" ? "oneshot" : "persistent",
      enabled: true,
      autoEnable,
    });
  }
  return out;
}

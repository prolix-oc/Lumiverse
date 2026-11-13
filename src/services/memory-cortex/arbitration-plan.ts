import { isPlausibleAlias } from "./alias-validation";
import { normalizeCharacterName } from "./character-names";
import { validateArbitrationVerdicts } from "./arbitration";
import type { ArbitrationCanonical, ArbitrationCandidate, ArbitrationVerdict, CortexArbitrationInput } from "./arbitration";
import type { DiscoveredAlias, ExtractedEntity, ExtractedRelationship, MemoryEntity } from "./types";
import type { ColorAttribution } from "./font-attribution";
import { resolveConversationParticipants, type CortexParticipant } from "./conversation-context";

export interface CortexGraphPlan {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  aliases: DiscoveredAlias[];
  colors?: ColorAttribution[];
}

export interface CortexCleanupAction {
  entityId: string;
  action: "reject" | "resolve";
  targetEntityId?: string;
}

/** Canonical hints and proposals retain identity by ID, never by model-written names. */
export function buildCortexArbitrationPlan(options: {
  passage: string;
  graph: CortexGraphPlan;
  knownEntities: MemoryEntity[];
  characterNames: string[];
  canonicalAliases?: Map<string, string>;
  participants?: CortexParticipant[];
  existingEvidence?: Map<string, string[]>;
  gradeExisting: boolean;
}): { input: CortexArbitrationInput; apply: (verdicts: ArbitrationVerdict[]) => { graph: CortexGraphPlan; cleanup: CortexCleanupAction[] } } {
  const { knownEntities, passage } = options;
  const graph = { ...options.graph, aliases: [...options.graph.aliases] };
  for (const entity of graph.entities) {
    for (const alias of entity.aliases) {
      if (isPlausibleAlias(alias, entity.name) && !graph.aliases.some((a) => a.alias === alias && a.canonicalName === entity.name)) graph.aliases.push({ alias, canonicalName: entity.name });
    }
  }
  const sharedLabels = new Set((options.participants ?? []).flatMap((p) => p.authorLabel
    ? [p.authorLabel.toLowerCase(), normalizeCharacterName(p.authorLabel).toLowerCase()] : []));
  const canonicals: ArbitrationCanonical[] = [];
  const canonicalEntityIds = new Map<string, string>();
  const seen = new Set<string>();
  for (const entity of [...knownEntities, ...options.characterNames.map((name) => ({ name, aliases: [], id: undefined })),
    ...graph.entities.filter((e) => !e.provisional).map((e) => ({ name: e.name, aliases: [] as string[], id: undefined }))]) {
    if (seen.has(entity.name.toLowerCase()) || sharedLabels.has(entity.name.toLowerCase())) continue;
    seen.add(entity.name.toLowerCase());
    const id = `c${canonicals.length}`;
    const aliases = [...entity.aliases, ...[...(options.canonicalAliases ?? [])].filter(([, name]) => name.toLowerCase() === entity.name.toLowerCase()).map(([alias]) => alias)];
    canonicals.push({ id, name: entity.name, aliases: [...new Set(aliases)].filter((alias) => !sharedLabels.has(alias.toLowerCase())) });
    if (entity.id) canonicalEntityIds.set(id, entity.id);
  }
  // Extraction already expands first/last-name references to full character
  // names. Carry that identity context across the independent review boundary,
  // without turning inferred name parts into approved/persisted aliases.
  const characterIdentities = new Set([...options.characterNames,
    ...knownEntities.filter((e) => e.entityType === "character").map((e) => e.name)].map((name) => name.toLowerCase()));
  const partsById = new Map(canonicals.map((canonical) => [canonical.id,
    characterIdentities.has(canonical.name.toLowerCase())
      ? canonical.name.split(/\s+/).filter((part) => part.length >= 3 && isPlausibleAlias(part, canonical.name)) : []]));
  const owners = new Map<string, Set<string>>();
  for (const canonical of canonicals) {
    // A newly proposed short-name entity is precisely what review must resolve;
    // it must not invalidate the configured full name's identity hint.
    if (!characterIdentities.has(canonical.name.toLowerCase())
      && !knownEntities.some((entity) => entity.name.toLowerCase() === canonical.name.toLowerCase())) continue;
    for (const name of [canonical.name, ...canonical.aliases, ...partsById.get(canonical.id)!]) {
      const key = name.toLowerCase();
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(canonical.id);
      owners.set(key, ids);
    }
  }
  for (const canonical of canonicals) {
    const parts = [...new Set(partsById.get(canonical.id)!)].filter((part) => owners.get(part.toLowerCase())!.size === 1);
    if (parts.length) canonical.nameParts = parts;
  }
  const nameWords = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  // Co-presence supplies no identity link. Offering every nearby canonical as
  // a resolution choice dilutes ordinary keep/reject judgments for all entities.
  const shortlist = (name: string) => canonicals.filter((c) => c.name.toLowerCase() !== name.toLowerCase())
    .map((c) => ({ c, score:
      (c.aliases.some((a) => a.toLowerCase() === name.toLowerCase()) ? 10 : 0)
      + (graph.aliases.some((a) => a.alias.toLowerCase() === name.toLowerCase() && a.canonicalName.toLowerCase() === c.name.toLowerCase()) ? 8 : 0)
      + (nameWords(name).some((word) => nameWords(c.name).includes(word)) ? 4 : 0)
      + (nameWords(name).length === 1 && (c.nameParts ?? []).some((part) => part.toLowerCase().startsWith(name.toLowerCase())) ? 2 : 0) }))
    .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 48).map(({ c }) => c.id);
  const cleanupEntities = options.gradeExisting ? knownEntities.filter((e) => e.userEditedAt == null) : [];
  const candidates: ArbitrationCandidate[] = [
    ...graph.entities.map((e, i): ArbitrationCandidate => ({ id: `e${i}`, kind: "entity", name: e.name, type: e.type,
      origin: e.provisional ? "noun_phrase" : "extraction", canonicalIds: shortlist(e.name) })),
    ...graph.relationships.map((r, i): ArbitrationCandidate => ({ id: `r${i}`, kind: "relationship", source: r.source, target: r.target, type: r.type, evidence: [r.label, ...(r.evidence ?? [])] })),
    ...graph.aliases.map((a, i): ArbitrationCandidate => ({ id: `a${i}`, kind: "alias", source: a.alias, target: a.canonicalName, evidence: a.evidence ? [a.evidence] : [] })),
    ...(graph.colors ?? []).map((color, i): ArbitrationCandidate => ({ id: `f${i}`, kind: "color", name: color.entityName!,
      type: color.usageType, hexColor: color.hexColor, evidence: color.evidence ?? [] })),
    ...cleanupEntities.map((e, i): ArbitrationCandidate => ({ id: `x${i}`, kind: "existing", name: e.name, type: e.entityType,
      evidence: options.existingEvidence?.get(e.id) ?? [], canonicalIds: shortlist(e.name).filter((id) => canonicalEntityIds.has(id)) })),
  ];
  return {
    input: { passage, candidates, canonicals, participants: resolveConversationParticipants(passage, options.characterNames,
      [...(options.canonicalAliases ?? [])].map(([alias, canonicalName]) => ({ alias, canonicalName })), options.participants) },
    apply(verdicts) {
      const byId = new Map(validateArbitrationVerdicts(verdicts, candidates).map((v) => [v.id, v]));
      const renames = new Map<string, string>();
      const aliases: DiscoveredAlias[] = graph.aliases.filter((_, i) => byId.get(`a${i}`)?.action === "keep");
      const entities = graph.entities.flatMap((e, i) => {
        const verdict = byId.get(`e${i}`);
        if (!verdict || verdict.action === "reject" || verdict.action === "defer") return [];
        const canonical = verdict.action === "resolve" ? canonicals.find((c) => c.id === verdict.canonicalId) : undefined;
        if (canonical) {
          renames.set(e.name.toLowerCase(), canonical.name);
          if (isPlausibleAlias(e.name, canonical.name)) aliases.push({ canonicalName: canonical.name, alias: e.name, evidence: "Arbitrated identity in source passage" });
          const known = knownEntities.find((k) => k.name === canonical.name);
          return [{ ...e, name: canonical.name, type: known?.entityType ?? graph.entities.find((target) => target.name === canonical.name)?.type ?? e.type, aliases: canonical.aliases, provisional: false }];
        }
        return [{ ...e, aliases: aliases.filter((a) => a.canonicalName.toLowerCase() === e.name.toLowerCase()).map((a) => a.alias), provisional: false }];
      });
      const uniqueEntities = new Map<string, ExtractedEntity>();
      for (const entity of entities) {
        const prior = uniqueEntities.get(entity.name.toLowerCase());
        uniqueEntities.set(entity.name.toLowerCase(), prior ? { ...entity, aliases: [...new Set([...prior.aliases, ...entity.aliases])], provisional: prior.provisional && entity.provisional } : entity);
      }
      const acceptedAliasTargets = new Map<string, Set<string>>();
      for (const alias of aliases) {
        const key = alias.alias.toLowerCase();
        const targets = acceptedAliasTargets.get(key) ?? new Set<string>();
        targets.add(renames.get(alias.canonicalName.toLowerCase()) ?? alias.canonicalName);
        acceptedAliasTargets.set(key, targets);
      }
      const resolve = (name: string) => {
        const renamed = renames.get(name.toLowerCase());
        if (renamed) return renamed;
        // A real retained entity takes precedence over a conflicting alias.
        if (uniqueEntities.has(name.toLowerCase())) return uniqueEntities.get(name.toLowerCase())!.name;
        const targets = acceptedAliasTargets.get(name.toLowerCase());
        return targets?.size === 1 ? [...targets][0]! : name;
      };
      const relationships = graph.relationships.filter((_, i) => byId.get(`r${i}`)?.action === "keep")
        .map((r) => ({ ...r, source: resolve(r.source), target: resolve(r.target) }))
        .filter((r) => r.source.toLowerCase() !== r.target.toLowerCase() && uniqueEntities.has(r.source.toLowerCase()) && uniqueEntities.has(r.target.toLowerCase()));
      const cleanup = cleanupEntities.flatMap((e, i): CortexCleanupAction[] => {
        const verdict = byId.get(`x${i}`);
        if (uniqueEntities.has(e.name.toLowerCase())) return [];
        if (verdict?.action === "reject") return [{ entityId: e.id, action: "reject" }];
        const target = verdict?.canonicalId && canonicalEntityIds.get(verdict.canonicalId);
        return verdict?.action === "resolve" && target && target !== e.id ? [{ entityId: e.id, action: "resolve", targetEntityId: target }] : [];
      });
      const colors = graph.colors?.filter((_, i) => byId.get(`f${i}`)?.action === "keep")
        .map((color) => ({ ...color, entityName: resolve(color.entityName!) }))
        .filter((color) => uniqueEntities.has(color.entityName.toLowerCase()));
      return { graph: { entities: [...uniqueEntities.values()], relationships, aliases: aliases.map((a) => ({ ...a, canonicalName: resolve(a.canonicalName) })).filter((a) => uniqueEntities.has(a.canonicalName.toLowerCase())),
        ...(colors ? { colors } : {}) }, cleanup };
    },
  };
}

/** Legacy passage-wide facts attach only to entities explicitly named in the fact. */
export function attributeFactsToEntities(facts: string[], entities: Array<{ name: string; aliases: string[] }>): Map<string, string[]> {
  const attributed = new Map<string, string[]>();
  for (const fact of facts) {
    for (const entity of entities) {
      const names = [entity.name, ...entity.aliases].filter(Boolean);
      if (!names.some((name) => new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu").test(fact))) continue;
      attributed.set(entity.name, [...(attributed.get(entity.name) ?? []), fact]);
    }
  }
  return attributed;
}

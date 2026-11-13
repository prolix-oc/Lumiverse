import type { CortexParticipant } from "./conversation-context";
import { normalizeCharacterName } from "./character-names";

/** One identity vocabulary for extraction, review, graph endpoints and facts.
 * Display labels identify a participant; they are not additional entities.
 * Ambiguous aliases and aliases colliding with another canonical stay unresolved. */
export function buildCortexIdentityContext(
  characterNames: string[],
  knownEntities: Array<{ name: string; aliases: string[] }>,
  definitionAliases?: Map<string, string>,
  participants: CortexParticipant[] = [],
) {
  const key = (name: string) => name.trim().toLowerCase();
  const sharedLabels = new Set(participants.flatMap((p) => p.authorLabel ? [key(p.authorLabel), key(normalizeCharacterName(p.authorLabel))] : []));
  const names = new Map<string, string>();
  for (const name of [...knownEntities.map((entity) => entity.name), ...characterNames, ...participants.map((p) => p.name)]) {
    if (!sharedLabels.has(key(name))) names.set(key(name), name);
  }
  const targets = new Map<string, Set<string>>();
  const add = (alias: string, canonical: string) => {
    const aliasKey = key(alias);
    const target = names.get(key(canonical)) ?? canonical;
    if (!aliasKey || aliasKey === key(target) || sharedLabels.has(aliasKey) || sharedLabels.has(key(target))) return;
    const owners = targets.get(aliasKey) ?? new Set<string>();
    owners.add(target);
    targets.set(aliasKey, owners);
  };
  for (const entity of knownEntities) for (const alias of entity.aliases) add(alias, entity.name);
  for (const participant of participants) for (const alias of participant.aliases ?? []) add(alias, participant.name);
  for (const [alias, canonical] of definitionAliases ?? []) add(alias, canonical);
  const aliases = new Map<string, string>();
  for (const [alias, owners] of targets) {
    if (owners.size === 1 && !names.has(alias)) aliases.set(alias, [...owners][0]!);
  }
  return { aliases, isSharedLabel: (name: string) => sharedLabels.has(key(name)), canonicalize: (name: string) => names.get(key(name)) ?? aliases.get(key(name)) ?? name.trim() };
}

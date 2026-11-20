/** Participant identity is routing metadata, never evidence of a relationship. */
export interface CortexParticipant {
  name: string;
  role: "user" | "character";
  /** Stored author labels may contain card decorations removed from the name. */
  aliases?: string[];
  /** Shared routing label, not an alias or the identity of the local speaker. */
  authorLabel?: string;
}

export function getConversationMessages(content: string) {
  const headers = [...content.matchAll(/^\[(USER|CHARACTER)\s*\|\s*([^\]]+)\]:?\s*/gmi)];
  return headers.map((header, index) => ({
    name: header[2]!.trim(),
    role: header[1]!.toLowerCase() as CortexParticipant["role"],
    content: content.slice(header.index! + header[0].length, headers[index + 1]?.index ?? content.length),
  }));
}

/** Current passage authors take precedence over historical names for each
 * role. Missing roles require stored message metadata, never array ordering. */
export function resolveConversationParticipants(
  content: string,
  characterNames: string[],
  aliases: Array<{ alias: string; canonicalName: string }> = [],
  storedParticipants: CortexParticipant[] = [],
): CortexParticipant[] {
  const names = new Map(characterNames.map((name) => [name.trim().toLowerCase(), name.trim()]));
  const identityAliases = [...aliases, ...storedParticipants.flatMap((participant) =>
    (participant.aliases ?? []).map((alias) => ({ alias, canonicalName: participant.name })))];
  const canonicalize = (name: string) => names.get(name.toLowerCase())
    ?? identityAliases.find((alias) => alias.alias.toLowerCase() === name.toLowerCase())?.canonicalName ?? name;
  const participants = new Map<string, CortexParticipant>();
  const messages = getConversationMessages(content);
  const explicitRoles = new Set(messages.map((message) => message.role));
  for (const participant of [...storedParticipants.filter((participant) => !explicitRoles.has(participant.role)), ...messages]) {
    const shared = storedParticipants.filter((stored) => stored.role === participant.role
      && stored.authorLabel?.toLowerCase() === participant.name.toLowerCase());
    for (const member of shared.length ? shared : [participant]) {
      const name = canonicalize(member.name);
      participants.set(`${member.role}:${name.toLowerCase()}`, { name, role: member.role,
        ...("authorLabel" in member && member.authorLabel ? { authorLabel: member.authorLabel } : {}) });
    }
  }
  return [...participants.values()];
}

export function buildConversationHint(content: string, characterNames: string[], aliases?: Array<{ alias: string; canonicalName: string }>, storedParticipants?: CortexParticipant[]): string {
  const participants = resolveConversationParticipants(content, characterNames, aliases, storedParticipants);
  return participants.length ? `\n\n<conversation_participants>\n${JSON.stringify(participants)}\nIdentity metadata only, not evidence of presence, actions or relationships. A message prefix identifies the author label, which may route multiple characters (authorLabel). Shared labels are not individual entities or aliases. Attribute each action, dialogue, thought and reference from local names, narration and viewpoint in any POV. A shared author label does not identify a speaker or thinker; ambiguous references stay unresolved. Use individual canonical names, including for {{user}}/{{char}} only when unambiguous.\n</conversation_participants>` : "";
}

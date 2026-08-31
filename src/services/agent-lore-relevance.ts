export interface AgentLoreSearchFields {
  comment: string;
  primaryKeys: readonly string[];
  secondaryKeys: readonly string[];
  content: string;
}

const NO_MATCH_RANK = 9;

function matchRank(value: string, normalizedQuery: string): number {
  const normalizedValue = value.toLowerCase();
  if (normalizedValue === normalizedQuery) return 0;
  if (normalizedValue.startsWith(normalizedQuery)) return 1;
  if (normalizedValue.includes(normalizedQuery)) return 2;
  return NO_MATCH_RANK;
}

function bestMatchRank(values: readonly string[], normalizedQuery: string): number {
  let best = NO_MATCH_RANK;
  for (const value of values) {
    best = Math.min(best, matchRank(value, normalizedQuery));
  }
  return best;
}

/**
 * Rank exact, prefix, then substring matches across identity, secondary-key,
 * and content tiers. Lower is more relevant; 9 means no match. An empty query
 * intentionally matches every entry at one stable rank.
 */
export function rankAgentLoreSearch(
  fields: AgentLoreSearchFields,
  query: string,
): number {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return 0;

  const identity = bestMatchRank(
    [fields.comment, ...fields.primaryKeys],
    normalizedQuery,
  );
  if (identity < NO_MATCH_RANK) return identity;

  const secondary = bestMatchRank(fields.secondaryKeys, normalizedQuery);
  if (secondary < NO_MATCH_RANK) return 3 + secondary;

  const content = matchRank(fields.content, normalizedQuery);
  return content < NO_MATCH_RANK ? 6 + content : NO_MATCH_RANK;
}

export function isAgentLoreSearchMatch(rank: number): boolean {
  return rank < NO_MATCH_RANK;
}

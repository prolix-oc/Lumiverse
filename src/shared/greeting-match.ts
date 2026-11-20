interface GreetingMatchEntry {
  textKey: string;
  title: string | null;
}

/** Keep name previews and selective imports aligned when greetings repeat or move. */
export function findMatchingGreeting<T extends GreetingMatchEntry>(
  textKey: string,
  mainEntry: T,
  altEntries: T[],
  preferred: { isMain?: boolean; altIndex?: number } = {},
): T | null {
  if (!textKey) return null;
  if (preferred.isMain && mainEntry.textKey === textKey) return mainEntry;
  if (preferred.altIndex !== undefined) {
    const slot = altEntries[preferred.altIndex];
    if (slot?.textKey === textKey) return slot;
  }
  return altEntries.find((entry) => entry.textKey === textKey && entry.title !== null)
    ?? (mainEntry.textKey === textKey ? mainEntry : null);
}

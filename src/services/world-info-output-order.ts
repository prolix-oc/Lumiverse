export function orderWorldInfoForOutput<T extends { id: string; order_value: number }>(
  entries: T[],
  insertionOrderByEntryId: ReadonlyMap<string, string>,
  runtimePlacementIds: ReadonlySet<string>,
): T[] {
  if (insertionOrderByEntryId.size === 0) return entries;
  const groups = new Map<string, { indices: number[]; entries: T[] }>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const extensionId = insertionOrderByEntryId.get(entry.id);
    if (extensionId === undefined || runtimePlacementIds.has(entry.id)) continue;
    let group = groups.get(extensionId);
    if (!group) {
      group = { indices: [], entries: [] };
      groups.set(extensionId, group);
    }
    group.indices.push(index);
    group.entries.push(entry);
  }
  let ordered = entries;
  for (const group of groups.values()) {
    if (group.entries.length < 2) continue;
    if (ordered === entries) ordered = [...entries];
    // Match insertion ordering used by chat placements, including reversed ties.
    group.entries.sort((a, b) => b.order_value - a.order_value).reverse();
    for (let index = 0; index < group.indices.length; index++) {
      ordered[group.indices[index]] = group.entries[index];
    }
  }
  return ordered;
}

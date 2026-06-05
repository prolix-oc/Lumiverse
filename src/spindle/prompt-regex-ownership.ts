// Backend prompt-target regex ownership registry.
//
// An extension declares the chat IDs for which it applies `target:prompt` 
// regex itself, and the host then skips its own per-message prompt-regex 
// pass for those chats.

const ownedByExtension = new Map<string, Set<string>>();

export function setPromptRegexOwnedChats(extensionId: string, chatIds: string[]): void {
  if (chatIds.length === 0) {
    ownedByExtension.delete(extensionId);
    return;
  }
  ownedByExtension.set(extensionId, new Set(chatIds));
}

export function isPromptRegexChatOwned(
  chatId: string,
  isExtAlive: (extId: string) => boolean,
): boolean {
  for (const [extId, chatIds] of ownedByExtension) {
    if (chatIds.has(chatId) && isExtAlive(extId)) return true;
  }
  return false;
}

export function clearPromptRegexOwner(extensionId: string): void {
  ownedByExtension.delete(extensionId);
}

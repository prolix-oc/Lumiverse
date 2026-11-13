import {
  abortAllBackgrounds,
  abortChatBackground,
  abortUserBackgrounds,
} from "../chat-background.service";

export interface ActiveGenerationEntry {
  controller: AbortController;
  userId: string;
  chatId: string;
  startedAt: number;
  /** Timestamp of the most recently received content or reasoning token. */
  lastTokenAt: number;
  /** Admission wait is separate from provider inactivity. Stop still applies. */
  waitingForInference?: boolean;
  /** Resolves after setup and streaming teardown have both completed. */
  completion: Promise<void>;
}

const activeGenerations = new Map<string, ActiveGenerationEntry>();
const activeChatGenerations = new Map<string, string>();

function chatGenerationKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

export function getActiveGeneration(
  generationId: string,
): ActiveGenerationEntry | undefined {
  return activeGenerations.get(generationId);
}

export function registerActiveGeneration(
  generationId: string,
  entry: ActiveGenerationEntry,
): void {
  activeGenerations.set(generationId, entry);
}

export function removeActiveGeneration(generationId: string): boolean {
  return activeGenerations.delete(generationId);
}

export function setActiveChatGeneration(
  userId: string,
  chatId: string,
  generationId: string,
): void {
  activeChatGenerations.set(chatGenerationKey(userId, chatId), generationId);
}

export function clearActiveChatGeneration(
  userId: string,
  chatId: string,
  expectedGenerationId?: string,
): boolean {
  const key = chatGenerationKey(userId, chatId);
  if (
    expectedGenerationId !== undefined
    && activeChatGenerations.get(key) !== expectedGenerationId
  ) {
    return false;
  }
  return activeChatGenerations.delete(key);
}

export function clearActiveChatGenerationById(generationId: string): boolean {
  for (const [key, activeGenerationId] of activeChatGenerations) {
    if (activeGenerationId !== generationId) continue;
    activeChatGenerations.delete(key);
    return true;
  }
  return false;
}

export function touchActiveGeneration(
  generationId: string,
  now = Date.now(),
): void {
  const entry = activeGenerations.get(generationId);
  if (entry) entry.lastTokenAt = now;
}

export function setActiveGenerationWaitingForInference(generationId: string, waiting: boolean): void {
  const entry = activeGenerations.get(generationId);
  if (!entry) return;
  if (entry.waitingForInference && !waiting) entry.lastTokenAt = Date.now();
  entry.waitingForInference = waiting;
}

export function stopGeneration(userId: string, generationId: string): boolean {
  const entry = activeGenerations.get(generationId);
  if (!entry || entry.userId !== userId) return false;
  entry.controller.abort();
  abortChatBackground(entry.userId, entry.chatId);
  return true;
}

export function stopUserGenerations(userId: string): void {
  for (const entry of activeGenerations.values()) {
    if (entry.userId === userId) entry.controller.abort();
  }
  abortUserBackgrounds(userId);
}

export function stopChatGenerations(userId: string, chatId: string): boolean {
  const generationId = activeChatGenerations.get(
    chatGenerationKey(userId, chatId),
  );
  let stopped = false;
  if (generationId) {
    const entry = activeGenerations.get(generationId);
    if (entry) {
      entry.controller.abort();
      stopped = true;
    }
  }
  abortChatBackground(userId, chatId);
  return stopped;
}

export function stopAllGenerations(): void {
  for (const entry of activeGenerations.values()) entry.controller.abort();
  activeGenerations.clear();
  activeChatGenerations.clear();
  abortAllBackgrounds();
}

export function getActiveChatGeneration(
  userId: string,
  chatId: string,
): string | undefined {
  return activeChatGenerations.get(chatGenerationKey(userId, chatId));
}

export function getActiveGenerationCount(): number {
  return activeGenerations.size;
}

const GENERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const GENERATION_IDLE_SWEEP_INTERVAL_MS = 60_000;

export function sweepInactiveGenerations(now = Date.now()): void {
  for (const [generationId, entry] of activeGenerations) {
    if (entry.waitingForInference) continue;
    const idleForMs = now - entry.lastTokenAt;
    if (idleForMs <= GENERATION_IDLE_TIMEOUT_MS) continue;
    console.warn(
      `[generate] Aborting inactive generation ${generationId} (no tokens for ${Math.round(idleForMs / 1000)}s; age: ${Math.round((now - entry.startedAt) / 1000)}s)`,
    );
    entry.controller.abort();
  }
}

let generationSweepTimer: ReturnType<typeof setInterval> | null = setInterval(
  sweepInactiveGenerations,
  GENERATION_IDLE_SWEEP_INTERVAL_MS,
);

export function stopGenerationSweep(): void {
  if (!generationSweepTimer) return;
  clearInterval(generationSweepTimer);
  generationSweepTimer = null;
}

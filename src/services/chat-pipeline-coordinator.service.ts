export type ChatPipelineTaskKind =
  | "chunk_rebuild"
  | "cortex_ingest"
  | "cortex_rebuild"
  | "cortex_warmup";

export interface ChatPipelineTaskResult<T = void> {
  status: "completed" | "skipped" | "superseded";
  reason?: string;
  value?: T;
}

export interface ChatPipelineTaskSnapshot {
  id: string;
  kind: ChatPipelineTaskKind;
  dedupeKey: string | null;
  revision: number | string | null;
  exclusive: boolean;
  enqueuedAt: number;
  startedAt: number | null;
}

export interface ChatPipelineStatus {
  chatId: string;
  activeTask: ChatPipelineTaskSnapshot | null;
  queuedTasks: ChatPipelineTaskSnapshot[];
  running: boolean;
  queuedCounts: Record<ChatPipelineTaskKind, number>;
  completedTasks: number;
  skippedTasks: number;
  supersededTasks: number;
  updatedAt: number;
}

type PreflightDecision =
  | { action: "run" }
  | { action: "skip"; reason: string };

interface QueueTask<T> {
  id: string;
  kind: ChatPipelineTaskKind;
  chatId: string;
  exclusive: boolean;
  dedupeKey: string | null;
  revision: number | string | null;
  enqueuedAt: number;
  startedAt: number | null;
  preflight?: () => Promise<PreflightDecision> | PreflightDecision;
  run: () => Promise<T>;
  resolve: (result: ChatPipelineTaskResult<T>) => void;
  reject: (reason?: unknown) => void;
}

interface ChatPipelineLane {
  chatId: string;
  queue: QueueTask<unknown>[];
  activeTask: QueueTask<unknown> | null;
  processing: boolean;
  completedTasks: number;
  skippedTasks: number;
  supersededTasks: number;
  updatedAt: number;
}

export interface EnqueueChatPipelineTaskOptions<T> {
  chatId: string;
  kind: ChatPipelineTaskKind;
  exclusive?: boolean;
  dedupeKey?: string;
  revision?: number | string | null;
  preflight?: () => Promise<PreflightDecision> | PreflightDecision;
  run: () => Promise<T>;
}

const lanes = new Map<string, ChatPipelineLane>();

function createLane(chatId: string): ChatPipelineLane {
  return {
    chatId,
    queue: [],
    activeTask: null,
    processing: false,
    completedTasks: 0,
    skippedTasks: 0,
    supersededTasks: 0,
    updatedAt: Date.now(),
  };
}

function getOrCreateLane(chatId: string): ChatPipelineLane {
  const existing = lanes.get(chatId);
  if (existing) return existing;
  const lane = createLane(chatId);
  lanes.set(chatId, lane);
  return lane;
}

function touchLane(lane: ChatPipelineLane): void {
  lane.updatedAt = Date.now();
}

function taskToSnapshot(task: QueueTask<unknown>): ChatPipelineTaskSnapshot {
  return {
    id: task.id,
    kind: task.kind,
    dedupeKey: task.dedupeKey,
    revision: task.revision,
    exclusive: task.exclusive,
    enqueuedAt: task.enqueuedAt,
    startedAt: task.startedAt,
  };
}

function buildQueuedCounts(lane: ChatPipelineLane): Record<ChatPipelineTaskKind, number> {
  const counts: Record<ChatPipelineTaskKind, number> = {
    chunk_rebuild: 0,
    cortex_ingest: 0,
    cortex_rebuild: 0,
    cortex_warmup: 0,
  };
  for (const task of lane.queue) counts[task.kind] += 1;
  return counts;
}

export function getChatPipelineStatus(chatId: string): ChatPipelineStatus | null {
  const lane = lanes.get(chatId);
  if (!lane) return null;
  return {
    chatId,
    activeTask: lane.activeTask ? taskToSnapshot(lane.activeTask) : null,
    queuedTasks: lane.queue.map(taskToSnapshot),
    running: lane.processing,
    queuedCounts: buildQueuedCounts(lane),
    completedTasks: lane.completedTasks,
    skippedTasks: lane.skippedTasks,
    supersededTasks: lane.supersededTasks,
    updatedAt: lane.updatedAt,
  };
}

function settleSuperseded(task: QueueTask<unknown>, reason: string, lane: ChatPipelineLane): void {
  lane.supersededTasks += 1;
  touchLane(lane);
  task.resolve({ status: "superseded", reason });
}

function settleSkipped(task: QueueTask<unknown>, reason: string, lane: ChatPipelineLane): void {
  lane.skippedTasks += 1;
  touchLane(lane);
  task.resolve({ status: "skipped", reason });
}

function settleCompleted<T>(task: QueueTask<T>, value: T, lane: ChatPipelineLane): void {
  lane.completedTasks += 1;
  touchLane(lane);
  task.resolve({ status: "completed", value });
}

function supersedeQueuedIngestions(lane: ChatPipelineLane, reason: string): void {
  if (lane.queue.length === 0) return;
  const survivors: QueueTask<unknown>[] = [];
  for (const task of lane.queue) {
    if (task.kind === "cortex_ingest") settleSuperseded(task, reason, lane);
    else survivors.push(task);
  }
  lane.queue = survivors;
}

function supersedeQueuedDedupeMatch(
  lane: ChatPipelineLane,
  incomingKind: ChatPipelineTaskKind,
  dedupeKey: string | null,
  reason: string,
): void {
  if (!dedupeKey || incomingKind !== "cortex_ingest" || lane.queue.length === 0) return;
  const survivors: QueueTask<unknown>[] = [];
  for (const task of lane.queue) {
    if (task.kind === incomingKind && task.dedupeKey === dedupeKey) {
      settleSuperseded(task, reason, lane);
    } else {
      survivors.push(task);
    }
  }
  lane.queue = survivors;
}

async function pumpLane(lane: ChatPipelineLane): Promise<void> {
  if (lane.processing) return;
  lane.processing = true;
  touchLane(lane);

  try {
    while (lane.queue.length > 0) {
      const task = lane.queue.shift()!;
      lane.activeTask = task;
      task.startedAt = Date.now();
      touchLane(lane);

      try {
        if (task.preflight) {
          const decision = await task.preflight();
          if (decision.action === "skip") {
            settleSkipped(task, decision.reason, lane);
            continue;
          }
        }

        const value = await task.run();
        settleCompleted(task as QueueTask<unknown>, value, lane);
      } catch (err) {
        task.reject(err);
      } finally {
        lane.activeTask = null;
        touchLane(lane);
      }
    }
  } finally {
    lane.processing = false;
    touchLane(lane);
  }
}

export function enqueueChatPipelineTask<T>(
  options: EnqueueChatPipelineTaskOptions<T>,
): Promise<ChatPipelineTaskResult<T>> {
  const lane = getOrCreateLane(options.chatId);
  const taskId = crypto.randomUUID();

  return new Promise<ChatPipelineTaskResult<T>>((resolve, reject) => {
    const task: QueueTask<T> = {
      id: taskId,
      kind: options.kind,
      chatId: options.chatId,
      exclusive: options.exclusive === true,
      dedupeKey: options.dedupeKey ?? null,
      revision: options.revision ?? null,
      enqueuedAt: Date.now(),
      startedAt: null,
      preflight: options.preflight,
      run: options.run,
      resolve,
      reject,
    };

    supersedeQueuedDedupeMatch(
      lane,
      task.kind,
      task.dedupeKey,
      "superseded_by_newer_task",
    );

    if (task.exclusive) {
      supersedeQueuedIngestions(lane, `superseded_by_${task.kind}`);
    }

    lane.queue.push(task as QueueTask<unknown>);
    touchLane(lane);
    void pumpLane(lane);
  });
}

export function resetChatPipelineCoordinatorForTests(): void {
  lanes.clear();
}

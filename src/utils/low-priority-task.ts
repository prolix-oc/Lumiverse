type LowPriorityTask = {
  label?: string;
  run: () => void | Promise<void>;
};

const pending: LowPriorityTask[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let activeAsyncTasks = 0;
let idleResolvers: Array<() => void> = [];

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return !!value && typeof value === "object" && "then" in value && typeof (value as Promise<unknown>).then === "function";
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(runNext, 0);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

function resolveIdleIfNeeded(): void {
  if (timer || pending.length > 0 || activeAsyncTasks > 0) return;
  const resolvers = idleResolvers;
  idleResolvers = [];
  for (const resolve of resolvers) resolve();
}

function finishAsyncTask(): void {
  activeAsyncTasks = Math.max(0, activeAsyncTasks - 1);
  resolveIdleIfNeeded();
}

function runNext(): void {
  timer = null;
  const task = pending.shift();
  if (!task) {
    resolveIdleIfNeeded();
    return;
  }

  try {
    const result = task.run();
    if (isPromiseLike(result)) {
      activeAsyncTasks += 1;
      result.catch((err) => {
        console.warn(`[deferred] ${task.label || "low-priority task"} failed:`, err);
      }).finally(finishAsyncTask);
    }
  } catch (err) {
    console.warn(`[deferred] ${task.label || "low-priority task"} failed:`, err);
  }

  if (pending.length > 0) schedule();
  resolveIdleIfNeeded();
}

export function scheduleLowPriorityTask(
  run: () => void | Promise<void>,
  options?: { label?: string },
): void {
  pending.push({ run, label: options?.label });
  schedule();
}

export function waitForLowPriorityTasksForTests(): Promise<void> {
  if (!timer && pending.length === 0 && activeAsyncTasks === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    idleResolvers.push(resolve);
  });
}

export function resetLowPriorityTasksForTests(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending.length = 0;
  activeAsyncTasks = 0;
  const resolvers = idleResolvers;
  idleResolvers = [];
  for (const resolve of resolvers) resolve();
}

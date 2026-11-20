type LowPriorityTask = {
  label?: string;
  run: () => void | Promise<void>;
}

const pending: LowPriorityTask[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return !!value && typeof value === 'object' && 'then' in value && typeof (value as Promise<unknown>).then === 'function'
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(runNext, 0)
}

function runNext(): void {
  timer = null
  const task = pending.shift()
  if (!task) return

  try {
    const result = task.run()
    if (isPromiseLike(result)) {
      void result.catch((err) => {
        console.warn(`[deferred] ${task.label || 'low-priority task'} failed:`, err)
      })
    }
  } catch (err) {
    console.warn(`[deferred] ${task.label || 'low-priority task'} failed:`, err)
  }

  if (pending.length > 0) schedule()
}

export function scheduleLowPriorityTask(
  run: () => void | Promise<void>,
  options?: { label?: string },
): void {
  pending.push({ run, label: options?.label })
  schedule()
}

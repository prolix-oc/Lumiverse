/** Whether the chat composer's own speech-to-text session is active, for extensions that share the microphone. */
type Listener = (active: boolean) => void

let holds = 0
const listeners = new Set<Listener>()

const publish = (active: boolean) => {
  for (const listener of [...listeners]) listener(active)
}

export const isHostCapturing = (): boolean => holds > 0

export function subscribeHostCapture(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Marks a host capture session as active until the returned release is called. */
export function holdHostCapture(): () => void {
  let held = true
  if (holds++ === 0) publish(true)
  return () => {
    if (!held) return
    held = false
    if (--holds === 0) publish(false)
  }
}

// A deliberately idle sibling worker used to distinguish regex execution from
// browser/OS worker starvation. If this worker's tiny heartbeat is late too,
// wall-clock delay is environmental evidence rather than regex CPU evidence.
const canarySelf = self as unknown as {
  postMessage(message: { type: 'heartbeat' }): void
}

const HEARTBEAT_MS = 100

function heartbeat(): void {
  canarySelf.postMessage({ type: 'heartbeat' })
}

heartbeat()
setInterval(heartbeat, HEARTBEAT_MS)

/**
 * The scheduler only owns queues in the process that serves HTTP and owns the
 * provider connections. Worker threads and the chat-chunk vectorization
 * subprocess must not create independent queues: their work is already leased
 * by the host at dispatch time, and a child-local queue would silently do
 * nothing while adding latency.
 */
export function isInferenceSchedulerHost(): boolean {
  const isMainThread = typeof Bun !== "undefined" && typeof Bun.isMainThread === "boolean"
    ? Bun.isMainThread
    : true;
  if (!isMainThread) return false;
  return process.env.LUMIVERSE_INFERENCE_SCHEDULER !== "child";
}

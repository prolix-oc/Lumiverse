/**
 * `updatefound` fires both for a first install and for a replacement worker.
 * Only a replacement should block the application behind the update overlay.
 */
export function isServiceWorkerReplacement(
  hasActiveWorker: boolean,
  hasController: boolean,
): boolean {
  return hasActiveWorker || hasController
}

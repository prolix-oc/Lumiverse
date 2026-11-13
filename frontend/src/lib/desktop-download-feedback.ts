export interface DesktopDownloadEvent {
  phase: 'started' | 'finished'
  id: string
  fileName: string
  success?: boolean
}

interface DownloadMessages {
  started: (fileName: string) => string
  complete: (fileName: string) => string
  failed: (fileName: string) => string
  title: string
}

interface DownloadNotifier {
  info: (message: string, options: { title: string; duration: number; dismissible: boolean }) => string
  success: (message: string) => string
  error: (message: string) => string
  dismiss: (id: string) => void
}

/** Maintains one in-progress toast per native WebView download. */
export function createDesktopDownloadFeedback(messages: DownloadMessages, notifier: DownloadNotifier) {
  const active = new Map<string, { toastId: string; fileName: string }>()

  return {
    handle(payload: DesktopDownloadEvent): void {
      const existing = active.get(payload.id)
      if (payload.phase === 'started') {
        if (existing) notifier.dismiss(existing.toastId)
        active.set(payload.id, {
          fileName: payload.fileName,
          toastId: notifier.info(messages.started(payload.fileName), {
            title: messages.title,
            duration: 0,
            dismissible: false,
          }),
        })
        return
      }

      if (existing) {
        notifier.dismiss(existing.toastId)
        active.delete(payload.id)
      }
      const fileName = existing?.fileName || payload.fileName
      if (payload.success) notifier.success(messages.complete(fileName))
      else notifier.error(messages.failed(fileName))
    },
    dispose(): void {
      for (const { toastId } of active.values()) notifier.dismiss(toastId)
      active.clear()
    },
  }
}

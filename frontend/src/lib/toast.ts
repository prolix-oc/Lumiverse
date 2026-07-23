import { useStore } from '@/store'
import type { Toast, ToastType } from '@/types/store'

interface ToastOptions {
  title?: string
  duration?: number
  dismissible?: boolean
  action?: { label: string; onClick: () => void }
}

function fire(type: ToastType, message: string, options?: ToastOptions): string {
  return useStore.getState().addToast({
    type,
    message,
    title: options?.title,
    duration: options?.duration,
    dismissible: options?.dismissible,
    action: options?.action,
  })
}

export const toast = {
  success: (message: string, options?: ToastOptions) => fire('success', message, options),
  warning: (message: string, options?: ToastOptions) => fire('warning', message, options),
  error: (message: string, options?: ToastOptions) => fire('error', message, options),
  info: (message: string, options?: ToastOptions) => fire('info', message, options),
  update: (id: string, update: Partial<Omit<Toast, 'id'>>) => useStore.getState().updateToast(id, update),
  dismiss: (id: string) => useStore.getState().removeToast(id),
  clear: () => useStore.getState().clearToasts(),
}

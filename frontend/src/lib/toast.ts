import { useStore } from '@/store'
import type { ToastType } from '@/types/store'

interface ToastOptions {
  title?: string
  duration?: number
  dismissible?: boolean
}

function fire(type: ToastType, message: string, options?: ToastOptions): string {
  return useStore.getState().addToast({
    type,
    message,
    title: options?.title,
    duration: options?.duration,
    dismissible: options?.dismissible,
  })
}

export const toast = {
  success: (message: string, options?: ToastOptions) => fire('success', message, options),
  warning: (message: string, options?: ToastOptions) => fire('warning', message, options),
  error: (message: string, options?: ToastOptions) => fire('error', message, options),
  info: (message: string, options?: ToastOptions) => fire('info', message, options),
  dismiss: (id: string) => useStore.getState().removeToast(id),
  clear: () => useStore.getState().clearToasts(),
}

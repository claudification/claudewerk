/**
 * Module-level pub/sub bus that powers the inline launch toasts.
 *
 * runProfile() and other callers fire toasts via pushLaunchToast() without
 * prop-drilling. The LaunchToastContainer subscribes to this bus on mount
 * and renders the current set. Living in its own file keeps the toast
 * component's Fast-Refresh boundary clean (no non-component exports).
 */

const TOAST_TTL_MS = 8000

export type ToastVariant = 'blocked' | 'failed'

export interface LaunchToastItem {
  id: number
  variant: ToastVariant
  title: string
  body: string
  profileId?: string
  expiresAt: number
}

let nextId = 1
const listeners = new Set<(toasts: LaunchToastItem[]) => void>()
let toasts: LaunchToastItem[] = []

function publish() {
  for (const l of listeners) l(toasts)
}

export function pushLaunchToast(t: Omit<LaunchToastItem, 'id' | 'expiresAt'>): number {
  const id = nextId++
  toasts = [...toasts, { ...t, id, expiresAt: Date.now() + TOAST_TTL_MS }]
  publish()
  return id
}

export function dismissLaunchToast(id: number) {
  toasts = toasts.filter(t => t.id !== id)
  publish()
}

export function subscribeLaunchToasts(listener: (toasts: LaunchToastItem[]) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLaunchToasts(): LaunchToastItem[] {
  return toasts
}

export function reapExpiredToasts(): void {
  const now = Date.now()
  toasts = toasts.filter(t => t.expiresAt > now)
  publish()
}

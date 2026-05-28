/**
 * Inline launch toasts for profile runs.
 *
 * The toast bus (pubsub + push helpers) lives in ./launch-toast-bus so
 * runProfile() can fire toasts without prop-drilling. Only the container +
 * row component live here.
 *
 * Success is silent -- chord launches auto-focus the new conversation, the
 * sidebar entry is the feedback. Only "blocked" and "failed" surface here.
 */

import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  dismissLaunchToast,
  getLaunchToasts,
  type LaunchToastItem,
  reapExpiredToasts,
  subscribeLaunchToasts,
  type ToastVariant,
} from './launch-toast-bus'
import { openEditProfile } from './run-profile'

export function LaunchToastContainer() {
  const [items, setItems] = useState<LaunchToastItem[]>(getLaunchToasts())

  useEffect(() => subscribeLaunchToasts(setItems), [])

  useEffect(() => {
    if (items.length === 0) return
    const next = Math.min(...items.map(t => t.expiresAt))
    const handle = window.setTimeout(reapExpiredToasts, Math.max(0, next - Date.now()))
    return () => window.clearTimeout(handle)
  }, [items])

  if (items.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 max-w-sm">
      {items.map(t => (
        <LaunchToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}

function LaunchToastRow({ toast }: { toast: LaunchToastItem }) {
  return (
    <div className={`bg-background border shadow-lg p-3 font-mono text-xs ${borderForVariant(toast.variant)}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`uppercase tracking-wider text-[10px] font-bold ${titleForVariant(toast.variant)}`}>
            {toast.title}
          </div>
          <div className="text-foreground mt-1 whitespace-pre-line">{toast.body}</div>
        </div>
        <button
          type="button"
          onClick={() => dismissLaunchToast(toast.id)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {toast.profileId && (
        <div className="mt-2 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              openEditProfile(toast.profileId!)
              dismissLaunchToast(toast.id)
            }}
            className="text-[11px] text-primary hover:underline"
          >
            Edit profile
          </button>
        </div>
      )}
    </div>
  )
}

function borderForVariant(v: ToastVariant): string {
  if (v === 'blocked') return 'border-warning/60'
  return 'border-destructive/60'
}

function titleForVariant(v: ToastVariant): string {
  if (v === 'blocked') return 'text-warning'
  return 'text-destructive'
}

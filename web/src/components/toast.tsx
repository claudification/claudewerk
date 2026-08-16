import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { haptic } from '@/lib/utils'
import { ToastCard } from './toast-card'

export interface Toast {
  id: number
  title: string
  /** Optional right-aligned chip next to the title (e.g. "7-day · 84%"). */
  meta?: string
  body: string
  conversationId?: string
  taskId?: string
  /** Managed surface to restore when the toast is clicked. */
  surfaceId?: string
  toastId?: string
  variant?: string
  /** When true, the toast does not auto-dismiss -- the user must close it. */
  persistent?: boolean
  /** When set, the toast renders a copy-to-clipboard button for this string. */
  copyText?: string
}

let nextId = 0
const AUTO_DISMISS_MS = 8000

/** Where a click takes you, in priority order -- the first field the toast carries wins. */
const CLICK_ROUTES: Array<[keyof Toast, (target: string) => void]> = [
  ['taskId', taskId => window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId } }))],
  ['conversationId', id => useConversationsStore.getState().selectConversation(id)],
  ['surfaceId', id => useModalManagerStore.getState().restore(id)],
]

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(null!)
  if (timersRef.current === null) timersRef.current = new Map()

  useEffect(() => {
    const timers = timersRef.current

    function clearTimer(id: number) {
      const t = timers.get(id)
      if (t) {
        clearTimeout(t)
        timers.delete(id)
      }
    }

    function scheduleAutoDismiss(id: number) {
      clearTimer(id)
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          setToasts(prev => prev.filter(t => t.id !== id))
        }, AUTO_DISMISS_MS),
      )
    }

    function handleToast(e: Event) {
      const { title, meta, body, conversationId, taskId, surfaceId, toastId, variant, persistent, copyText } = (
        e as CustomEvent
      ).detail

      setToasts(prev => {
        // Dedup by toastId: if an existing toast carries the same toastId,
        // REPLACE it in place (preserve numeric id so the React key/timer
        // bookkeeping stays stable). Otherwise append a fresh entry.
        if (toastId) {
          const existing = prev.find(t => t.toastId === toastId)
          if (existing) {
            haptic('tap')
            if (persistent) clearTimer(existing.id)
            else scheduleAutoDismiss(existing.id)
            return prev.map(t =>
              t.id === existing.id
                ? { ...t, title, meta, body, conversationId, taskId, surfaceId, variant, persistent, copyText }
                : t,
            )
          }
        }
        const id = nextId++
        haptic('double')
        if (!persistent) scheduleAutoDismiss(id)
        return [
          ...prev,
          { id, title, meta, body, conversationId, taskId, surfaceId, toastId, variant, persistent, copyText },
        ]
      })
    }

    window.addEventListener('rclaude-toast', handleToast)
    return () => {
      window.removeEventListener('rclaude-toast', handleToast)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  function dismiss(id: number, toastId?: string) {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    if (toastId) {
      window.dispatchEvent(new CustomEvent(`toast-dismissed:${toastId}`))
    }
    setToasts(prev => prev.filter(x => x.id !== id))
  }

  function handleClick(toast: Toast) {
    for (const [key, go] of CLICK_ROUTES) {
      const target = toast[key]
      if (typeof target === 'string' && target) {
        go(target)
        break
      }
    }
    dismiss(toast.id, toast.toastId)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} onClick={() => handleClick(t)} onDismiss={() => dismiss(t.id, t.toastId)} />
      ))}
    </div>
  )
}

import { Copy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'

interface Toast {
  id: number
  title: string
  /** Optional right-aligned chip next to the title (e.g. "7-day · 84%"). */
  meta?: string
  body: string
  conversationId?: string
  taskId?: string
  toastId?: string
  variant?: string
  /** When true, the toast does not auto-dismiss -- the user must close it. */
  persistent?: boolean
  /** When set, the toast renders a copy-to-clipboard button for this string. */
  copyText?: string
}

let nextId = 0
const AUTO_DISMISS_MS = 8000

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
      const { title, meta, body, conversationId, taskId, toastId, variant, persistent, copyText } = (e as CustomEvent)
        .detail

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
                ? { ...t, title, meta, body, conversationId, taskId, variant, persistent, copyText }
                : t,
            )
          }
        }
        const id = nextId++
        haptic('double')
        if (!persistent) scheduleAutoDismiss(id)
        return [...prev, { id, title, meta, body, conversationId, taskId, toastId, variant, persistent, copyText }]
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
    if (toast.taskId) {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: toast.taskId } }))
    } else if (toast.conversationId) {
      useConversationsStore.getState().selectConversation(toast.conversationId)
    }
    dismiss(toast.id, toast.toastId)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        // toast wraps nested copy/dismiss buttons; semantic <button> would nest buttons
        // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
        <div
          key={t.id}
          className={`bg-background border rounded-lg shadow-lg p-3 animate-in slide-in-from-right-5 fade-in duration-200 ${t.variant === 'warning' ? 'border-orange-500/50' : t.variant === 'success' ? 'border-amber-500/50' : 'border-accent/50'} ${t.conversationId || t.taskId ? 'cursor-pointer hover:border-accent' : ''}`}
          onClick={() => handleClick(t)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleClick(t)
          }}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <div
                  className={`text-xs font-bold uppercase tracking-wider ${t.variant === 'warning' ? 'text-orange-400' : 'text-accent'}`}
                >
                  {t.title}
                </div>
                {t.meta ? <div className="text-[10px] font-mono text-muted-foreground shrink-0">{t.meta}</div> : null}
              </div>
              <div className="text-sm text-foreground mt-1 whitespace-pre-line">{t.body}</div>
              {t.copyText ? (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    navigator.clipboard?.writeText(t.copyText!).catch(() => {})
                    haptic('tap')
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded bg-muted hover:bg-muted/70 text-foreground"
                >
                  <Copy className="size-3" />
                  copy command
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                dismiss(t.id, t.toastId)
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

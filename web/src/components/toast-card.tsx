import { projectIdentityKey } from '@shared/project-uri'
import { Copy, X } from 'lucide-react'
import { useMemo } from 'react'
import { Markdown } from '@/components/markdown'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectPath } from '@/lib/types'
import { haptic, projectDisplayName } from '@/lib/utils'
import type { Toast } from './toast'

interface ToastCardProps {
  toast: Toast
  onClick: () => void
  onDismiss: () => void
}

/**
 * One toast card: project name (when the toast is bound to a conversation),
 * title + optional meta chip, a markdown-rendered body, and copy/dismiss
 * controls. Clicking anywhere except the copy/close buttons fires `onClick`
 * (navigate); those two buttons stop propagation.
 */
export function ToastCard({ toast, onClick, onDismiss }: ToastCardProps) {
  // Look up the owning project's display name once per toast. getState() (not a
  // subscription) keeps the always-mounted container from re-rendering on every
  // conversation update; the name is stable across a toast's ~8s lifetime.
  const projectName = useMemo(() => {
    if (!toast.conversationId) return ''
    const s = useConversationsStore.getState()
    const conv = s.conversationsById[toast.conversationId]
    if (!conv) return ''
    const ps = s.projectSettings[projectIdentityKey(conv.project)]
    return projectDisplayName(projectPath(conv.project), ps?.label)
  }, [toast.conversationId])

  const clickable = Boolean(toast.conversationId || toast.taskId)
  const borderClass =
    toast.variant === 'warning'
      ? 'border-orange-500/50'
      : toast.variant === 'success'
        ? 'border-amber-500/50'
        : 'border-accent/50'

  return (
    // toast wraps nested copy/dismiss buttons; semantic <button> would nest buttons
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
    <div
      className={`bg-background border rounded-lg shadow-lg p-3 animate-in slide-in-from-right-5 fade-in duration-200 ${borderClass} ${clickable ? 'cursor-pointer hover:border-accent' : ''}`}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter') onClick()
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {projectName ? (
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground truncate mb-0.5">
              {projectName}
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-2">
            <div
              className={`text-xs font-bold uppercase tracking-wider ${toast.variant === 'warning' ? 'text-orange-400' : 'text-accent'}`}
            >
              {toast.title}
            </div>
            {toast.meta ? (
              <div className="text-[10px] font-mono text-muted-foreground shrink-0">{toast.meta}</div>
            ) : null}
          </div>
          <div className="text-sm text-foreground mt-1">
            <Markdown>{toast.body}</Markdown>
          </div>
          {toast.copyText ? (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                navigator.clipboard?.writeText(toast.copyText!).catch(() => {})
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
            onDismiss()
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  )
}

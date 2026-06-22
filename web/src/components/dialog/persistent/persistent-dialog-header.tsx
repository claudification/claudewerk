/**
 * THE DIALOGUE (D2) — persistent dialog header: title, lifecycle/permission
 * badge, the agent's optional change rationale, and the local Undo control.
 */

import type { DialogStatus } from '@shared/dialog-live'
import { Minus, Undo2, X } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { decodeEntities } from '../decode-entities'

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-primary/15 text-primary border-primary/30',
  closed: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
  orphaned: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  readonly: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
}

export function PersistentDialogHeader({
  title,
  description,
  status,
  readOnly,
  rationale,
  canUndo,
  onUndo,
  onMinimize,
  onClose,
}: {
  title: string
  description?: string
  status: DialogStatus
  readOnly: boolean
  rationale?: string
  canUndo: boolean
  onUndo: () => void
  onMinimize: () => void
  onClose: () => void
}) {
  const badge = readOnly && status === 'open' ? 'readonly' : status
  const badgeLabel = readOnly && status === 'open' ? 'read-only' : status
  const closeTitle = status === 'open' ? 'Close this dialog' : 'Dismiss (remove from view)'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {status === 'open' && !readOnly && (
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
        )}
        <span className="text-[10px] font-mono uppercase tracking-wider text-primary/60">live dialog</span>
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider',
            STATUS_BADGE[badge],
          )}
        >
          {badgeLabel}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {canUndo && (
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={onUndo}>
              <Undo2 className="size-3" />
              Undo
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Minimize to a bar (keeps it in the conversation)"
            aria-label="Minimize dialog"
            onClick={onMinimize}
          >
            <Minus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title={closeTitle}
            aria-label={closeTitle}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <h3 className="text-base font-semibold text-foreground">{decodeEntities(title)}</h3>
      {description && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground">
          <Markdown inline>{description}</Markdown>
        </div>
      )}
      {rationale && (
        <div className="rounded border border-primary/20 bg-primary/5 px-2 py-1 text-xs text-foreground/70">
          <span className="font-semibold text-primary/70">why: </span>
          <Markdown inline>{rationale}</Markdown>
        </div>
      )}
    </div>
  )
}

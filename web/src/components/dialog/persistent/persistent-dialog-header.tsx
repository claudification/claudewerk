/**
 * THE DIALOGUE (D2) — persistent dialog header: title, lifecycle/permission
 * badge, the agent's optional change rationale, and the local Undo control.
 */

import type { DialogStatus } from '@shared/dialog-live'
import { Undo2 } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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
}: {
  title: string
  description?: string
  status: DialogStatus
  readOnly: boolean
  rationale?: string
  canUndo: boolean
  onUndo: () => void
}) {
  const badge = readOnly && status === 'open' ? 'readonly' : status
  const badgeLabel = readOnly && status === 'open' ? 'read-only' : status
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-primary/60">live dialog</span>
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider',
            STATUS_BADGE[badge],
          )}
        >
          {badgeLabel}
        </span>
        {canUndo && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-[10px]" onClick={onUndo}>
            <Undo2 className="size-3" />
            Undo
          </Button>
        )}
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
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

/**
 * THE DIALOGUE (D2) — the "sent to agent" wait surface + the mid-turn error
 * state. Never a dead spinner: it shows agent liveness, a soft-deadline nudge,
 * and a Cancel/keep-editing escape that re-enables the controls (R4#3).
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DialogWaitBar({
  agentActive,
  overdue,
  onCancel,
}: {
  agentActive: boolean
  overdue: boolean
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
      <span className="flex-1 min-w-0 text-foreground/80">
        {agentActive ? 'Agent is working on your input...' : 'Waiting for the agent to pick this up...'}
        {overdue && <span className="ml-1 text-amber-500">taking longer than usual</span>}
      </span>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Keep editing
      </Button>
    </div>
  )
}

export function DialogErrorBar({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-destructive" />
      <span className="flex-1 min-w-0 text-destructive">Send failed: {error}. Your input is intact -- try again.</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

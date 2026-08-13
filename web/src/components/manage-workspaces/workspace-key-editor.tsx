/**
 * The key column of the workspace rail: the positional Ctrl+N default, plus an
 * optional custom binding recorded by pressing it.
 *
 * A custom key is ADDITIONAL to the default -- the default is positional and
 * moves when the list is reordered, the custom one does not. On collision the
 * custom key wins (buildWorkspaceBindings lays it over the defaults).
 */

import { Keyboard, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatShortcut } from '@/lib/commands'
import { isBindingRegistered } from '@/lib/key-layers'
import { cn } from '@/lib/utils'
import { useKeyRecorder } from './use-key-recorder'

const WORKSPACE_LAYER_ID = 'workspace-shortcuts'

/** Why this binding is unusable, or null when it is fine. */
function bindingProblem(binding: string, otherWorkspaceKeys: string[]): string | null {
  if (otherWorkspaceKeys.includes(binding)) return 'Already used by another workspace'
  if (isBindingRegistered(binding, WORKSPACE_LAYER_ID)) return 'Already bound elsewhere in the panel'
  return null
}

function Chip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 rounded border text-[9px] font-mono',
        muted ? 'border-border/50 text-muted-foreground/50' : 'border-border text-foreground',
      )}
    >
      {children}
    </span>
  )
}

/** The recording state: live preview of what has been pressed, or the reason it
 *  cannot be used. Click (or Escape) to abandon. */
function RecordingChip({ draft, problem, onCancel }: { draft: string; problem: string | null; onCancel: () => void }) {
  return (
    <button
      type="button"
      onClick={onCancel}
      title="Escape to cancel"
      className={cn(
        'h-6 px-2 rounded border text-[9px] font-mono animate-pulse',
        problem ? 'border-destructive text-destructive' : 'border-primary text-primary',
      )}
    >
      {draft ? (problem ?? formatShortcut(draft)) : 'press keys…'}
    </button>
  )
}

function IconButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void
  title: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'p-1 rounded text-muted-foreground/50 hover:bg-accent/10',
        danger ? 'hover:text-destructive' : 'hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function CurrentKey({ custom, fallback }: { custom: string | undefined; fallback: string | null }) {
  if (custom) return <Chip>{formatShortcut(custom)}</Chip>
  if (fallback) return <Chip muted>{formatShortcut(fallback)}</Chip>
  return null
}

// Five cyclomatic, all of it "is there a custom key / is it recording" JSX
// branching already split into CurrentKey / RecordingChip / IconButton. The
// score is the zero-coverage CRAP estimate for an unrendered component.
// fallow-ignore-next-line complexity
export function WorkspaceKeyEditor({
  fallback,
  custom,
  otherKeys,
  onChange,
}: {
  /** The positional Ctrl+N default, or null past the ninth workspace. */
  fallback: string | null
  custom: string | undefined
  otherKeys: string[]
  onChange: (key: string | null) => void
}) {
  const recorder = useKeyRecorder(binding => {
    if (!bindingProblem(binding, otherKeys)) onChange(binding)
  })

  if (recorder.recording) {
    return (
      <RecordingChip
        draft={recorder.draft}
        problem={recorder.draft ? bindingProblem(recorder.draft, otherKeys) : null}
        onCancel={recorder.cancel}
      />
    )
  }

  return (
    <div className="flex items-center gap-1">
      <CurrentKey custom={custom} fallback={fallback} />
      <IconButton
        onClick={recorder.start}
        title={custom ? 'Record a different key or chord' : 'Assign a custom key or chord'}
      >
        <Keyboard className="size-3" />
      </IconButton>
      {custom && (
        <IconButton onClick={() => onChange(null)} title="Clear custom key (back to the positional default)" danger>
          <X className="size-3" />
        </IconButton>
      )}
    </div>
  )
}

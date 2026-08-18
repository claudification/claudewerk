/**
 * The epic a card belongs to, at the TOP of the card editor.
 *
 * Opening a child card told you nothing about the larger thing it was part of.
 * The board rail says it in 2px of colour and the editor dropped even that, so
 * the one surface where you actually READ a card was the one surface that
 * hid its parent. Worse, there was no way to get from a child to its epic
 * without closing the editor and hunting the board.
 *
 * Self-contained on purpose: it reads the project cache itself rather than
 * being handed an index. `useProject` is a shim over a PROJECT-KEYED cache, so
 * this costs no extra fetch, and it means the strip works identically at both
 * mount sites (the board, and the overlay beside the transcript) without either
 * one threading an epic index through.
 *
 * Clicking it is a NAVIGATION, not a card swap. It used to hand the epic's card
 * back to the open editor, which left you in the same dialog reading the epic as
 * a kanban card -- no children table, no rollup, no RUN -- and, because the
 * editor seeds its title and body once on mount, showed you the CHILD's text
 * under the epic's header until you saved it over the epic. `revealEpic` opens
 * the surface an epic is actually read on.
 */

import { buildEpicIndex } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { useMemo } from 'react'
import { type ProjectTask, useProject } from '@/hooks/use-project'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { cn, haptic } from '@/lib/utils'
import { cardEpicRole } from './card-epic-role'
import { EpicMarkBadge } from './epic-mark-badge'
import { EpicProgressBar } from './epic-progress'
import { revealEpic } from './reveal-epic'

function Shell({
  epicId,
  children,
  onClick,
  title,
}: {
  epicId: string | null
  children: React.ReactNode
  onClick?: () => void
  title?: string
}) {
  const style = epicId ? epicColorVars(epicHue(epicId)) : undefined
  const className = cn(
    'w-full flex items-center gap-2.5 px-4 py-1.5 shrink-0 text-left border-b border-border/40 border-l-[3px]',
    epicId ? 'border-l-[color:var(--epic-solid)] bg-[color:var(--epic-tint)]' : 'border-l-destructive/50',
    onClick && 'hover:bg-[color:var(--epic-solid)]/15 transition-colors cursor-pointer',
  )
  if (!onClick) {
    return (
      <div style={style} className={className}>
        {children}
      </div>
    )
  }
  return (
    <button type="button" title={title} style={style} className={className} onClick={onClick}>
      {children}
    </button>
  )
}

export function CardEpicStrip({
  task,
  conversationId,
  onNavigate,
}: {
  task: ProjectTask
  conversationId: string
  /** We are leaving this card -- close the editor the strip is sitting in. The
   *  epic opens on the board behind it, and a dialog on top of the surface you
   *  asked to see is the bug this navigation exists to fix. */
  onNavigate: () => void
}) {
  const { tasks } = useProject(conversationId)
  const role = useMemo(() => cardEpicRole(task, buildEpicIndex(tasks)), [task, tasks])

  if (role.kind === 'none') return null

  function goToEpic(epicId: string) {
    haptic('tap')
    revealEpic(conversationId, epicId)
    onNavigate()
  }

  // This card IS an epic. Nowhere to navigate to -- it says what it is and how
  // its children stand, and that is the whole job.
  if (role.kind === 'epic') {
    const r = role.rollup
    return (
      <Shell epicId={task.slug}>
        <EpicMarkBadge epicId={task.slug} variant="solid" />
        <span className="text-chrome font-mono text-[color:var(--epic-solid)]">EPIC</span>
        <EpicProgressBar rollup={r} className="w-16 shrink-0" />
        <span className="font-mono text-meta tabular-nums text-muted-foreground/85">
          {r.done}/{r.total} done
        </span>
        <span className="ml-auto font-mono text-chrome text-muted-foreground/60">
          {r.children.length === 0 ? 'no cards point at it yet' : `${r.children.length} cards`}
        </span>
      </Shell>
    )
  }

  // A child pointing at an epic that is not on this board. Say so rather than
  // drawing a confident chip for something that does not exist.
  //
  // The test is `!rollup.card`, NOT `!rollup`: `buildEpicIndex` still creates a
  // rollup for an id that only children reference -- it just has `card: null`.
  // Checking the rollup alone renders a real-looking strip titled with the raw
  // id, which is exactly the "confident about nothing" failure this branch is
  // here to avoid.
  if (!role.rollup?.card) {
    return (
      <Shell epicId={null}>
        <span aria-hidden className="text-meta text-destructive/70">
          ◈
        </span>
        <span className="font-mono text-meta text-destructive/80">{role.epicId}</span>
        <span className="font-mono text-chrome text-muted-foreground/60">is not on this board</span>
      </Shell>
    )
  }

  const r = role.rollup
  return (
    <Shell epicId={role.epicId} onClick={() => goToEpic(role.epicId)} title={`Open ${role.epicId} on the EPICS view`}>
      <EpicMarkBadge epicId={role.epicId} variant="solid" />
      <span className="font-mono text-read text-foreground truncate">{r.card?.title ?? role.epicId}</span>
      <EpicProgressBar rollup={r} className="w-16 shrink-0" />
      <span className="font-mono text-meta tabular-nums text-muted-foreground/85 shrink-0">
        {r.done}/{r.total}
      </span>
      <span className="ml-auto font-mono text-chrome text-muted-foreground/55 shrink-0">open epic →</span>
    </Shell>
  )
}

/**
 * The accepted-token chips above the Quick Task editor.
 *
 * These exist because the tokens are EATEN on accept: once `@epic-the-wall-ii`
 * disappears from the text, the chip is the only evidence the card is going to
 * be filed into that epic. No chip row = a silent metadata write, which is the
 * one thing a capture box must never do.
 */

import { epicHue } from '@shared/epic-color'
import { X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import type { TaskChips } from '@/lib/cards/task-chips'
import type { TokenKind } from '@/lib/cards/task-tokens'

interface ChipProps {
  kind: TokenKind
  value: string
  label: string
  /** Paint this chip in an epic's own hue. Absent = neutral chip. */
  hue?: number
  onRemove: (kind: TokenKind, value: string) => void
}

function Chip({ kind, value, label, hue, onRemove }: ChipProps) {
  // Same oklch band as the board's swimlanes -- an epic must be the SAME colour
  // here as it is over there, or the chip stops being recognisable as that epic.
  const tint: CSSProperties | undefined =
    hue != null
      ? {
          ...epicColorVars(hue),
          color: 'var(--epic-solid)',
          borderColor: 'var(--epic-edge)',
          backgroundColor: 'var(--epic-tint)',
        }
      : undefined
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-muted/40 text-[10px] font-mono max-w-[14rem]"
      style={tint}
      title={`${kind}: ${value}`}
    >
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={() => onRemove(kind, value)}
        className="shrink-0 opacity-60 hover:opacity-100"
        aria-label={`Remove ${kind} ${value}`}
      >
        <X className="size-2.5" />
      </button>
    </span>
  )
}

const PRIORITY_GLYPH: Record<string, string> = { high: '!!!', medium: '!!', low: '!' }

interface QuickTaskChipsProps {
  chips: TaskChips
  onRemove: (kind: TokenKind, value?: string) => void
}

export function QuickTaskChips({ chips, onRemove }: QuickTaskChipsProps) {
  const has = chips.epic || chips.priority || chips.dependsOn.length > 0 || chips.relatesTo.length > 0
  if (!has) return null

  const remove = (kind: TokenKind, value: string) => onRemove(kind, value)

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
      {chips.epic && (
        <Chip kind="epic" value={chips.epic} label={chips.epic} hue={epicHue(chips.epic)} onRemove={remove} />
      )}
      {chips.priority && (
        <Chip
          kind="priority"
          value={chips.priority}
          label={`${PRIORITY_GLYPH[chips.priority] ?? ''} ${chips.priority}`}
          onRemove={remove}
        />
      )}
      {chips.dependsOn.map(id => (
        <Chip key={`dep-${id}`} kind="dependsOn" value={id} label={`waits on ${id}`} onRemove={remove} />
      ))}
      {chips.relatesTo.map(id => (
        <Chip key={`rel-${id}`} kind="relatesTo" value={id} label={`see ${id}`} onRemove={remove} />
      ))}
    </div>
  )
}

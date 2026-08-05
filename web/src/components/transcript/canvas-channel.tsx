/**
 * A message sent from a CANVAS chat window, rendered as what it is.
 *
 * It used to fall through to the plain-text branch, so the `<selected id=... />`
 * lines the agent reads (see canvas-selected-parse.ts) landed in the bubble as
 * raw XML. Now: the canvas is a link that opens it, and the selection is a row
 * of chips carrying each element's own colours -- so a glance answers "which
 * canvas, pointing at what".
 *
 * Sky hue on purpose: not teal (a peer conversation), not violet (the orb). A
 * canvas is its own kind of sender.
 */

import { openCanvasWindow } from '@/components/canvas/open-canvas-window'
import { useCanvasName } from '@/components/canvas/use-canvas-name'
import { Markdown } from '../markdown'
import type { SelectedChip } from './canvas-selected-parse'
import { ChannelBodyCard, DirectionChip, IntentBadge } from './channel-message-parts'

/** One glyph per element type -- the shape, at chip size. */
const TYPE_GLYPH: Record<string, string> = {
  rectangle: '▭',
  diamond: '◇',
  ellipse: '○',
  arrow: '→',
  line: '—',
  freedraw: '✎',
  text: 'T',
  image: '▣',
  frame: '⬚',
  embeddable: '▤',
}
const DEFAULT_GLYPH = '◆'

/** A dot in the element's own fill, so the chip is recognisable against the
 *  drawing it came from. Transparent fills fall back to the stroke. */
function ColorDot({ chip }: { chip: SelectedChip }) {
  const color = chip.fill && chip.fill !== 'transparent' ? chip.fill : chip.stroke
  if (!color) return null
  return (
    <span aria-hidden className="size-2 shrink-0 rounded-full border border-black/20" style={{ background: color }} />
  )
}

function ElementChip({ chip }: { chip: SelectedChip }) {
  return (
    <span
      title={`${chip.type} ${chip.id}`}
      className="inline-flex max-w-40 items-center gap-1 rounded border border-sky-400/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200/90"
    >
      <ColorDot chip={chip} />
      <span aria-hidden className="opacity-70">
        {TYPE_GLYPH[chip.type] ?? DEFAULT_GLYPH}
      </span>
      <span className="truncate">{chip.label ?? chip.type}</span>
    </span>
  )
}

export interface CanvasChannelProps {
  text: string
  canvasId: string | null
  chips: SelectedChip[]
  census?: { count: number; summary: string }
  intent?: string
}

/** The canvas this came from -- click to open (or focus) its window. */
function CanvasLink({ canvasId }: { canvasId: string }) {
  const name = useCanvasName(canvasId)
  return (
    <button
      type="button"
      onClick={() => openCanvasWindow(canvasId)}
      title={`Open canvas ${canvasId}`}
      className="max-w-64 truncate font-bold text-sky-300 text-xs underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-300"
    >
      {name ?? canvasId.replace(/^cnv_/, '').slice(0, 8)}
    </button>
  )
}

function SelectionRow({ chips, census }: { chips: SelectedChip[]; census?: CanvasChannelProps['census'] }) {
  if (census) {
    return (
      <p className="mb-1.5 text-[10px] text-sky-200/70">
        pointing at <span className="font-bold">{census.count}</span> elements
        {census.summary ? ` (${census.summary})` : ''}
      </p>
    )
  }
  if (chips.length === 0) return null
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-sky-200/60">pointing at</span>
      {chips.map(chip => (
        <ElementChip key={chip.id} chip={chip} />
      ))}
    </div>
  )
}

export function CanvasChannel({ text, canvasId, chips, census, intent }: CanvasChannelProps) {
  return (
    <ChannelBodyCard direction="in" className="border-sky-500/30 border-l-sky-400 bg-sky-500/5">
      <div className="mb-1.5 flex items-center gap-2">
        <DirectionChip direction="in" />
        <span className="font-mono text-[10px] text-sky-400/60">from canvas</span>
        {canvasId ? <CanvasLink canvasId={canvasId} /> : <span className="text-sky-300/70 text-xs">unknown</span>}
        <IntentBadge intent={intent} />
      </div>
      <SelectionRow chips={chips} census={census} />
      <div className="text-sm">
        <Markdown copyable>{text}</Markdown>
      </div>
    </ChannelBodyCard>
  )
}

/**
 * What a `Read` row SHOWS for a TEXT file -- the pieces, as components.
 *
 * They live apart from the case functions in `tool-cases-read.tsx` because a
 * JSX ternary is a branch: with all of this inline, `renderTextRead` scored a
 * cyclomatic 20 and a CRAP of 106 for what is really one summary line and one
 * preview. Each piece here answers exactly one question and stays testable.
 *
 * The binary/image half lives in `read-binary.tsx`.
 */

import { fileLabel } from './tool-file-view'

export interface ReadSpan {
  startLine?: number
  numLines?: number
  totalLines?: number
}

export type ReadExtentModel =
  | { kind: 'total'; total: number }
  | { kind: 'range'; start: number; end: number; total: number }
  | null

/**
 * How much of the file was read. A range only when the read was genuinely
 * partial AND the tool reported enough to name both ends -- an offset with no
 * line count is a read of unknown size, which reads better as the total than as
 * a half-stated range.
 */
export function readExtent({ startLine, numLines, totalLines }: ReadSpan): ReadExtentModel {
  if (!totalLines) return null
  if (!startLine || !numLines) return { kind: 'total', total: totalLines }
  if (startLine === 1 && numLines >= totalLines) return { kind: 'total', total: totalLines }
  return { kind: 'range', start: startLine, end: startLine + numLines - 1, total: totalLines }
}

function ReadExtent(span: ReadSpan) {
  const extent = readExtent(span)
  if (!extent) return null
  if (extent.kind === 'total') {
    return (
      <span className="text-fg-muted shrink-0">
        <span className="text-foreground/70">{extent.total.toLocaleString()}</span>{' '}
        <span className="text-fg-dim">lines</span>
      </span>
    )
  }
  return (
    <span className="text-fg-muted shrink-0">
      lines <span className="text-sky-400">{extent.start}</span>
      <span className="text-fg-dim">-</span>
      <span className="text-sky-400">{extent.end}</span>
      <span className="text-fg-dim"> of </span>
      <span className="text-foreground/70">{extent.total.toLocaleString()}</span>
    </span>
  )
}

export function TextReadSummary({ path, span }: { path: string; span: ReadSpan }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{fileLabel(path)}</span>
      <ReadExtent {...span} />
    </span>
  )
}

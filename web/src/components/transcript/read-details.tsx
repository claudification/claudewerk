/**
 * What a `Read` row SHOWS -- the pieces, as components.
 *
 * They live apart from the case functions in `tool-cases-read.tsx` because a
 * JSX ternary is a branch: with all of this inline, `renderTextRead` scored a
 * cyclomatic 20 and a CRAP of 106 for what is really one summary line and one
 * preview. Each piece here answers exactly one question and stays testable.
 */

import { fileLabel } from './tool-file-view'

export interface BinaryFile {
  url?: string
  type?: string
  originalSize?: number
  dimensions?: { originalWidth: number; originalHeight: number; displayWidth: number; displayHeight: number }
}

function sizeLabel(file?: BinaryFile): string {
  return file?.originalSize ? `${(file.originalSize / 1024).toFixed(0)}KB` : ''
}

function dimLabel(file?: BinaryFile): string {
  const d = file?.dimensions
  return d ? `${d.originalWidth}x${d.originalHeight}` : ''
}

export function BinarySummary({ path, file, type }: { path: string; file?: BinaryFile; type: string }) {
  const size = sizeLabel(file)
  const dims = dimLabel(file)
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{fileLabel(path)}</span>
      {type !== 'image' && <span className="text-violet-400/70 shrink-0">{type}</span>}
      {dims && <span className="text-cyan-400/70 shrink-0">{dims}</span>}
      {size && <span className="text-fg-dim shrink-0">({size})</span>}
    </span>
  )
}

export function BinaryDetails({ path, file, isImage }: { path: string; file?: BinaryFile; isImage: boolean }) {
  if (file?.url && isImage) {
    return (
      <div className="space-y-1.5 py-1">
        <img
          src={file.url}
          alt={path?.split('/').pop() || 'image'}
          className="max-w-sm max-h-64 rounded border border-border hover:border-primary/50 transition-colors"
          loading="lazy"
        />
      </div>
    )
  }
  const size = sizeLabel(file)
  if (file?.url) {
    return (
      <div className="text-[10px] font-mono flex items-center gap-2 py-1">
        {file.type && <span className="text-muted-foreground">{file.type}</span>}
        {size && <span className="text-muted-foreground">{size}</span>}
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-accent/80 underline"
        >
          view file
        </a>
      </div>
    )
  }
  return (
    <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-2 py-1">
      {file?.type && <span>{file.type}</span>}
      {dimLabel(file) && <span>{dimLabel(file)}</span>}
      {size && <span>{size}</span>}
      <span className="text-amber-400/70">(file not available)</span>
    </div>
  )
}

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

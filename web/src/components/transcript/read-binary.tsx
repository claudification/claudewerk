/**
 * What a `Read` row shows for a BINARY file -- an image, a PDF, anything the
 * transcript renders as an artifact rather than as text. Split out of
 * `read-details.tsx` when the image-scale suffix pushed that file past the size
 * bar; the two halves share nothing but `fileLabel`, and a text read never asks
 * a question this file answers.
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

export interface ImageScaleModel {
  width: number
  height: number
  factor: number
}

/**
 * How far the image was shrunk before the model saw it, or null when it was not.
 *
 * Claude Code announces this in a separate injected message ("[Image: original
 * 736x2854, displayed at 516x2000. Multiply coordinates by 1.43...]") that landed
 * a full screen below the Read row and, until `grouping/harness-meta.ts`, wore the
 * user's own bubble. The same four numbers are already on `toolUseResult.file
 * .dimensions`, so the row states it itself and the injected copy is dropped.
 *
 * It matters when pointing at coordinates in a screenshot: the model reads the
 * DISPLAYED pixels, so "the button at x=400" means something different at each end.
 */
export function imageScale(d?: BinaryFile['dimensions']): ImageScaleModel | null {
  if (!d?.displayWidth || !d.originalWidth) return null
  if (d.displayWidth === d.originalWidth && d.displayHeight === d.originalHeight) return null
  return {
    width: d.displayWidth,
    height: d.displayHeight,
    factor: Math.round((d.originalWidth / d.displayWidth) * 100) / 100,
  }
}

function ImageScale({ scale }: { scale: ImageScaleModel }) {
  return (
    <span className="text-fg-muted shrink-0" title="the model saw a downscaled copy">
      <span className="text-fg-dim">-&gt;</span> {scale.width}x{scale.height}{' '}
      <span className="text-fg-dim">(x{scale.factor})</span>
    </span>
  )
}

export function BinarySummary({ path, file, type }: { path: string; file?: BinaryFile; type: string }) {
  const size = sizeLabel(file)
  const dims = dimLabel(file)
  const scale = imageScale(file?.dimensions)
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate text-foreground/90">{fileLabel(path)}</span>
      {type !== 'image' && <span className="text-violet-400/70 shrink-0">{type}</span>}
      {dims && <span className="text-cyan-400/70 shrink-0">{dims}</span>}
      {scale && <ImageScale scale={scale} />}
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

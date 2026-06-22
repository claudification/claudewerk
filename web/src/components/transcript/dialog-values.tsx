/**
 * Renders a submitted dialog form's values as a compact key/value list (used by
 * both DialogChannel and DialogSubmitChannel). Each value type renders through a
 * small dedicated cell; a Draw value renders as an inline PNG thumbnail (the
 * `thumbUrl` attached on submit) with a graceful label fallback.
 */
import { type DrawValue, isDrawValue } from '@shared/draw'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

/** A submitted Draw value: inline thumbnail when available, else a size label. */
function DrawThumbnail({ value }: { value: DrawValue }) {
  const [failed, setFailed] = useState(false)
  const sizeKb = Math.max(1, Math.round(value.bytes / 1024))
  if (value.thumbUrl && !failed) {
    return (
      <img
        src={value.thumbUrl}
        alt="drawing"
        onError={() => setFailed(true)}
        className="max-h-48 max-w-full rounded border border-violet-500/25 bg-white object-contain"
      />
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[10px] text-violet-300">
      <Pencil className="size-3" /> drawing ({sizeKb} KB)
    </span>
  )
}

function BoolBadge({ val }: { val: boolean }) {
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 rounded text-[9px] font-bold border',
        val
          ? 'bg-green-500/15 text-green-400 border-green-500/30'
          : 'bg-zinc-500/15 text-muted-foreground/50 border-zinc-500/20',
      )}
    >
      {String(val)}
    </span>
  )
}

function ArrayBadges({ items }: { items: unknown[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((v, j) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: display-only array values, no stable IDs
          // react-doctor-disable-next-line react-doctor/no-array-index-key
          key={j}
          className="px-1.5 py-0.5 bg-violet-500/15 text-violet-300 border border-violet-500/25 rounded text-[9px]"
        >
          {String(v)}
        </span>
      ))}
    </span>
  )
}

// Nested object value, e.g. a commentable diagram's per-node notes (`{ nodeId: note }`).
// Render as a sub-list instead of [object Object].
function NestedObject({ obj }: { obj: Record<string, unknown> }) {
  return (
    <span className="flex flex-col gap-0.5">
      {Object.entries(obj).map(([k, v]) => (
        <span key={k} className="flex items-start gap-1.5">
          <span className="text-violet-300/70 shrink-0">{k}:</span>
          <span className="text-foreground/80 break-all">{String(v)}</span>
        </span>
      ))}
    </span>
  )
}

/** Dispatch a single submitted value to the right cell renderer. */
function ValueCell({ val }: { val: unknown }) {
  if (isDrawValue(val)) return <DrawThumbnail value={val} />
  if (typeof val === 'boolean') return <BoolBadge val={val} />
  if (Array.isArray(val)) return <ArrayBadges items={val} />
  if (typeof val === 'string' && val.length > 0) return <span className="text-foreground/90">{val}</span>
  if (val !== null && typeof val === 'object') return <NestedObject obj={val as Record<string, unknown>} />
  return <span className="text-muted-foreground/50">{String(val)}</span>
}

/** Render a submitted form's values as a compact key/value list. */
export function DialogValues({ values }: { values: Array<[string, unknown]> }) {
  return (
    <div className="text-[11px] font-mono space-y-1">
      {values.map(([key, val]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="text-violet-400 font-bold shrink-0">{key}</span>
          <span className="text-foreground/80 break-all">
            <ValueCell val={val} />
          </span>
        </div>
      ))}
    </div>
  )
}

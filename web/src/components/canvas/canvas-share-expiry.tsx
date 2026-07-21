/**
 * Lifetime controls for a canvas share: pick how long the next link lives, and
 * see/extend how long the live one has left.
 *
 * Split from canvas-share-control.tsx to keep both under the .tsx size bar.
 */

import { haptic } from '@/lib/utils'
import { type CanvasShareState, SHARE_DURATIONS } from './use-canvas-share'

/** "6h left" / "12m left" / "3d left", or null once the deadline has passed. */
export function formatRemaining(expiresAt: number, now = Date.now()): string | null {
  const ms = expiresAt - now
  if (ms <= 0) return null
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${Math.max(1, mins)}m left`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h left`
  return `${Math.floor(hours / 24)}d left`
}

function DurationPicker({ s }: { s: CanvasShareState }) {
  return (
    <label className="flex items-center gap-1.5 px-1">
      <span className="text-[10px] text-muted-foreground/70 shrink-0">Link lasts</span>
      <select
        value={s.hours === null ? 'never' : String(s.hours)}
        disabled={s.busy}
        onChange={e => {
          haptic('tap')
          s.setHours(e.target.value === 'never' ? null : Number(e.target.value))
        }}
        className="flex-1 min-w-0 bg-muted/30 border border-border px-1 py-0.5 text-[11px] font-mono disabled:opacity-50"
      >
        {SHARE_DURATIONS.map(d => (
          <option key={d.label} value={d.hours === null ? 'never' : String(d.hours)}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Countdown + extend for a live link. Silent when the share never expires. */
function ExpiryRow({ s }: { s: CanvasShareState }) {
  if (s.expiresAt == null) return <span className="text-[10px] text-muted-foreground/60 px-1">Never expires</span>
  const remaining = formatRemaining(s.expiresAt)
  return (
    <div className="flex items-center gap-2 px-1">
      <span className={`text-[10px] ${remaining ? 'text-muted-foreground/70' : 'text-red-400/90'}`}>
        {remaining ?? 'Expired'}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        disabled={s.busy}
        onClick={() => void s.extend()}
        className="text-[10px] px-1.5 py-0.5 border border-border hover:border-sky-400/60 disabled:opacity-50"
      >
        extend
      </button>
    </div>
  )
}

export function CanvasShareExpiry({ s }: { s: CanvasShareState }) {
  return (
    <>
      <DurationPicker s={s} />
      {s.shared && <ExpiryRow s={s} />}
    </>
  )
}

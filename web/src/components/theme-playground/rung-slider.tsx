import { parseOklch } from '@/lib/theme-ladder'
import type { Rung } from './rung-catalog'

interface Props {
  rung: Rung
  value: string
  /** ΔL to the rung below, when there is one. Red under the floor. */
  step?: number
  floor: number
  onLightness: (l: number) => void
  onChroma: (c: number) => void
}

/**
 * One rung: a swatch, the L slider that does most of the work, and a chroma
 * slider for when a neutral goes muddy at the top of the ramp.
 *
 * The ΔL readout sits ON the row rather than in a summary elsewhere, because
 * the mistake this whole exercise exists to prevent -- two surfaces too close
 * to tell apart -- is invisible unless the number is next to the thing.
 */
export function RungSlider({ rung, value, step, floor, onLightness, onChroma }: Props) {
  const parsed = parseOklch(value)
  if (!parsed) return null
  const tooClose = step !== undefined && step > 0 && step < floor

  return (
    <div className="flex items-center gap-2.5 py-1">
      <span
        className="size-7 shrink-0 rounded border border-border-strong"
        style={{ background: value }}
        aria-hidden="true"
      />
      <div className="w-28 shrink-0">
        <div className="text-[11px] leading-tight">{rung.label}</div>
        <div className="text-fg-faint text-[9px] leading-tight truncate" title={rung.role}>
          {rung.role}
        </div>
      </div>

      <label className="flex flex-1 items-center gap-1.5 min-w-0">
        <span className="text-fg-faint text-[9px] w-3">L</span>
        <input
          type="range"
          min={0.02}
          max={0.99}
          step={0.005}
          value={parsed.l}
          onChange={e => onLightness(Number(e.target.value))}
          className="flex-1 min-w-0 accent-accent"
          aria-label={`${rung.label} lightness`}
        />
        <span className="text-fg-dim w-9 text-right text-[10px] tabular-nums">{parsed.l.toFixed(3)}</span>
      </label>

      <label className="flex w-28 items-center gap-1.5 shrink-0">
        <span className="text-fg-faint text-[9px] w-3">C</span>
        <input
          type="range"
          min={0}
          max={0.3}
          step={0.002}
          value={parsed.c}
          onChange={e => onChroma(Number(e.target.value))}
          className="flex-1 min-w-0 accent-accent"
          aria-label={`${rung.label} chroma`}
        />
      </label>

      <span
        className={`w-14 shrink-0 text-right text-[10px] tabular-nums ${tooClose ? 'text-destructive' : 'text-fg-faint'}`}
        title={tooClose ? `ΔL ${step?.toFixed(3)} is under the ${floor} floor -- this edge will not read` : undefined}
      >
        {step === undefined ? '' : step === 0 ? 'flat' : `Δ${step.toFixed(3)}`}
      </span>
    </div>
  )
}

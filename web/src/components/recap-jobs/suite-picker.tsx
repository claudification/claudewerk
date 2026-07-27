/**
 * Model-suite picker for the recap config dialog.
 *
 * Its own file rather than another block inside recap-config-dialog.tsx, which
 * is already well past the .tsx size bar (SPLIT DISCIPLINE -- don't propagate).
 *
 * Labels, blurbs and prices all come from the SHARED registry, so the panel can
 * never drift from what the broker will actually run. "Auto" is the default and
 * is a real choice, not a null: it means "let the broker decide", which is what
 * routes background recaps to cheap and anything you are waiting on to accurate.
 */

import { listSuites, type RecapSuiteId } from '@shared/recap-suites'

export interface SuitePickerProps {
  /** undefined = Auto (let the broker resolve it). */
  value: RecapSuiteId | undefined
  onChange: (v: RecapSuiteId | undefined) => void
}

const AUTO_BLURB = 'Cheap for scheduled background recaps, accurate for anything you asked for.'

export function SuitePicker({ value, onChange }: SuitePickerProps) {
  const suites = listSuites()
  return (
    <div>
      <span className="block mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Synthesis model</span>
      <div className="flex flex-col gap-1">
        <SuiteOption
          selected={value === undefined}
          onSelect={() => onChange(undefined)}
          title="Auto"
          blurb={AUTO_BLURB}
        />
        {suites.map(s => (
          <SuiteOption
            key={s.id}
            selected={value === s.id}
            onSelect={() => onChange(s.id)}
            title={s.label}
            blurb={s.description}
            price={`~$${s.approxSynthesisUsd.toFixed(2)}`}
          />
        ))}
      </div>
    </div>
  )
}

interface SuiteOptionProps {
  selected: boolean
  onSelect: () => void
  title: string
  blurb: string
  price?: string
}

function SuiteOption({ selected, onSelect, title, blurb, price }: SuiteOptionProps) {
  return (
    <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
      <input
        type="radio"
        name="recap-suite"
        checked={selected}
        onChange={onSelect}
        className="mt-0.5 size-3.5 border-input accent-accent"
      />
      <span>
        <span className="text-foreground">{title}</span>
        {price && <span className="ml-1.5 text-[11px] text-muted-foreground tabular-nums">{price}</span>}
        <span className="block text-[11px] text-muted-foreground">{blurb}</span>
      </span>
    </label>
  )
}

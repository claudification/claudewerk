/**
 * Shared chrome for the Experiments "lab" sections (Virtualizer Lab, Plain
 * Renderer Lab): the non-default summary + reset header, and the knob rows
 * themselves. Both labs are the same shape -- a table of bool/select knobs over
 * a prefs object with a defaults object -- so they render through here rather
 * than each keeping its own copy of the row markup.
 */

import { SettingRow } from './settings-inputs'

export type LabValue = boolean | string | number

export type LabKnob<K extends string> =
  | { key: K; kind: 'bool'; label: string; description: string }
  | { key: K; kind: 'select'; label: string; description: string; options: Array<string | number> }

export function LabResetHeader({ summary, onReset }: { summary: string | null; onReset: () => void }) {
  return (
    <div className="flex items-center justify-between text-[10px] font-mono">
      <span className={summary ? 'text-amber-500' : 'text-muted-foreground'}>
        {summary ? `active: ${summary}` : 'all defaults'}
      </span>
      {summary && (
        <button
          type="button"
          onClick={onReset}
          className="px-1.5 py-0.5 border border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          reset all
        </button>
      )}
    </div>
  )
}

export function LabKnobRows<K extends string>({
  knobs,
  values,
  defaults,
  onChange,
}: {
  knobs: Array<LabKnob<K>>
  values: Record<K, LabValue>
  defaults: Record<K, LabValue>
  onChange: (key: K, value: LabValue) => void
}) {
  return (
    <>
      {knobs.map(knob => (
        <SettingRow key={knob.key} label={knob.label} description={knob.description}>
          <div className="flex items-center gap-1.5">
            {values[knob.key] !== defaults[knob.key] && (
              <span className="size-1.5 rounded-full bg-amber-500" title="non-default" />
            )}
            {knob.kind === 'bool' ? (
              <input
                aria-label={knob.label}
                type="checkbox"
                checked={values[knob.key] as boolean}
                onChange={e => onChange(knob.key, e.target.checked)}
                className="accent-primary size-4"
              />
            ) : (
              <select
                aria-label={knob.label}
                value={String(values[knob.key])}
                onChange={e => {
                  const raw = e.target.value
                  const asNum = Number(raw)
                  onChange(knob.key, Number.isNaN(asNum) ? raw : asNum)
                }}
                className="bg-card border border-border text-foreground text-[10px] px-1 py-0.5 font-mono"
              >
                {knob.options.map(o => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </SettingRow>
      ))}
    </>
  )
}

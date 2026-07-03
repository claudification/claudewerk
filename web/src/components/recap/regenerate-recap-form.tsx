/**
 * The fields + footer of the Regenerate modal (state lives here; the Dialog
 * chrome lives in regenerate-recap-modal.tsx). Collects the knobs for a
 * recap_regenerate fork: variant name, synthesize model, refinement
 * instructions (prefilled with what the current write-up used + a preset
 * picker), and sampling (temperature / max tokens).
 */

import type { PeriodRecapDoc } from '@shared/protocol'
import { useEffect, useState } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { DEFAULT_RECAP_MODEL, RECAP_MODEL_OPTIONS } from './recap-forks'
import { RecapPresetPicker } from './recap-preset-picker'
import { RegenerateSamplingRow } from './regenerate-sampling-row'

/** The knobs the modal emits; instructions is always sent (empty clears). */
export interface RegenerateTuning {
  model: string
  instructions: string
  variantLabel: string
  temperature: number
  maxTokens?: number
}

const LABEL = 'block mb-1 text-[11px] uppercase tracking-wide text-muted-foreground'
const OPTIONAL = <span className="normal-case tracking-normal">(optional)</span>

function initialModel(recap: PeriodRecapDoc): string {
  if (recap.model && RECAP_MODEL_OPTIONS.some(o => o.slug === recap.model)) return recap.model
  return DEFAULT_RECAP_MODEL
}

export function RegenerateRecapForm({
  recap,
  busy,
  onClose,
  onSubmit,
}: {
  recap: PeriodRecapDoc
  busy: boolean
  onClose: () => void
  onSubmit: (tuning: RegenerateTuning) => void
}) {
  const [model, setModel] = useState(() => initialModel(recap))
  const [instructions, setInstructions] = useState(recap.instructions ?? '')
  const [variantLabel, setVariantLabel] = useState(recap.variantLabel ?? '')
  const [temperature, setTemperature] = useState(0.2)
  const [maxTokens, setMaxTokens] = useState('')

  // Re-seed if the recap behind the modal changes (a variant switch).
  useEffect(() => {
    setModel(initialModel(recap))
    setInstructions(recap.instructions ?? '')
    setVariantLabel(recap.variantLabel ?? '')
    setTemperature(0.2)
    setMaxTokens('')
  }, [recap])

  function submit() {
    if (busy) return
    haptic('success')
    const mt = maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined
    onSubmit({
      model,
      instructions,
      variantLabel: variantLabel.trim(),
      temperature,
      ...(mt && Number.isFinite(mt) ? { maxTokens: mt } : {}),
    })
  }

  useKeyLayer({ Escape: () => onClose() }, { enabled: true })

  const offList = !RECAP_MODEL_OPTIONS.some(o => o.slug === model)

  return (
    <>
      <div className="space-y-3">
        <label className="block">
          <span className={LABEL}>Variant name {OPTIONAL}</span>
          <input
            value={variantLabel}
            onChange={e => setVariantLabel(e.target.value)}
            placeholder="e.g. Client-safe, Punchy, Opus vs Sonnet"
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          />
        </label>

        <label className="block">
          <span className={LABEL}>Model</span>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
          >
            {RECAP_MODEL_OPTIONS.map(o => (
              <option key={o.slug} value={o.slug}>
                {o.label}
              </option>
            ))}
            {offList && <option value={model}>{model}</option>}
          </select>
        </label>

        <div>
          <span className={LABEL}>Refinement instructions {OPTIONAL}</span>
          <textarea
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            rows={3}
            placeholder="e.g. focus on the auth migration; skip the testing troubles"
            className="w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground/60"
          />
          <div className="mt-1.5">
            <RecapPresetPicker value={instructions} onPick={setInstructions} />
          </div>
        </div>

        <RegenerateSamplingRow
          temperature={temperature}
          onTemperature={setTemperature}
          maxTokens={maxTokens}
          onMaxTokens={setMaxTokens}
        />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted/50"
        >
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Regenerate'}
        </button>
      </div>
    </>
  )
}

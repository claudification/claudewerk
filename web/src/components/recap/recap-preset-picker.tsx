/**
 * Preset chips for the Regenerate modal's instructions box: built-in starters +
 * the user's saved presets, with a "save current" affordance. Clicking a chip
 * drops its text into the instructions box (via onPick); the ✕ deletes a saved
 * preset. Purely a convenience over the free-text field.
 */

import { useState } from 'react'
import { haptic } from '@/lib/utils'
import { allPresets, deleteUserPreset, saveUserPreset } from './recap-presets'

export function RecapPresetPicker({ value, onPick }: { value: string; onPick: (instructions: string) => void }) {
  const [presets, setPresets] = useState(() => allPresets())
  const [saveLabel, setSaveLabel] = useState('')
  const [showSave, setShowSave] = useState(false)

  function save() {
    if (!saveUserPreset(saveLabel, value)) return
    setSaveLabel('')
    setShowSave(false)
    setPresets(allPresets())
  }

  function remove(id: string) {
    deleteUserPreset(id)
    setPresets(allPresets())
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map(p => (
          <span key={p.id} className="inline-flex items-center">
            <button
              type="button"
              title={p.instructions}
              onClick={() => {
                haptic('tap')
                onPick(p.instructions)
              }}
              className="px-2 py-0.5 text-[11px] rounded-full border border-border text-muted-foreground hover:bg-muted/60"
            >
              {p.label}
            </button>
            {!p.builtin && (
              <button
                type="button"
                title="Delete preset"
                onClick={() => remove(p.id)}
                className="ml-0.5 text-[11px] text-muted-foreground/60 hover:text-red-400"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => setShowSave(s => !s)}
          className="px-2 py-0.5 text-[11px] rounded-full border border-dashed border-border text-muted-foreground hover:bg-muted/60 disabled:opacity-40"
        >
          + Save current
        </button>
      </div>
      {showSave && (
        <div className="flex gap-1.5">
          <input
            value={saveLabel}
            onChange={e => setSaveLabel(e.target.value)}
            placeholder="Preset name"
            className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={!saveLabel.trim()}
            onClick={save}
            className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}
    </div>
  )
}

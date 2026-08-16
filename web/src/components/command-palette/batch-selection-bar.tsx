/**
 * The strip between the filters and the table: what matched, how it is grouped,
 * and the bulk-selection controls.
 *
 * The "select everything past the cap" confirm used to sit in the bar
 * permanently -- an input plus an amber button shouting at you even when you
 * had nothing selected. It hides behind its own button now and only unfolds
 * when you ask for it.
 */

import { useState } from 'react'
import { cn } from '@/lib/utils'

const BTN = 'h-6 px-2 rounded-sm bg-muted/30 hover:bg-muted/50 transition-colors'

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer hover:text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="cursor-pointer accent-accent"
      />
      {label}
    </label>
  )
}

export function BatchSelectionBar({
  matches,
  visibleSelected,
  cap,
  groupByProject,
  onGroupByProject,
  selectedOnly,
  onSelectedOnly,
  showSelectedOnly,
  onSelectVisible,
  onInvert,
  onSelectAll,
  onClear,
}: {
  matches: number
  visibleSelected: number
  cap: number
  groupByProject: boolean
  onGroupByProject: (v: boolean) => void
  selectedOnly: boolean
  onSelectedOnly: (v: boolean) => void
  showSelectedOnly: boolean
  onSelectVisible: () => void
  onInvert: () => void
  onSelectAll: () => void
  onClear: () => void
}) {
  // The confirm remembers WHICH match count it was opened for, so a phrase typed
  // against a different result set can never carry over -- change the filters and
  // the panel folds itself away instead of arming a stale "select 77".
  const [confirm, setConfirm] = useState<{ forCount: number; text: string } | null>(null)
  const confirmOpen = confirm?.forCount === matches
  const confirmText = confirmOpen ? confirm.text : ''
  const phrase = `select ${matches}`
  const overCap = matches > cap

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/40 text-[10px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          {matches} matches{visibleSelected > 0 && ` · ${visibleSelected} sel`}
        </span>
        <Check label="group by project" checked={groupByProject} onChange={onGroupByProject} />
        {showSelectedOnly && <Check label="selected only" checked={selectedOnly} onChange={onSelectedOnly} />}
      </div>
      <div className="flex items-center gap-1.5">
        {confirmOpen ? (
          <>
            <input
              // biome-ignore lint/a11y/noAutofocus: the field only exists because the user just asked for it
              autoFocus
              aria-label="Type the confirmation phrase to select every match"
              placeholder={`type "${phrase}"`}
              value={confirmText}
              onChange={e => setConfirm({ forCount: matches, text: e.target.value })}
              className="h-6 w-36 bg-muted/20 px-2 border border-border/40 rounded-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={confirmText.trim() !== phrase}
              onClick={onSelectAll}
              className="h-6 px-2 rounded-sm bg-amber-500/20 text-amber-400 disabled:opacity-40 hover:bg-amber-500/30"
            >
              Confirm
            </button>
            <button type="button" onClick={() => setConfirm(null)} className={BTN}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onSelectVisible} className={BTN} title="Hotkey: a">
              Select visible <span className="text-muted-foreground/50">(max {cap})</span>
            </button>
            <button type="button" onClick={onInvert} className={BTN} title="Hotkey: i">
              Invert
            </button>
            {overCap && (
              <button
                type="button"
                onClick={() => setConfirm({ forCount: matches, text: '' })}
                className={cn(BTN, 'text-amber-400/90 hover:text-amber-400')}
              >
                Select all {matches}...
              </button>
            )}
            <button type="button" onClick={onClear} className="h-6 px-2 rounded-sm hover:bg-muted/30">
              Clear
            </button>
          </>
        )}
      </div>
    </div>
  )
}

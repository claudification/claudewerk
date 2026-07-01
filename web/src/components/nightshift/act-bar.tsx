/**
 * ACT-ON-RESULTS bar (plan §4) -- the run-level actions on the morning report.
 * Each button spawns an ordinary fleet agent pointed at `.nightshift/latest`
 * (see use-act.ts). Lazy-loaded by nightshift-report so the chunk + the freeform
 * textarea ship only when a run is actually on screen.
 */

import type { NightshiftActKind } from '@shared/nightshift-act'
import { useState } from 'react'
import type { UseAct } from './use-act'

interface Props {
  act: UseAct
  /** Whether the run has any ready-to-review tasks (gates integrate/test/bundle). */
  hasReady: boolean
}

function ActButton({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  const base =
    'text-xs font-mono px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const tone = primary
    ? 'border-green-800 text-green-300 hover:bg-green-950/40'
    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tone}`}>
      {label}
    </button>
  )
}

const DISCARD_SEED = 'Discard task # because '

export function ActBar({ act, hasReady }: Props) {
  const { runAct, busy, feedback } = act
  const [freeformOpen, setFreeformOpen] = useState(false)
  const [text, setText] = useState('')

  function openFreeform(seed: string) {
    setText(seed)
    setFreeformOpen(true)
  }

  function submitFreeform() {
    const t = text.trim()
    if (!t) return
    void runAct('freeform', { freeform: t })
    setText('')
    setFreeformOpen(false)
  }

  function fire(kind: NightshiftActKind) {
    void runAct(kind)
  }

  return (
    <section className="rounded-md border border-border bg-card/60 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Act on results</h2>
        {busy && <span className="text-xs text-muted-foreground animate-pulse">spawning…</span>}
      </div>

      <div className="flex flex-wrap gap-2">
        <ActButton label="Integrate all green" primary onClick={() => fire('integrate')} disabled={busy || !hasReady} />
        <ActButton label="Test all" onClick={() => fire('test')} disabled={busy || !hasReady} />
        <ActButton label="Bundle" onClick={() => fire('bundle')} disabled={busy || !hasReady} />
        <ActButton label="Discard…" onClick={() => openFreeform(DISCARD_SEED)} disabled={busy} />
        <ActButton label="Spawn…" onClick={() => openFreeform('')} disabled={busy} />
      </div>

      {freeformOpen && (
        <div className="space-y-2 pt-1">
          <textarea
            aria-label="Freeform agent command"
            value={text}
            onChange={e => setText(e.target.value)}
            rows={3}
            placeholder="read .nightshift/latest, integrate 1 and 2, open a PR for 3"
            className="w-full text-xs font-mono rounded border border-border bg-background p-2 resize-y focus:outline-none focus:border-foreground/40"
          />
          <div className="flex gap-2">
            <ActButton label="Spawn agent" primary onClick={submitFreeform} disabled={busy || !text.trim()} />
            <ActButton
              label="Cancel"
              onClick={() => {
                setFreeformOpen(false)
                setText('')
              }}
            />
          </div>
        </div>
      )}

      {feedback && (
        <p className={`text-xs font-mono ${feedback.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {feedback.text}
        </p>
      )}
    </section>
  )
}

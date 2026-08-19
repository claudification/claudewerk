/**
 * The "+ Add…" affordance at the bottom of the inbox lane.
 *
 * Lifted out of project-board.tsx, where it was 65 lines inside an already
 * oversized file -- and where the commit path was written twice, once for the
 * editor's onSubmit and once for the Add button, so the two could drift on any
 * edit that only remembered one of them.
 */

import { useState } from 'react'
import { haptic } from '@/lib/utils'
import { InputEditor } from '../input-editor'

export function InlineAdd({ onAdd }: { onAdd: (text: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')

  function reset() {
    setText('')
    setAdding(false)
  }

  /** The single commit path. Blank input is a no-op, not a cancel. */
  function commit() {
    const trimmed = text.trim()
    if (!trimmed) return
    haptic('success')
    onAdd(trimmed)
    reset()
  }

  if (!adding) {
    return (
      <button
        type="button"
        className="w-full px-3 py-1.5 text-[10px] text-fg-dim hover:text-foreground hover:bg-surface-inset/50 transition-colors font-mono text-left"
        onClick={() => {
          haptic('tap')
          setAdding(true)
        }}
      >
        + Add…
      </button>
    )
  }

  return (
    <div className="px-2 py-1.5 border-t border-border">
      <InputEditor value={text} onChange={setText} onSubmit={commit} placeholder="Description..." autoFocus inline />
      <div className="flex items-center gap-2 mt-1">
        <button type="button" className="text-[10px] text-accent font-mono hover:text-accent/80" onClick={commit}>
          Add
        </button>
        <button
          type="button"
          className="text-[10px] text-muted-foreground font-mono hover:text-foreground"
          onClick={reset}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

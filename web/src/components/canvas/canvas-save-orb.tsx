/**
 * The canvas save indicator, reduced to a single calm orb.
 *
 * Deliberately quiet: a hollow ring at rest (idle / saved), a subtle monochrome
 * pulse of that same ring while a save is in flight (no colour -- a steady green
 * dot just nags), and only an ERROR turns it solid red. Clicking a red orb
 * reveals the failure reason. It subscribes to the save store directly so a
 * save never re-renders anything but this dot.
 */

import { useState, useSyncExternalStore } from 'react'
import type { SaveStateStore } from './canvas-save-store'

const DOT = 'h-2.5 w-2.5 rounded-full transition-colors'

/** Solid red dot; click toggles a small popover with the failure reason. */
function ErrorOrb({ detail }: { detail: string }) {
  const [reveal, setReveal] = useState(false)
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={() => setReveal(r => !r)}
        title={detail}
        aria-label={`Save failed: ${detail}`}
        className={`${DOT} block bg-red-500 hover:bg-red-400`}
      />
      {reveal && (
        <span className="absolute right-0 top-4 z-50 w-52 border border-red-500/40 bg-background p-2 text-[10px] text-red-300/90 shadow-lg">
          {detail}
        </span>
      )}
    </span>
  )
}

/** Hollow ring; a subtle pulse while saving, still at rest otherwise. */
function RestingOrb({ saving }: { saving: boolean }) {
  const pulse = saving ? 'animate-pulse border-muted-foreground/80' : ''
  return (
    <span
      title={saving ? 'saving...' : 'saved'}
      aria-label={saving ? 'saving' : 'saved'}
      className={`${DOT} shrink-0 border border-muted-foreground/50 ${pulse}`}
    />
  )
}

export function CanvasSaveOrb({ store }: { store: SaveStateStore }) {
  const snap = useSyncExternalStore(store.subscribe, store.get)
  if (snap.state === 'error') return <ErrorOrb detail={snap.detail ?? 'Save failed'} />
  return <RestingOrb saving={snap.state === 'saving'} />
}

/**
 * The time cursor's shape work, with no React and no store in it.
 *
 * Three questions the wall asks of an offset, all of which can be wrong in ways
 * a screenshot will not show:
 *
 *  1. WHAT DOES THE HEADER SAY  -- `formatCursorOffset`
 *  2. DID THIS ROW EXIST THEN   -- `existedAtCursor`, over an age
 *  3. WHAT WAS THE VALUE THEN   -- `ringValueAtCursor`, over a positional ring
 *
 * (3) is the one with teeth. A pane that has no reading at the cursor must SAY
 * so; interpolating one, or falling back to the live number, prints a value that
 * was never measured under a header that says it was.
 */

/** `LIVE`, or how far back the cursor is: `T-9m`, `T-1h42m`, `T-3h`. */
export function formatCursorOffset(offsetMs: number): string {
  if (offsetMs <= 0) return 'LIVE'
  const minutes = Math.round(offsetMs / 60_000)
  if (minutes < 60) return `T-${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `T-${h}h` : `T-${h}h${m}m`
}

/**
 * Was a row of this age already on the wall at the cursor?
 *
 * `ageMs` is measured from the row's own clock -- last activity for a
 * conversation, commit time for a commit, `since` for a blocked seat -- so
 * "older than the cursor" is exactly "already in this state when the cursor
 * points". A row with NO age is KEPT: the same rule `axes.ts` runs on, since a
 * pane must never be blanked by a facet its rows do not carry.
 */
export function existedAtCursor(ageMs: number | undefined, offsetMs: number): boolean {
  if (offsetMs <= 0 || ageMs === undefined) return true
  return ageMs >= offsetMs
}

/**
 * A POSITIONAL ring, read at an offset. `null` when the ring does not reach back
 * that far -- which is the honest answer, not the oldest sample.
 *
 * `cpuHistory` carries no timestamps (see `WallHostVitals`): its samples are
 * positions and the only thing that turns a position back into a time is the
 * cadence the producer sends at. So the caller passes that cadence, and this
 * refuses to guess anything past the end of the array.
 *
 * The ring's LAST element is the newest and sits at offset 0.
 */
export function ringValueAtCursor(
  history: readonly number[],
  offsetMs: number,
  intervalMs: number,
): number | undefined {
  if (offsetMs <= 0) return history[history.length - 1]
  const back = Math.round(offsetMs / Math.max(1, intervalMs))
  const index = history.length - 1 - back
  return index < 0 ? undefined : history[index]
}

// THERE IS NO `sampleAtCursor` HERE, and S2 is why. A TIMESTAMPED series is
// rewound by cutting the samples at the cursor and rebuilding the line from what
// is left (`s2-plan-usage.tsx`), which gets the broken segments, the "latest"
// row and the worst-first ordering right for free. A helper that returned just
// the one sample at the offset would have had the pane re-derive all three from
// it, and the second derivation is where they drift apart.

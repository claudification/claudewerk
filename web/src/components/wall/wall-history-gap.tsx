/**
 * "History before HH:MM was lost" -- the one line the two ACCUMULATED series on
 * THE WALL owe the room after a disconnect.
 *
 * S1's sparklines and S2's 5h graph are not snapshots, they are built up frame by
 * frame. A dropped socket discards the client's copy and a restarted broker
 * empties its own in-memory rings, so both come back short and refill in real
 * time -- which looks EXACTLY like a fleet that went quiet. Same picture, opposite
 * meaning, and the wall's whole premise is being believed from across a room.
 *
 * So the gap gets said out loud. Not drawn through, not smoothed, not back-filled
 * with a straight line between the last sample before the drop and the first one
 * after it: that line would be a measurement nobody took.
 *
 * The durable fix for the broker's half -- flushing the rings to a database -- is
 * `wall-vitals-history-store`, a different card and a different subsystem. It
 * makes the gap SMALLER. It cannot make it zero, because whatever accumulated
 * since the last flush is genuinely gone, so this line is needed either way.
 */

/** Local wall clock, to the minute. Seconds on a surface read from three metres
 *  away are noise. */
function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function WallHistoryGap({ at }: { at: number | null }) {
  if (at == null) return null
  return (
    <p className="wall-history-gap" data-history-gap={String(at)}>
      history before {hhmm(at)} lost to a reconnect -- rebuilding
    </p>
  )
}

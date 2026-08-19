/**
 * The two header mechanics, shipped INERT in their final positions.
 *
 * Same reason as the pane stubs: `wall-filter-bus` (W2) and `wall-time-cursor`
 * (W1) land in parallel worktrees, and if either had to carve out its own space
 * in the header they would both be editing the same rows of the same file. They
 * each rewrite ONE component below instead.
 *
 * INERT means it renders and it takes input, and nothing downstream listens yet.
 * `disabled` would have been the other option and it is worse: it would tell the
 * user the wall cannot be filtered, when the truth is that it cannot be filtered
 * YET.
 */

import { Search } from 'lucide-react'

/** W2 -- one query, every pane. Card `wall-filter-bus` rewrites this. */
export function WallFilterSlot() {
  return (
    <div className="wall-filter" title="W2 -- one query, every pane (not wired yet)">
      <Search className="size-3 opacity-50" />
      <input
        type="text"
        placeholder="filter every pane"
        autoComplete="off"
        spellCheck={false}
        aria-label="Filter every pane"
      />
    </div>
  )
}

/** W1 -- one scrubber rewinds every pane. Card `wall-time-cursor` rewrites this. */
export function WallScrubSlot() {
  return (
    <div className="wall-scrub wall-hide-ambient" title="W1 -- scrub the whole wall (not wired yet)">
      <span className="wall-scrub-label">T</span>
      <input type="range" min={0} max={180} defaultValue={180} aria-label="Time cursor" />
      <span className="wall-scrub-value">LIVE</span>
    </div>
  )
}

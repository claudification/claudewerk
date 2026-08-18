import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { isMobileViewport } from '@/lib/utils'
import { PulseBandsView } from './pulse-bands-view'
import { PulseStripBar } from './pulse-strip-bar'
import { isPeekChordHeld, isPeekChordReleased } from './strip-peek-chord'
import { type PulseRow, usePulseFleet } from './use-pulse-fleet'

/**
 * THE STRIP — Pulse with no summoning at all.
 *
 * It is NOT a modal and it must NEVER take focus. That is the entire reason it
 * exists alongside the palette: you can be mid-sentence in the input editor,
 * glance at it, even open it, and your caret does not move. The bloom's own
 * filter box is the one focusable thing in here, and only if you click it.
 *
 * TWO WAYS IN, BOTH DELIBERATE:
 *   click        pins it open until you click again or press Escape
 *   mod+alt held peeks while held, collapses on release
 *
 * There is NO hover trigger. It used to peek on hover after a 200ms dwell,
 * which meant a bar pinned across the bottom of the window opened itself every
 * time the pointer travelled past it on the way somewhere else. An always-on
 * surface must not react to the pointer merely passing through.
 *
 * Ticks at 5s rather than 1s: this thing is mounted all day, so it trades age
 * precision for not re-rendering the app shell every second.
 */
export function PulseStrip({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const enabled = useConversationsStore(s => s.controlPanelPrefs.pulseStrip)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [filter, setFilter] = useState('')

  const fleet = usePulseFleet(filter, 5_000)

  // mod+alt held = peek; releasing either modifier collapses it, unless a click
  // pinned it open.
  useEffect(() => {
    if (!enabled) return
    function down(e: KeyboardEvent) {
      if (isPeekChordHeld(e)) setOpen(true)
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    function up(e: KeyboardEvent) {
      if (isPeekChordReleased(e)) setOpen(o => (pinned ? o : false))
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [enabled, pinned])

  if (!enabled) return null

  // The lead is the fleet's single most urgent row — NEEDS YOU sorts oldest
  // first, so this is whatever has been waiting longest.
  const lead: PulseRow | null = fleet.flat[0] ?? null

  /** Picking a row is a SELECTION: jump there and get out of the way. Leaving
   *  the bloom open behind the conversation you just opened is the bug this
   *  fixes -- the surface is a selector, not a panel you dismiss by hand. */
  function select(row: PulseRow) {
    onOpen(row.conversation.id)
    setOpen(false)
    setPinned(false)
  }

  /**
   * On a phone the inline bloom is the wrong shape: a 30px bar is barely
   * tappable and a 52vh drawer hanging off it is worse. Tapping the strip
   * instead opens the Pulse palette, which is ALREADY a full-height sheet with
   * search at the thumb and select-then-dismiss behaviour. One selector, three
   * ways in (right-edge swipe, this tap, `mod+k a`) -- rather than a second
   * full-screen surface that would drift out of sync with the first.
   */
  function onBarToggle() {
    if (isMobileViewport()) {
      useConversationsStore.getState().setShowPulse(true)
      return
    }
    // Clicking mid-PEEK pins, it does not close. Toggling on `open` alone would
    // read the chord-held bloom as "already open" and collapse the thing you
    // were reaching for -- the exact opposite of the intent. Only a click on an
    // already-PINNED bloom closes it.
    if (open && !pinned) {
      setPinned(true)
      return
    }
    const next = !open
    setOpen(next)
    setPinned(next)
  }

  return (
    // No pointer handlers here on purpose -- see the header. The bar is a real
    // <button>, so this wrapper carries layout only.
    <div className="shrink-0 border-t border-border bg-surface-inset flex flex-col-reverse">
      <PulseStripBar totals={fleet.totals} lead={lead} open={open} onToggle={onBarToggle} />

      {open && (
        <div className="max-h-[52vh] overflow-y-auto border-b border-primary/10">
          <div className="sticky top-0 z-[3] flex items-center gap-2 px-3 py-2 bg-surface-inset border-b border-primary/10">
            <span className="text-comment text-xs shrink-0">⌕</span>
            <input
              aria-label="Pulse strip filter"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="filter…  !  @project  #tag  ~30m"
              className="w-full bg-transparent text-sm text-foreground placeholder:text-comment outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-[10px] font-mono text-comment shrink-0 tabular-nums">{fleet.flat.length} live</span>
          </div>
          <PulseBandsView fleet={fleet} activeId={null} onSelect={select} />
        </div>
      )}
    </div>
  )
}

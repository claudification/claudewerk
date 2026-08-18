import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { PulseBandsView } from './pulse-bands-view'
import { PulseStripBar } from './pulse-strip-bar'
import { type PulseRow, usePulseFleet } from './use-pulse-fleet'

/** Hover dwell before the strip peeks open, so brushing past it does nothing. */
const PEEK_DELAY_MS = 200

/**
 * THE STRIP — Pulse with no summoning at all.
 *
 * It is NOT a modal and it must NEVER take focus. That is the entire reason it
 * exists alongside the palette: you can be mid-sentence in the input editor,
 * glance at it, even open it, and your caret does not move. The bloom's own
 * filter box is the one focusable thing in here, and only if you click it.
 *
 * Ticks at 5s rather than 1s: this thing is mounted all day, so it trades age
 * precision for not re-rendering the app shell every second.
 */
export function PulseStrip({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const enabled = useConversationsStore(s => s.controlPanelPrefs.pulseStrip)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [filter, setFilter] = useState('')
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fleet = usePulseFleet(filter, 5_000)

  // Alt held = bloom; release collapses unless it was pinned by a click.
  useEffect(() => {
    if (!enabled) return
    function down(e: KeyboardEvent) {
      if (e.key === 'Alt') setOpen(true)
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    function up(e: KeyboardEvent) {
      if (e.key === 'Alt') setOpen(o => (pinned ? o : false))
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [enabled, pinned])

  useEffect(() => {
    return () => {
      if (peekTimer.current) clearTimeout(peekTimer.current)
    }
  }, [])

  if (!enabled) return null

  // The lead is the fleet's single most urgent row — NEEDS YOU sorts oldest
  // first, so this is whatever has been waiting longest.
  const lead: PulseRow | null = fleet.flat[0] ?? null

  function select(row: PulseRow) {
    onOpen(row.conversation.id)
  }

  return (
    /* Hover-peek is a pointer-only enhancement: the bar is a real <button> and Alt/Escape
       drive it from the keyboard, so nothing is reachable ONLY via these handlers. */
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only enhancement, keyboard path exists
    <div
      className="shrink-0 border-t border-border bg-surface-inset flex flex-col-reverse"
      onMouseEnter={() => {
        peekTimer.current = setTimeout(() => setOpen(true), PEEK_DELAY_MS)
      }}
      onMouseLeave={() => {
        if (peekTimer.current) clearTimeout(peekTimer.current)
        if (!pinned) setOpen(false)
      }}
    >
      <PulseStripBar
        totals={fleet.totals}
        lead={lead}
        open={open}
        onToggle={() => {
          const next = !open
          setOpen(next)
          setPinned(next)
        }}
      />

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
          <PulseBandsView fleet={fleet} activeId={null} onSelect={select} cards />
        </div>
      )}
    </div>
  )
}

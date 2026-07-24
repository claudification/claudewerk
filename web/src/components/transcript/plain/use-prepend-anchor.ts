/**
 * Prepend-without-jump for the plain renderer: the classic, Safari-safe
 * scrollHeight-delta anchor. `overflow-anchor` cannot do this job (no Safari
 * support, July 2026), and item/node-granular anchoring is structurally blind
 * to prepends that MERGE into the head of the boundary group (the TanStack
 * breakSeqs saga) -- measuring the whole container catches every inserted
 * pixel regardless of grouping.
 *
 * arm() is called synchronously RIGHT BEFORE the state/store mutation that
 * inserts content above the viewport (useTranscriptWindow's onBeforePrepend);
 * the no-deps layout effect then applies `scrollTop += scrollHeight delta`
 * before paint on the commit where the content lands. The write goes through
 * the engine's tagged scrollTop setter so it can never read as user intent.
 *
 * Known (accepted) race: if a streaming append batches into the SAME commit as
 * the prepend, the delta overcounts by the appended height and the reader is
 * shifted down by that much. Rare, self-correcting, and logged -- watch the
 * `[window] prepend-anchor` lines if a scrollback jump is ever reported.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'
import type { useStickToBottom } from 'use-stick-to-bottom'

type Engine = ReturnType<typeof useStickToBottom>

export function usePrependAnchor(engine: Engine, enabled = true): () => void {
  const { scrollRef, state } = engine
  const pendingRef = useRef<{ scrollHeight: number; scrollTop: number; armedAt: number } | null>(null)

  const arm = useCallback(() => {
    if (!enabled) return // Plain Renderer Lab: anchor disabled -- record nothing.
    const el = scrollRef.current
    if (!el) return
    pendingRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, armedAt: performance.now() }
  }, [scrollRef, enabled])

  // Runs on EVERY commit (no dep array): the prepend may land one or two
  // commits after arm(). Fires before paint, so the reader never sees the
  // uncompensated frame. Disarms on first height change or after 2s (a fetch
  // that returned nothing).
  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    const el = scrollRef.current
    if (!el) return
    if (performance.now() - pending.armedAt > 2000) {
      pendingRef.current = null
      return
    }
    const delta = el.scrollHeight - pending.scrollHeight
    if (delta === 0) return // content not committed yet -- stay armed
    pendingRef.current = null
    // At the RAW bottom the engine's resize pin is the correct anchor --
    // adding a delta would shove the viewport off the bottom. Everyone else
    // (including a near-bottom reader whose lock silently escaped on a
    // sub-threshold nudge -- raw isAtBottom false) keeps their position; when
    // `follow` is still on, the tail-append re-pin re-asserts the bottom
    // anyway. Gating on isNearBottom here skipped compensation for exactly
    // that escaped reader and let a prepend shift them.
    if (delta > 0 && !state.isAtBottom) {
      // Tagged write via the engine's scrollTop setter -- never reads as user
      // scroll intent (the ONE-WRITER invariant).
      state.scrollTop = pending.scrollTop + delta
      console.debug(`[window] prepend-anchor (plain) +${delta}px scrollTop ${pending.scrollTop} -> ${state.scrollTop}`)
    }
  })

  return arm
}

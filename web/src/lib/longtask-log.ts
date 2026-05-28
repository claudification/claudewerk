// Captures main-thread LONG TASKS into console.debug, where debug-log picks
// them up -- so they land in the unified perf report right next to the
// commit->paint spikes they cause.
//
// This is the signal nothing else logged: a slow `commit->paint` only tells you
// paint was late, not WHY. A long task tells you the main thread was blocked
// (chunk script eval, cold-transcript layout, GC, a fat synchronous handler) and
// for how long. Without it, a 1.5s gap is unattributable and easy to misread as
// a "tab was backgrounded" artifact -- which is exactly the trap we hit.
//
// Prefers the Long Animation Frames API (richer: blocking time + script
// attribution); falls back to the older `longtask` type.

let installed = false

export function installLongTaskLog() {
  if (installed || typeof PerformanceObserver === 'undefined') return
  installed = true
  const supported: readonly string[] = PerformanceObserver.supportedEntryTypes ?? []
  try {
    if (supported.includes('long-animation-frame')) {
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const loaf = e as PerformanceEntry & {
            blockingDuration?: number
            scripts?: Array<{ name?: string; sourceURL?: string; duration?: number }>
          }
          const blocking = Math.round(loaf.blockingDuration ?? 0)
          // Name the heaviest script in the frame, if the browser attributed one.
          let top: { name?: string; sourceURL?: string; duration?: number } | undefined
          let topDur = -Infinity
          for (const s of loaf.scripts ?? []) {
            const d = s.duration ?? 0
            if (d > topDur) {
              topDur = d
              top = s
            }
          }
          const src = top?.sourceURL?.split('/').pop()?.split('?')[0] || top?.name || ''
          const attr = src ? ` ${src} ${Math.round(top?.duration ?? 0)}ms` : ''
          console.debug(`[longtask] LoAF ${Math.round(e.duration)}ms (blocking ${blocking}ms)${attr}`)
        }
      })
      obs.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
    } else if (supported.includes('longtask')) {
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          console.debug(`[longtask] ${Math.round(e.duration)}ms`)
        }
      })
      obs.observe({ type: 'longtask', buffered: true })
    }
  } catch {
    // PerformanceObserver missing options/type support -- non-fatal, just skip.
  }
}

import { useEffect } from 'react'
import { useConversationsStore } from './use-conversations'

/**
 * SWITCH-COST ATTRIBUTION (perf-monitor only).
 *
 * The per-component `commit->paint` metric is ambiguous: it measures each
 * profiled subtree's commit -> the NEXT browser paint, so the first component to
 * commit in a frame (ProjectList) reports a number that spans the entire rest of
 * the frame (every later render + the paint), while the last (TranscriptGroups)
 * reports ~just the paint. That conflation makes it impossible to tell from the
 * report alone WHERE a slow switch's cost lives.
 *
 * This hook fixes that: on each conversation switch it measures time-to-paint and
 * the DOM node count of each region (transcript / sidebar / header), plus the
 * CodeMirror-instance count and the virtualizer row count. One `[switch-diag]`
 * line per switch, emitted via console.debug so it lands in the unified perf
 * report (nerd-modal Copy) right next to the `[longtask]` and `commit->paint`
 * entries. Pair msToPaint with the `[longtask]` LoAF blocking time to split
 * JS-cascade cost from actual paint cost.
 */
export function useSwitchDiagnostics(selectedConversationId: string | null) {
  const perfEnabled = useConversationsStore(s => s.controlPanelPrefs.showPerfMonitor)
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure once per switch; perfEnabled is read at switch time, not a re-trigger
  useEffect(() => {
    if (!perfEnabled || !selectedConversationId) return
    const t0 = performance.now()
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      // Two frames: the first lets the switch commit + its follow-up renders
      // (windowing reset, scroll snap) settle; the second fires after paint.
      raf2 = requestAnimationFrame(() => {
        const ms = Math.round(performance.now() - t0)
        const count = (sel: string) => document.querySelectorAll(sel).length
        const region = (name: string) => {
          const el = document.querySelector(`[data-perf-region="${name}"]`)
          return el ? el.querySelectorAll('*').length : -1
        }
        const st = useConversationsStore.getState()
        const entries = st.transcripts[selectedConversationId]?.length ?? 0
        const events = st.events[selectedConversationId]?.length ?? 0
        console.debug(
          `[switch-diag] conv=${selectedConversationId.slice(0, 8)} entries=${entries} events=${events} ` +
            `msToPaint=${ms} domTotal=${count('*')} transcript=${region('transcript')} ` +
            `sidebar=${region('sidebar')} header=${region('header')} cmEditors=${count('.cm-editor')} ` +
            `vrows=${count('[data-index]')}`,
        )
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [selectedConversationId])
}

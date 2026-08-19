/**
 * What the last few dictations actually cost, measured at the seams.
 *
 * BLOCKING by the frozen modal taxonomy: a read-only viewer, not a parkable
 * surface. Lazy-loaded so none of it rides in the index bundle.
 *
 * The tree IS the product here. A screenshot of a timing panel cannot be
 * grepped, diffed, or pasted into an issue, so this renders exactly the text the
 * Copy button puts on the clipboard -- what you see is what you paste.
 */

import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { clearDictationHistory, dictationHistory, lostMs, subscribeDictations } from '@/hooks/voice-timeline'
import { formatDictations } from '@/lib/voice-timeline-format'
import { CopyButton } from './voice-timings-copy'

function useDictations() {
  return useSyncExternalStore(subscribeDictations, dictationHistory)
}

/** Green when nothing was lost, amber for a word's worth, red past that. */
function Verdict({ ms }: { ms: number }) {
  const tone = ms === 0 ? 'text-green-400' : ms < 300 ? 'text-amber-400' : 'text-red-400'
  return <span className={`font-mono text-xs ${tone}`}>{ms === 0 ? 'nothing lost' : `-${ms}ms`}</span>
}

export function VoiceTimingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const records = useDictations()
  const report = formatDictations(records)

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl p-5 gap-2 overflow-y-auto">
        <DialogTitle className="pr-8">Dictation timings</DialogTitle>
        <p className="text-[10px] text-fg-muted pr-8">
          Every number is a mark taken at the seam it describes, on this device. NET LOST is the gap from the key going
          down to the first sample actually captured, minus what the pre-roll ring handed back.
        </p>

        {records.length === 0 ? (
          <p className="mt-2 text-xs font-mono text-muted-foreground">
            No dictations measured yet. Hold the push-to-talk key and say something.
          </p>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {records.map(r => (
                <span key={r.id} className="text-[10px] font-mono text-fg-muted">
                  #{r.id} <Verdict ms={lostMs(r)} />
                </span>
              ))}
            </div>
            <pre className="mt-2 max-h-[50vh] overflow-auto bg-muted/40 p-3 text-[10px] leading-relaxed font-mono whitespace-pre">
              {report}
            </pre>
            <div className="flex gap-2">
              <CopyButton text={report} />
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => clearDictationHistory()}>
                Clear
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

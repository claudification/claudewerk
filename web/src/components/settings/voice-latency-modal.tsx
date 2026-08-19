/**
 * Voice latency probe results.
 *
 * BLOCKING by the frozen modal taxonomy: a read-only viewer, not a parkable
 * surface. Lazy-loaded so the probe never rides in the index bundle.
 *
 * It exists because the entire voice saga was a geography problem nobody
 * measured. Which transport is fastest genuinely depends on where the person
 * holding the microphone is standing, so this puts the numbers in front of them
 * instead of asking them to trust a default.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import { formatLatencyReport, type LatencySample, probeVoiceLatency } from '@/lib/voice-latency-probe'

const ROUNDS = 10

function Bar({ value, worst }: { value: number; worst: number }) {
  const pct = worst > 0 ? Math.max(2, Math.round((value / worst) * 100)) : 0
  // Green under 100ms, amber to 250ms, red past it -- the thresholds that
  // separate "feels instant" from "feels laggy" for dictation.
  const tone = value < 100 ? 'bg-green-500/70' : value < 250 ? 'bg-amber-500/70' : 'bg-red-500/70'
  return (
    <div className="h-1.5 w-full bg-muted overflow-hidden">
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** What a dictation actually pays: this hop, plus any onward hop the target
 *  makes on our behalf. The relay does not end at the broker. */
function total(sample: LatencySample): number {
  return sample.median + (sample.upstreamMs ?? 0)
}

function Row({ sample, worst }: { sample: LatencySample; worst: number }) {
  return (
    <div className={`py-2 border-b border-border-subtle last:border-0 ${sample.available ? '' : 'opacity-60'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium">
          {sample.label}
          {/* A number for a path that does not exist is useful -- measure before
              you build -- but it must never look selectable. */}
          {!sample.available && (
            <span className="ml-1.5 text-[9px] font-normal uppercase tracking-wide text-fg-dim">not built</span>
          )}
        </span>
        {sample.samples.length > 0 ? (
          <span className="text-xs font-mono tabular-nums">
            <span className="text-foreground">{total(sample)}ms</span>
            <span className="text-fg-dim">
              {' '}
              {sample.upstreamMs === undefined
                ? `(${sample.min}-${sample.max})`
                : `(${sample.median}+${sample.upstreamMs})`}
            </span>
          </span>
        ) : (
          <span className="text-xs font-mono text-red-400">unreachable</span>
        )}
      </div>
      {sample.samples.length > 0 && (
        <div className="mt-1">
          <Bar value={total(sample)} worst={worst} />
        </div>
      )}
      <p className="mt-1 text-[10px] leading-snug text-fg-muted">{sample.note}</p>
      {sample.error && sample.samples.length > 0 && (
        <p className="mt-0.5 text-[10px] text-amber-400/80">some pings failed: {sample.error}</p>
      )}
    </div>
  )
}

/** A screenshot cannot be grepped, diffed, or pasted into an issue. A fenced
 *  table can, so the numbers leave this modal in a form that survives. */
function CopyStats({ results }: { results: LatencySample[] }) {
  const [copied, setCopied] = useState(false)
  const prefs = useConversationsStore(s => s.controlPanelPrefs)
  return (
    <Button
      variant="outline"
      size="sm"
      className="text-xs self-start"
      onClick={() => {
        const report = formatLatencyReport(results, {
          transport: prefs?.voiceDirectToDeepgram === false ? 'broker relay' : 'direct',
          model: prefs?.voiceSttModel || 'default',
          takenAt: new Date().toISOString(),
        })
        void navigator.clipboard.writeText(report).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy stats'}
    </Button>
  )
}

export function VoiceLatencyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [results, setResults] = useState<LatencySample[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setRunning(true)
    setResults([])
    probeVoiceLatency(undefined, {
      rounds: ROUNDS,
      signal: controller.signal,
      onProgress: (done, total) => setProgress({ done, total }),
    })
      .then(setResults)
      .finally(() => setRunning(false))
    // Abort in flight when the dialog closes -- a probe outliving its own
    // window would keep hammering the network for no one.
    return () => controller.abort()
  }, [open])

  const worst = results.reduce((max, r) => Math.max(max, total(r)), 0)

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-md p-5 gap-2 overflow-y-auto">
        <DialogTitle className="pr-8">Speech transport latency</DialogTitle>
        <p className="text-[10px] text-fg-muted pr-8">
          {ROUNDS} round trips each, measured from THIS browser, sequentially. This is how far away each option is, not
          how fast it transcribes.
        </p>
        {running && (
          <p className="text-xs font-mono text-muted-foreground">
            measuring… {progress.done}/{progress.total}
          </p>
        )}
        <div className="mt-1">
          {results.map(r => (
            <Row key={r.label} sample={r} worst={worst} />
          ))}
        </div>
        {!running && results.length > 0 && <CopyStats results={results} />}
        {!running && results.length > 0 && (
          <p className="text-[10px] leading-snug text-fg-muted">
            Lower is better. The Cloudflare edge stays ~45ms from anywhere in the world; the broker is close on the home
            LAN and a round trip to the house from anywhere else.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The small pieces an unattended-run row is made of: the armed tag, the beat
 * pulse, the bucket strip and the baton tail.
 *
 * Their own file because four components used once each is still the shape that
 * otherwise grows a 300-line row nobody can find anything in -- and because the
 * bucket strip is the thing a reader will want to check against
 * `action=inspect`, which is easier when it is eight lines long.
 *
 * COLOUR IS A CONTRACT, not decoration: the mockup assigns a hue per baton kind
 * and per bucket, and those hues are how you read the pane at four feet without
 * reading the words. Each maps onto an existing theme token -- the wall invents
 * no colours of its own.
 */

import type { EpicCapReading } from '@shared/epic-run-caps'
import type { EpicLogEntry, EpicLogKind } from '@shared/epic-run-types'
import type { RunVitalityView } from '@shared/epic-vitality'
import { formatDurationShort } from '@/lib/status-style'
import type { RunBuckets } from './run-model'
import { type BeatTick, batonHeadline } from './run-tails'

const BATON_TONE: Record<EpicLogKind, string> = {
  intent: 'var(--comment)',
  dispatch: 'var(--info)',
  // A seat that never started. Red rather than the dispatch blue, because at
  // four feet this must not read as work going out.
  'dispatch-failed': 'var(--destructive)',
  completion: 'var(--success)',
  verdict: 'var(--success)',
  blocked: 'var(--destructive)',
  merge: 'var(--event-prompt)',
  steering: 'var(--warning)',
  checkpoint: 'var(--comment)',
  // AMBER, not red. Red on this pane means work that never went out
  // (`dispatch-failed`); this is the engine noticing a dead supervisor and
  // replacing it, so the run is moving again -- but a host died with nobody
  // watching and somebody should look at what it left in its worktree.
  'overseer-lost': 'var(--warning)',
  // Bookkeeping, not an event: the engine writing a sha into a card's `closes:`
  // must never out-shout a dispatch or a bounce at four feet.
  record: 'var(--comment)',
}

/** Bucket -> label + tone. A list rather than six ternaries in JSX, and in the
 *  order the card names them. A zero bucket still renders: "0 in flight" on an
 *  armed run is the single most informative number on this pane. */
const BUCKETS: { key: keyof RunBuckets; label: string; tone?: string }[] = [
  { key: 'ready', label: 'ready', tone: 'var(--active)' },
  { key: 'inFlight', label: 'in flight', tone: 'var(--info)' },
  { key: 'verify', label: 'awaiting verdict', tone: 'var(--event-prompt)' },
  { key: 'held', label: 'held' },
  { key: 'deps', label: 'waiting on deps' },
  { key: 'parked', label: 'parked', tone: 'var(--warning)' },
]

/**
 * The run's state, in one word, from the SHARED derivation.
 *
 * It used to be a boolean -- ARMED or PAUSED -- fed from `status`, which meant a
 * deadlocked run wearing `status: running` rendered ARMED, a finished run
 * rendered PAUSED, and neither was true. Six words now, and DONE is one of them:
 * a completed run stays on this pane and says so.
 */
export function RunTag({ view }: { view: RunVitalityView }) {
  return (
    <span className="wall-run-tag" data-vitality={view.vitality} title={view.why}>
      {view.label}
    </span>
  )
}

export function NightTag() {
  return <span className="wall-run-tag wall-run-tag-night">NIGHT</span>
}

/**
 * A tick per performed beat, so a live run visibly beats. A beat that DID
 * something is full; one that found nothing to do is dim -- a wall of dim ticks
 * is a run that is beating and going nowhere, which reads as different from a
 * run that is not beating at all.
 */
export function BeatPulse({ ticks }: { ticks: readonly BeatTick[] }) {
  if (ticks.length === 0) return null
  return (
    <span className="wall-run-beats" role="img" aria-label={`${ticks.length} recent beats`}>
      {ticks.map(tick => (
        <i key={tick.at} data-did={tick.did || undefined} />
      ))}
    </span>
  )
}

export function BucketStrip({ buckets }: { buckets: RunBuckets }) {
  return (
    <div className="wall-run-buckets">
      {BUCKETS.map(bucket => {
        const n = buckets[bucket.key]
        return (
          <span key={bucket.key} style={n > 0 && bucket.tone ? { color: bucket.tone } : undefined}>
            {n} {bucket.label}
          </span>
        )
      })}
    </div>
  )
}

/**
 * HOW MUCH BUDGET IS LEFT -- spend, wall clock, generations.
 *
 * `maxGens` used to be the only ceiling and the only one on screen, which made
 * an expensive run and a cheap one look identical right up to the invoice. A
 * tripped ceiling wears the alarm tone, so "this run stopped because it ran out
 * of money" is legible from four feet without opening a tool.
 *
 * Renders nothing without a run artifact rather than printing zeroes: an unread
 * run has no budget to report, and `$0.00/$0.00` would read as a broke run.
 */
export function CapStrip({ caps }: { caps: readonly EpicCapReading[] }) {
  if (caps.length === 0) return null
  return (
    <div className="wall-run-caps">
      {caps.map(cap => (
        <span key={cap.label} data-over={cap.over || undefined} title={cap.remaining ? `${cap.remaining} left` : ''}>
          {`${cap.label} ${cap.used}/${cap.limit}`}
        </span>
      ))}
    </div>
  )
}

/**
 * WHAT IT LAST DID -- one line, and only ever one line.
 *
 * The body is prose one agent wrote for another and runs to thousands of
 * characters, so it is CLAMPED IN THE MARKUP as well as the CSS: the first line
 * of the body only, ellipsised, full text on hover. Relying on the stylesheet
 * alone left the whole essay in the DOM, which is how a 38%-tall pane rendered a
 * single run as a wall of text with the numbers scrolled off the top.
 */
export function BatonTail({ entries, nowMs }: { entries: readonly EpicLogEntry[]; nowMs: number }) {
  if (entries.length === 0) return null
  return (
    <div className="wall-run-baton">
      {entries.map(entry => (
        <div key={`${entry.ts} ${entry.kind}`} title={entry.body}>
          <span className="wall-run-baton-kind" style={{ color: BATON_TONE[entry.kind] }}>
            {entry.kind}
          </span>
          <span className="wall-run-baton-age">{formatDurationShort(Math.max(0, nowMs - Date.parse(entry.ts)))}</span>
          <span className="wall-run-baton-body">{batonHeadline(entry.body)}</span>
        </div>
      ))}
    </div>
  )
}

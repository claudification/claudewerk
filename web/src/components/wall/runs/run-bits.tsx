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

import type { EpicLogEntry, EpicLogKind } from '@shared/epic-run-types'
import { formatDurationShort } from '@/lib/status-style'
import type { BeatTick, RunBuckets } from './run-model'

const BATON_TONE: Record<EpicLogKind, string> = {
  intent: 'var(--comment)',
  dispatch: 'var(--info)',
  completion: 'var(--success)',
  verdict: 'var(--success)',
  blocked: 'var(--destructive)',
  merge: 'var(--event-prompt)',
  steering: 'var(--warning)',
  checkpoint: 'var(--comment)',
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

export function RunTag({ armed }: { armed: boolean }) {
  return <span className={armed ? 'wall-run-tag wall-run-tag-on' : 'wall-run-tag'}>{armed ? 'ARMED' : 'PAUSED'}</span>
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

export function BatonTail({ entries, nowMs }: { entries: readonly EpicLogEntry[]; nowMs: number }) {
  if (entries.length === 0) return null
  return (
    <div className="wall-run-baton">
      {entries.map(entry => (
        <div key={`${entry.ts} ${entry.kind}`}>
          <span className="wall-run-baton-kind" style={{ color: BATON_TONE[entry.kind] }}>
            {entry.kind}
          </span>
          <span className="wall-run-baton-age">{formatDurationShort(Math.max(0, nowMs - Date.parse(entry.ts)))}</span>
          <span className="wall-run-baton-body">{entry.body}</span>
        </div>
      ))}
    </div>
  )
}

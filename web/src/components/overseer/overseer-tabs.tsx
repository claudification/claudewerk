/**
 * BATON / BEATS / DIGEST -- three views of "what happened", kept apart on
 * purpose.
 *
 * The BATON is the durable record on disk and the overseer's own memory; it
 * survives a broker restart. The BEATS are the in-memory 160-entry sweep ring,
 * mechanical, lost on restart. Merging them into one stream would be prettier
 * and would quietly lie about which of the two you can still trust tomorrow.
 *
 * The DIGEST is the overseer's markdown. Its empty state names the reason it is
 * empty rather than rendering blank, because "no digest yet" and "the overseer
 * has never woken" look identical otherwise -- and on the first live run of this
 * engine, they were the same thing and nobody noticed for an hour.
 */

import type { EpicLogEntry } from '@shared/epic-run-types'
import type { EpicBeatRecord, EpicRunSnapshot } from '@shared/protocol'
import { Markdown } from '@/components/markdown'
import { cn, haptic } from '@/lib/utils'
import { ago, Empty } from './overseer-bits'

export type OverseerTab = 'baton' | 'beats' | 'digest'

const KIND_TONE: Record<string, string> = {
  dispatch: 'text-primary',
  completion: 'text-active',
  verdict: 'text-active',
  steering: 'text-event-prompt',
  planning: 'text-[color:var(--epic-badge)]',
  error: 'text-destructive',
}

function Entry({
  ts,
  kind,
  body,
  tone,
  nowMs,
}: {
  ts: string
  kind: string
  body: string
  tone: string
  nowMs: number
}) {
  return (
    <div className="flex gap-2.5 py-1.5 border-b border-border/25">
      <span className="text-meta text-muted-foreground/40 shrink-0 w-14" title={ts}>
        {ago(ts, nowMs)}
      </span>
      <span className={cn('text-chrome uppercase shrink-0 w-16', tone)}>{kind}</span>
      <span className="flex-1 min-w-0 text-[11px] text-foreground/88 break-words">{body}</span>
    </div>
  )
}

export function OverseerTabStrip({
  tab,
  onTab,
  batonCount,
  beatCount,
}: {
  tab: OverseerTab
  onTab: (t: OverseerTab) => void
  batonCount: number
  beatCount: number
}) {
  const tabs: { key: OverseerTab; label: string; n?: number }[] = [
    { key: 'baton', label: 'Baton', n: batonCount },
    { key: 'beats', label: 'Beats', n: beatCount },
    { key: 'digest', label: 'Digest' },
  ]

  return (
    <div className="flex border-b border-border/50 shrink-0">
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => {
            haptic('tap')
            onTab(t.key)
          }}
          className={cn(
            'px-3 py-1.5 text-chrome uppercase border-b-2 transition-colors',
            tab === t.key
              ? 'text-[color:var(--epic-badge)] border-[color:var(--epic-badge)]'
              : 'text-muted-foreground/50 border-transparent hover:text-foreground',
          )}
        >
          {t.label}
          {t.n !== undefined && <span className="ml-1.5 text-muted-foreground/40">{t.n}</span>}
        </button>
      ))}
    </div>
  )
}

export function OverseerBaton({ baton, nowMs }: { baton: EpicLogEntry[]; nowMs: number }) {
  if (baton.length === 0) return <Empty>The baton is empty. Nothing has been dispatched or decided yet.</Empty>
  // Newest first: the interesting end of a running log is the recent end, and
  // scrolling to the bottom to find out what just happened is a tax.
  return (
    <div className="px-3 py-2">
      {[...baton].reverse().map((e, i) => (
        <Entry
          key={`${e.ts}-${i}`}
          ts={e.ts}
          kind={e.kind}
          tone={KIND_TONE[e.kind] ?? 'text-muted-foreground/60'}
          body={e.cardId ? `${e.cardId}: ${e.body}` : e.body}
          nowMs={nowMs}
        />
      ))}
    </div>
  )
}

export function OverseerBeats({ beats, nowMs }: { beats: EpicBeatRecord[]; nowMs: number }) {
  if (beats.length === 0) {
    return <Empty>No beat recorded. The ring is in memory, so a broker restart empties it.</Empty>
  }
  return (
    <div className="px-3 py-2">
      {[...beats].reverse().map((b, i) => (
        <Entry
          key={`${b.at}-${i}`}
          ts={b.at}
          kind={`gen ${b.gen}`}
          tone="text-muted-foreground/50"
          body={`${b.note}${b.spawned.length > 0 ? ` (${b.spawned.length} spawned)` : ''}${b.error ? ` -- ${b.error}` : ''}`}
          nowMs={nowMs}
        />
      ))}
    </div>
  )
}

export function OverseerDigest({ run }: { run: EpicRunSnapshot | null }) {
  const digest = run?.digest?.trim()
  // The placeholder the sentinel writes at arm time is not a digest. Treating it
  // as one renders italic underscores and hides the actual state.
  const written = digest && !digest.startsWith('_No digest yet')

  if (!written) {
    return (
      <Empty>
        No digest yet -- the first overseer generation writes it. If the run has been going a while, no overseer has
        woken: check the Overseer block on the left and use BEAT NOW.
      </Empty>
    )
  }
  return (
    <div className="px-3.5 py-3 text-[11.5px] leading-relaxed">
      <Markdown>{digest}</Markdown>
    </div>
  )
}

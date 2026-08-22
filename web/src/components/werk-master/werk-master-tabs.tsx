/**
 * BATON / BEATS / DIGEST -- three views of "what happened", kept apart on
 * purpose.
 *
 * The BATON is the durable record on disk and the werk-master's own memory; it
 * survives a broker restart. The BEATS are the in-memory 160-entry sweep ring,
 * mechanical, lost on restart. Merging them into one stream would be prettier
 * and would quietly lie about which of the two you can still trust tomorrow.
 *
 * The DIGEST is the werk-master's markdown. Its empty state names the reason it is
 * empty rather than rendering blank, because "no digest yet" and "the werk-master
 * has never woken" look identical otherwise -- and on the first live run of this
 * engine, they were the same thing and nobody noticed for an hour.
 */

import type { EpicLogEntry } from '@shared/epic-run-types'
import type { EpicBeatRecord, EpicRunSnapshot } from '@shared/protocol'
import { Markdown } from '@/components/markdown'
import { cn, haptic } from '@/lib/utils'
import { ago, Empty } from './werk-master-bits'

export type WerkMasterTab = 'baton' | 'beats' | 'digest'

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
    <div className="flex gap-2.5 py-1.5 border-b border-border-subtle">
      <span className="text-meta text-fg-faint shrink-0 w-14" title={ts}>
        {ago(ts, nowMs)}
      </span>
      {/* w-20 + truncate, not w-16: `COMPLETION` and `CHECKPOINT` are the two
          longest kinds and at 9px with 0.11em tracking they measured a hair over
          64px, so they overflowed the column and printed INTO the body text --
          `COMPLETIONmain-biome-...`. The truncate is the backstop so a kind added
          later cannot reintroduce it. */}
      <span className={cn('text-chrome uppercase shrink-0 w-20 truncate', tone)} title={kind}>
        {kind}
      </span>
      {/* Baton bodies are MARKDOWN -- the werk-master writes them with bold, lists
          and verification tables. Rendered as a raw string they showed literal
          `**...**` and a table collapsed onto one line as `| check | result |`. */}
      <div className="flex-1 min-w-0 text-[11px] text-foreground/88 [overflow-wrap:break-word]">
        <Markdown>{body}</Markdown>
      </div>
    </div>
  )
}

export function WerkMasterTabStrip({
  tab,
  onTab,
  batonCount,
  beatCount,
}: {
  tab: WerkMasterTab
  onTab: (t: WerkMasterTab) => void
  batonCount: number
  beatCount: number
}) {
  const tabs: { key: WerkMasterTab; label: string; n?: number }[] = [
    { key: 'baton', label: 'Baton', n: batonCount },
    { key: 'beats', label: 'Beats', n: beatCount },
    { key: 'digest', label: 'Digest' },
  ]

  return (
    <div className="flex border-b border-border shrink-0">
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
              : 'text-fg-dim border-transparent hover:text-foreground',
          )}
        >
          {t.label}
          {t.n !== undefined && <span className="ml-1.5 text-fg-faint">{t.n}</span>}
        </button>
      ))}
    </div>
  )
}

export function WerkMasterBaton({ baton, nowMs }: { baton: EpicLogEntry[]; nowMs: number }) {
  if (baton.length === 0) return <Empty>The baton is empty. Nothing has been dispatched or decided yet.</Empty>
  // Newest first: the interesting end of a running log is the recent end, and
  // scrolling to the bottom to find out what just happened is a tax.
  return (
    <div className="px-3 py-2">
      {/* Key on CONTENT, never position. The list is reversed, so a new entry
          arrives at index 0 and shifts every other index -- an index-bearing key
          therefore changes on every row of a live log, remounting the lot (and
          now re-rendering a Markdown body per row) each time the werk-master writes
          one line. */}
      {[...baton].reverse().map(e => (
        <Entry
          key={`${e.ts}-${e.kind}-${e.cardId ?? ''}-${e.body.length}`}
          ts={e.ts}
          kind={e.kind}
          tone={KIND_TONE[e.kind] ?? 'text-fg-dim'}
          body={e.cardId ? `${e.cardId}: ${e.body}` : e.body}
          nowMs={nowMs}
        />
      ))}
    </div>
  )
}

export function WerkMasterBeats({ beats, nowMs }: { beats: EpicBeatRecord[]; nowMs: number }) {
  if (beats.length === 0) {
    return <Empty>No beat recorded. The ring is in memory, so a broker restart empties it.</Empty>
  }
  return (
    <div className="px-3 py-2">
      {[...beats].reverse().map(b => (
        <Entry
          key={`${b.at}-${b.gen}-${b.note.length}`}
          ts={b.at}
          kind={`gen ${b.gen}`}
          tone="text-fg-dim"
          body={`${b.note}${b.spawned.length > 0 ? ` (${b.spawned.length} spawned)` : ''}${b.error ? ` -- ${b.error}` : ''}`}
          nowMs={nowMs}
        />
      ))}
    </div>
  )
}

export function WerkMasterDigest({ run }: { run: EpicRunSnapshot | null }) {
  const digest = run?.digest?.trim()
  // The placeholder the sentinel writes at arm time is not a digest. Treating it
  // as one renders italic underscores and hides the actual state.
  const written = digest && !digest.startsWith('_No digest yet')

  if (!written) {
    return (
      <Empty>
        No digest yet -- the first werk-master generation writes it. If the run has been going a while, no werk-master
        has woken: check the WerkMaster block on the left and use BEAT NOW.
      </Empty>
    )
  }
  return (
    <div className="px-3.5 py-3 text-[11.5px] leading-relaxed">
      <Markdown>{digest}</Markdown>
    </div>
  )
}

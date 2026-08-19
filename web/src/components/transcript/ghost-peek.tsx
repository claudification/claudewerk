/**
 * Ghost peek -- what a selected ghost (unattached daemon worker) shows in place
 * of the transcript. claudewerk is NOT hosting the worker, so there is no
 * transcript stream yet; instead of a dead "NO TRANSCRIPT" box we surface the
 * live roster state (what it's doing, cwd, cli, age) + a prominent Attach that
 * takes it over and starts streaming the real transcript.
 *
 * Rendered by TranscriptView's empty-state branch via TranscriptEmptyState, so
 * the daemonRosters subscription only lives while a transcript is empty -- it
 * never re-renders the heavy virtualized transcript during active streaming.
 */

import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { DaemonRosterEntry } from '@/hooks/use-daemon-roster'
import { attachGhost, useGhostEntry } from '@/hooks/use-ghost-sessions'
import { shortenHomePath as shortPath } from '@/lib/short-path'
import { cn, formatAge, haptic } from '@/lib/utils'

/** Tailwind tint for a daemon job state (mirrors the roster browser). */
function stateClass(state: string): string {
  if (state === 'question' || state === 'blocked' || state === 'idle') return 'text-amber-400'
  if (state === 'starting' || state === 'resuming' || state === 'adopted') return 'text-sky-400'
  return 'text-emerald-400'
}

/** The original empty-transcript box, kept for non-ghost conversations. */
function NoTranscriptBox() {
  return (
    <div className="text-muted-foreground text-center py-10 font-mono">
      <pre className="text-xs">
        {`
┌─────────────────────────┐
│   [ NO TRANSCRIPT ]     │
│   Waiting for data...   │
└─────────────────────────┘
`.trim()}
      </pre>
    </div>
  )
}

function MetaRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-dim text-[10px] uppercase tracking-wider w-16 shrink-0">{label}</span>
      <span className={cn('truncate', valueClass ?? 'text-foreground/80')}>{value}</span>
    </div>
  )
}

/** Prominent attach button for the peek (reuses the shared attachGhost logic). */
function PeekAttachButton({ conversationId }: { conversationId: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function onAttach() {
    if (pending) return
    haptic('tap')
    setPending(true)
    setError(null)
    const result = await attachGhost(conversationId)
    setPending(false)
    if (result.ok) haptic('success')
    else {
      setError(result.error)
      haptic('error')
    }
  }
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onAttach}
        disabled={pending}
        className={cn(
          'w-full px-3 py-2 text-[12px] font-bold uppercase tracking-wider border transition-colors',
          pending
            ? 'text-violet-300/60 border-violet-500/30 cursor-wait'
            : 'text-violet-200 border-violet-500/50 bg-violet-500/10 hover:bg-violet-500/25 cursor-pointer',
        )}
      >
        {pending ? 'attaching...' : 'Attach -- take over & stream transcript'}
      </button>
      {error && <div className="text-[10px] text-red-400/80 text-center">attach failed: {error}</div>}
    </div>
  )
}

/** The peek card itself -- pure render of a roster entry. */
function GhostPeek({ entry, conversationId }: { entry: DaemonRosterEntry; conversationId: string }) {
  return (
    <div className="p-3 sm:p-4 font-mono">
      <div className="max-w-md mx-auto border border-violet-500/40 border-dashed bg-violet-500/[0.04] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-violet-300 text-[13px]">{'◌'}</span>
          <span className="text-violet-300 font-bold uppercase text-[11px] tracking-wider">Ghost</span>
          <span className="text-foreground/80 font-bold truncate flex-1">{entry.name || entry.short}</span>
          <span className={cn('text-[11px] font-bold uppercase shrink-0', stateClass(entry.state))}>{entry.state}</span>
        </div>

        <p className="text-[10px] text-fg-muted leading-snug">
          Discovered daemon worker -- claudewerk is mirroring it read-only. Attach to stream its live transcript and
          drive it interactively.
        </p>

        <div className="space-y-1 text-[11px]">
          {entry.intent && <MetaRow label="goal" value={entry.intent} />}
          {entry.detail && <MetaRow label="now" value={entry.detail} valueClass={stateClass(entry.state)} />}
          {entry.needs && <MetaRow label="needs" value={entry.needs} valueClass="text-amber-400" />}
          <MetaRow label="cwd" value={shortPath(entry.currentPath)} />
          {entry.cliVersion && <MetaRow label="cli" value={entry.cliVersion} />}
          {typeof entry.pid === 'number' && <MetaRow label="pid" value={String(entry.pid)} />}
          {typeof entry.startedAt === 'number' && <MetaRow label="started" value={formatAge(entry.startedAt)} />}
          {entry.sentinelAlias && entry.sentinelAlias !== 'default' && (
            <MetaRow label="via" value={entry.sentinelAlias} />
          )}
          <MetaRow label="worker" value={entry.short} valueClass="text-fg-dim" />
        </div>

        <PeekAttachButton conversationId={conversationId} />
      </div>
    </div>
  )
}

/**
 * Transcript empty state: a ghost peek for unattached daemon workers, the plain
 * NO TRANSCRIPT box otherwise. Owns the daemonRosters subscription so it stays
 * out of the active transcript render path.
 */
export function TranscriptEmptyState({ conversationId }: { conversationId?: string }) {
  const entry = useGhostEntry(conversationId ?? '')
  const hosted = useConversationsStore(s =>
    conversationId ? (s.conversationsById[conversationId]?.connectionIds?.length ?? 0) > 0 : true,
  )
  if (conversationId && entry && !hosted) return <GhostPeek entry={entry} conversationId={conversationId} />
  return <NoTranscriptBox />
}

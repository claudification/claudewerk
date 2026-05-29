/**
 * use-ghost-sessions -- "ghost" daemon workers in the conversation list.
 *
 * A GHOST is a live cc-daemon worker that claudewerk is mirroring read-only but
 * is NOT hosting interactively yet. The sentinel already discovers these (it
 * polls the daemon socket + watches roster.json) and the broker already mirrors
 * each one as a `Conversation` row (`agentHostType: 'daemon'`). The live roster
 * reaches the frontend as `daemon_roster` messages stored in `daemonRosters`.
 *
 * isGhost(conv) = (conv.id is a live daemon worker in the roster)
 *              AND (conv.transport !== 'claude-daemon', i.e. not yet attached).
 *
 * ATTACH reuses the SAME conversationId (the broker's `resolveDaemonReuse`) and
 * flips `transport -> 'claude-daemon'`, so the row stops being a ghost and
 * "solidifies" into a normal interactive conversation -- no new id, no new row.
 */

import { useMemo } from 'react'
import { blankDaemonForm, buildDaemonSpawnFields } from '@/components/spawn-dialog/daemon-launch'
import { useConversationsStore } from './use-conversations'
import type { DaemonRosterEntry } from './use-daemon-roster'
import { sendSpawnRequest } from './use-spawn'

/**
 * The live daemon worker `short` for this conversation, or `null` when the id is
 * not a live daemon worker. Returns a PRIMITIVE so the per-row subscription only
 * re-renders when this conversation's ghost-ness changes -- never return an
 * object literal from a zustand selector (React #185 infinite-render trap).
 */
export function useGhostShort(conversationId: string): string | null {
  return useConversationsStore(s => {
    const rosters = s.daemonRosters
    if (!rosters) return null
    for (const fwd of Object.values(rosters)) {
      for (const job of fwd.jobs) {
        if (job.conversationId === conversationId) return job.short
      }
    }
    return null
  })
}

/**
 * The full live roster entry for a conversation, or null when it is not a live
 * daemon worker. Subscribes to the roster ref so the ghost peek re-renders with
 * fresh state/detail as the sentinel polls. One-instance use (the selected
 * conversation's peek), so the roster-ref subscription is fine -- unlike the
 * per-row useGhostShort which must stay primitive.
 */
export function useGhostEntry(conversationId: string): DaemonRosterEntry | null {
  const rosters = useConversationsStore(s => s.daemonRosters)
  return useMemo(() => {
    if (!rosters) return null
    for (const fwd of Object.values(rosters)) {
      // tree-traversal helper, not a per-render hot path
      // react-doctor-disable-next-line react-doctor/js-index-maps
      const job = fwd.jobs.find(j => j.conversationId === conversationId)
      if (job) return { ...job, sentinelId: fwd.sentinelId, sentinelAlias: fwd.sentinelAlias }
    }
    return null
  }, [rosters, conversationId])
}

/** Find the full roster entry for a conversation, tagged with its owning
 *  sentinel (so the ATTACH spawn routes). Reads the store imperatively -- used
 *  at click time, not as a subscription. */
function findGhostEntry(conversationId: string): DaemonRosterEntry | null {
  const rosters = useConversationsStore.getState().daemonRosters
  if (!rosters) return null
  for (const fwd of Object.values(rosters)) {
    // tree-traversal helper, not a per-render hot path
    // react-doctor-disable-next-line react-doctor/js-index-maps
    const job = fwd.jobs.find(j => j.conversationId === conversationId)
    if (job) return { ...job, sentinelId: fwd.sentinelId, sentinelAlias: fwd.sentinelAlias }
  }
  return null
}

type GhostAttachResult = { ok: true; conversationId: string } | { ok: false; error: string }

/**
 * Take over a ghost daemon worker interactively. Replicates the spawn dialog's
 * ATTACH path (spawn-dialog.tsx): cwd + sentinel come from the roster job, the
 * worker `short` is the attach target, and NO config is injected (the worker was
 * already configured by whoever dispatched it). On success the broker reuses the
 * existing conversationId; we select it.
 */
export async function attachGhost(conversationId: string): Promise<GhostAttachResult> {
  const entry = findGhostEntry(conversationId)
  if (!entry) return { ok: false, error: 'Daemon worker is no longer in the roster' }
  const result = await sendSpawnRequest({
    cwd: entry.cwd,
    mkdir: false,
    sentinel: entry.sentinelAlias || undefined,
    jobId: crypto.randomUUID(),
    ...buildDaemonSpawnFields({ mode: 'attach', form: blankDaemonForm(), attachShort: entry.short }),
  })
  if (result.ok) {
    useConversationsStore.getState().selectConversation(result.conversationId, 'click')
    return { ok: true, conversationId: result.conversationId }
  }
  return { ok: false, error: result.error }
}

import { projectIdentityKey } from '@shared/project-uri'
import { useEffect, useMemo, useState } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { pulseActionText, pulseTag } from '@/lib/pulse/action-text'
import {
  bandOf,
  compareInBand,
  hardBlockOf,
  PULSE_BANDS,
  type PulseAttentionFlags,
  type PulseBand,
} from '@/lib/pulse/bands'
import { isEmptyQuery, matchesPulseQuery, type PulseQuery, parsePulseQuery } from '@/lib/pulse/filter'
import { isManaged, type ManagedInfo, managedInfo } from '@/lib/pulse/managed'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { projectDisplayName } from '@/lib/utils'
import { useWorkspaceIndex, type WorkspaceIndex } from '@/lib/workspace-index'
import { useAttentionFlags } from './use-attention-flags'

/** Bands that render as rows. `expired` is a collapsed count, never a band. */
export const VISIBLE_BANDS = PULSE_BANDS.filter(b => b !== 'expired')

export interface PulseRow {
  id: string
  conversation: Conversation
  band: PulseBand
  title: string
  project: string
  /** Project icon + colour, resolved ONCE here rather than per row at render:
   *  the palette lists ~100 rows and each would otherwise re-read the settings
   *  map. Absent when the project has no settings entry. */
  projectIcon?: string
  projectColor?: string
  action: string
  /** Which un-fakeable interaction is holding this conversation, when one is.
   *  Present exactly on `blocked` rows — drives the row marker. */
  blockedBy?: string
  tag?: string
  ageMs: number
  /** `$` axis — total spend so far. */
  costUsd?: number
  /** `%` axis — context-window pressure, 0-100. */
  contextPct?: number
  /** `&` axis — which sentinel is hosting it. */
  host?: string
  /** `:` axis — the model. */
  model?: string
  /** `^` axis — every workspace this row's project sits in, resolved ONCE per
   *  fleet build from the sidebar's project order. Empty is a real answer: a
   *  project in no workspace answers to no `^` token. */
  workspaces?: readonly string[]
  /** Machine-dispatched provenance (epic seat / nightshift), or undefined when
   *  a human started this. Drives the OVER chip and the default hide. */
  managedBy?: ManagedInfo
  managed?: boolean
}

export interface PulseBandGroup {
  band: PulseBand
  rows: PulseRow[]
}

export interface PulseFleet {
  /** Groups in fixed reading order, empty ones dropped. */
  groups: PulseBandGroup[]
  /** Every visible row in band order — the keyboard navigation spine. */
  flat: PulseRow[]
  /** Counts BEFORE filtering, so the chips always show the true fleet. */
  totals: Record<PulseBand, number>
  expired: PulseRow[]
  /** Rows the current query removed. */
  hidden: number
  /** Machine-dispatched rows suppressed by the default (0 once `+over`). */
  managedHidden: number
  query: PulseQuery
  isEmpty: boolean
}

/**
 * Re-render on a wall-clock tick so ages stay honest. Only runs while a Pulse
 * surface is mounted, which is why 1s is affordable — the surface is transient.
 *
 * Exported for THE WALL's A1 pane, whose waiting clock has to count up on its
 * own: a second ticker beside this one would be the same six lines with a
 * different bug in it.
 */
export function useNowTick(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function toRow(
  c: Conversation,
  band: PulseBand,
  now: number,
  flags: PulseAttentionFlags,
  workspaces: WorkspaceIndex,
  ps?: ProjectSettings,
): PulseRow {
  const managedBy = managedInfo(c)
  const project = projectDisplayName(c.project, ps?.label)
  return {
    managedBy,
    managed: managedBy !== undefined,
    id: c.id,
    conversation: c,
    band,
    title: c.title || c.name || c.summary || c.id.slice(0, 8),
    project,
    workspaces: workspaces.byProject.get(project),
    projectIcon: ps?.icon,
    projectColor: ps?.color,
    action: pulseActionText(c, flags),
    blockedBy: hardBlockOf(c, flags),
    tag: pulseTag(c),
    ageMs: Math.max(0, now - c.lastActivity),
    costUsd: c.stats?.totalCostUsd,
    contextPct: c.autocompactPct,
    host: c.hostSentinelAlias ?? c.hostSentinelId,
    model: c.model,
  }
}

/**
 * The whole fleet, banded by activity, sorted by recency, filtered by the Pulse
 * grammar. Shared by all three surfaces (palette, strip, tide) so they can never
 * disagree about what is on fire.
 */
export function usePulseFleet(rawQuery: string, tickMs = 1_000): PulseFleet {
  const conversations = useConversations()
  const now = useNowTick(tickMs)

  const projectSettings = useConversationsStore(s => s.projectSettings)
  const flagsFor = useAttentionFlags()
  // `^eng` is in the grammar Pulse OWNS, so Pulse's own rows have to be able to
  // answer it. Without this the sigil would parse here and match nothing, which
  // reads as an empty fleet rather than as a filter nobody wired.
  const workspaces = useWorkspaceIndex()
  const query = useMemo(() => parsePulseQuery(rawQuery), [rawQuery])

  return useMemo(() => {
    const byBand = new Map<PulseBand, Conversation[]>(PULSE_BANDS.map(b => [b, []]))
    for (const c of conversations) {
      byBand.get(bandOf(c, flagsFor(c.id), now))?.push(c)
    }

    // Chip counts must agree with what the list can actually show. While
    // managed rows are hidden they are not part of the fleet the user is
    // looking at, so counting them would make every band read too high.
    const countable = (c: Conversation) => query.includeManaged || !isManaged(c)
    const totals = Object.fromEntries(
      PULSE_BANDS.map(b => [b, (byBand.get(b) ?? []).filter(countable).length]),
    ) as Record<PulseBand, number>

    const build = (band: PulseBand): PulseRow[] =>
      (byBand.get(band) ?? [])
        .slice()
        .sort((a, b) => compareInBand(band, a, b))
        .map(c => toRow(c, band, now, flagsFor(c.id), workspaces, projectSettings[projectIdentityKey(c.project)]))
        .filter(row => matchesPulseQuery(row, query))

    const groups = VISIBLE_BANDS.map(band => ({ band, rows: build(band) })).filter(g => g.rows.length > 0)
    const flat = groups.flatMap(g => g.rows)
    const expired = build('expired')
    const shown = flat.length + expired.length
    const managedCount = conversations.filter(isManaged).length

    return {
      groups,
      flat,
      totals,
      expired,
      // `hidden` is what the QUERY removed. Managed rows suppressed by the
      // default are reported separately -- conflating them would read as "your
      // filter is too tight" when the user never typed a filter at all.
      hidden: conversations.length - shown - (query.includeManaged ? 0 : managedCount),
      managedHidden: query.includeManaged ? 0 : managedCount,
      query,
      isEmpty: isEmptyQuery(query),
    }
  }, [conversations, flagsFor, projectSettings, query, now, workspaces])
}

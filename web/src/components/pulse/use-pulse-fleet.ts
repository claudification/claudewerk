import { projectIdentityKey } from '@shared/project-uri'
import { useEffect, useMemo, useState } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { pulseActionText, pulseTag } from '@/lib/pulse/action-text'
import { bandOf, compareInBand, PULSE_BANDS, type PulseBand } from '@/lib/pulse/bands'
import { isEmptyQuery, matchesPulseQuery, type PulseQuery, parsePulseQuery } from '@/lib/pulse/filter'
import { isManaged, type ManagedInfo, managedInfo } from '@/lib/pulse/managed'
import type { Conversation } from '@/lib/types'
import { projectDisplayName } from '@/lib/utils'

/** Bands that render as rows. `expired` is a collapsed count, never a band. */
export const VISIBLE_BANDS = PULSE_BANDS.filter(b => b !== 'expired')

export interface PulseRow {
  id: string
  conversation: Conversation
  band: PulseBand
  title: string
  project: string
  action: string
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
 */
function useNowTick(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function toRow(c: Conversation, band: PulseBand, now: number, label?: string): PulseRow {
  const managedBy = managedInfo(c)
  return {
    managedBy,
    managed: managedBy !== undefined,
    id: c.id,
    conversation: c,
    band,
    title: c.title || c.name || c.summary || c.id.slice(0, 8),
    project: projectDisplayName(c.project, label),
    action: pulseActionText(c),
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

  // Select the raw arrays (stable refs) and derive Sets in a memo — returning a
  // new Set straight from a selector re-fires every render (React #185).
  const pendingPermissions = useConversationsStore(s => s.pendingPermissions)
  const pendingProjectLinks = useConversationsStore(s => s.pendingProjectLinks)
  const projectSettings = useConversationsStore(s => s.projectSettings)

  const permissionIds = useMemo(() => new Set(pendingPermissions.map(p => p.conversationId)), [pendingPermissions])
  const linkIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of pendingProjectLinks) {
      ids.add(r.fromConversation)
      ids.add(r.toConversation)
    }
    return ids
  }, [pendingProjectLinks])

  const query = useMemo(() => parsePulseQuery(rawQuery), [rawQuery])

  return useMemo(() => {
    const byBand = new Map<PulseBand, Conversation[]>(PULSE_BANDS.map(b => [b, []]))
    for (const c of conversations) {
      const band = bandOf(c, { hasPendingPermission: permissionIds.has(c.id), hasPendingLink: linkIds.has(c.id) }, now)
      byBand.get(band)?.push(c)
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
        .map(c => toRow(c, band, now, projectSettings[projectIdentityKey(c.project)]?.label))
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
  }, [conversations, permissionIds, linkIds, projectSettings, query, now])
}

/**
 * S1's reading of a `WallHostVitals` row: thresholds, staleness, ordering and
 * the one-line summary the copy button yields.
 *
 * Pure and component-free on purpose. A threshold that only exists inside a
 * `className` expression cannot be tested, and "green under 55, amber under 80,
 * rose above" is exactly the kind of rule that quietly becomes three different
 * rules once it is written in three JSX attributes.
 *
 * STALENESS IS DERIVED, NEVER PUSHED. The broker sends a sample with the clock it
 * was taken on and says nothing about whether it is still true. A node that
 * stops reporting therefore goes grey on its own, at the moment it should,
 * without the broker having to notice and send a "this one is dead now" frame it
 * could equally fail to send.
 */

import { NODE_STATS_STALE_AFTER_MS } from '@shared/node-stats'
import { WALL_HOST_CPU_INTERVAL_MS, type WallHostVitals } from '@shared/wall'
import { ringValueAtCursor } from './cursor'

/** Under this, a meter is green. */
const VITALS_WARN_AT = 55
/** Under this, amber; at or above it, rose. */
const VITALS_HOT_AT = 80

/** What a meter's colour means. `unknown` is a percentage we were not given --
 *  rendered as a dash, never as an authoritative 0%. */
export type VitalsTone = 'ok' | 'warn' | 'hot' | 'unknown'

export function vitalsTone(pct: number | undefined): VitalsTone {
  if (pct === undefined || !Number.isFinite(pct)) return 'unknown'
  if (pct < VITALS_WARN_AT) return 'ok'
  if (pct < VITALS_HOT_AT) return 'warn'
  return 'hot'
}

/** The CSS colour each tone paints with. One place, so the meter, the sparkline
 *  and the number can never disagree about what "hot" looks like. */
export const VITALS_COLOR: Record<VitalsTone, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  hot: 'var(--destructive)',
  unknown: 'var(--border-strong)',
}

/** A row as the pane renders it: the wire sample plus the two facts that depend
 *  on the current clock. */
export interface HostVitalsRow extends WallHostVitals {
  /** ms since the sample was taken. */
  ageMs: number
  /** Past `NODE_STATS_STALE_AFTER_MS` -- three missed ticks. */
  stale: boolean
  /** Never undefined, so the sparkline has nothing to branch on. */
  cpuHistory: number[]
}

/**
 * Order: live nodes first, then alphabetically by alias.
 *
 * Alphabetical alone would let a box that died an hour ago sit at the top of the
 * pane; "hottest first" would make rows jump every five seconds, which is
 * unreadable on a wall you glance at. Live-then-name is stable AND puts the
 * nodes that still mean something above the ones that do not.
 */
export function hostVitalsRows(hosts: readonly WallHostVitals[], now: number): HostVitalsRow[] {
  return hosts
    .map(h => {
      const ageMs = Math.max(0, now - h.at)
      return { ...h, ageMs, stale: ageMs > NODE_STATS_STALE_AFTER_MS, cpuHistory: h.cpuHistory ?? [] }
    })
    .sort((a, b) => Number(a.stale) - Number(b.stale) || a.alias.localeCompare(b.alias))
}

/**
 * THE ROWS AS THEY READ AT A PAST OFFSET -- W1's contract for a pane with no
 * per-row clock to filter on.
 *
 * ONE NUMBER SURVIVES A REWIND, AND IT IS CPU. `cpuHistory` is the only thing a
 * node sends a history OF; ram, disk, load and the conversation count arrive as
 * a single current reading and nothing anywhere remembers what they were forty
 * minutes ago. So they go to `undefined`, which the meter already renders as
 * `--` rather than as an authoritative 0%. Carrying the live number back would
 * put today's disk under a `T-42m` header, which is the lie this whole card is
 * built to prevent.
 *
 * A NODE WHOSE RING DOES NOT REACH THE CURSOR IS DROPPED, not blanked. The ring
 * spans five minutes, the track spans three hours, so most of the track is past
 * the end of it -- and "this node has no reading that old" is a fact the pane
 * prints as a missing row plus its own empty line, not as a row of dashes that
 * looks like a broken node.
 *
 * POSITIONS, NOT TIMESTAMPS. The ring carries no time axis (see `WallHostVitals`),
 * so the lookup walks back at the producer's cadence from the row's OWN sample
 * clock. A node that skipped slots compresses its gap, exactly as the broker's
 * own rehydrate path documents; within the ring's five minutes that is at most a
 * few slots of drift, and past it there is no reading to be wrong about.
 */
export function hostVitalsAtCursor(rows: readonly HostVitalsRow[], offsetMs: number, now: number): HostVitalsRow[] {
  if (offsetMs <= 0) return [...rows]
  const cursorAt = now - offsetMs
  const at: HostVitalsRow[] = []

  for (const row of rows) {
    // How far back INTO THE RING the cursor sits. Negative means the cursor is
    // after this node's last sample -- it had already gone quiet by then, so the
    // reading at the cursor is that last sample and the row was stale already.
    const backMs = Math.max(0, row.at - cursorAt)
    const cpuPct = ringValueAtCursor(row.cpuHistory, backMs, WALL_HOST_CPU_INTERVAL_MS)
    if (cpuPct === undefined) continue
    // Slots back, from the same expression the lookup used -- computing it twice
    // is how the sparkline ends up one sample away from the number beside it.
    const slots = Math.round(backMs / WALL_HOST_CPU_INTERVAL_MS)
    const ageAtCursor = Math.max(0, cursorAt - row.at)
    at.push({
      ...row,
      cpuPct,
      memPct: undefined,
      diskPct: undefined,
      load1: undefined,
      conversations: undefined,
      // The sparkline stops at the cursor too, so it draws the minutes that LED
      // to the offset instead of minutes that had not happened yet.
      cpuHistory: row.cpuHistory.slice(0, row.cpuHistory.length - slots),
      ageMs: ageAtCursor,
      stale: ageAtCursor > NODE_STATS_STALE_AFTER_MS,
    })
  }
  return at.sort((a, b) => Number(a.stale) - Number(b.stale) || a.alias.localeCompare(b.alias))
}

/** Compact age, for the "last seen" a greyed row shows. */
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function pctLabel(pct: number | undefined): string {
  return pct === undefined ? '--' : `${pct.toFixed(0)}%`
}

/**
 * THE VITALS LINE -- what the row's copy button yields, and what the row's
 * `title` says. Deliberately the whole row rather than one number: someone
 * copying a host's vitals is pasting it into a message about that host, and the
 * number without its neighbours is the half that starts an argument.
 *
 * A stale row says so IN the line. Pasting `cpu 4%` from a box that stopped
 * reporting an hour ago is the exact lie the grey-out exists to prevent, and it
 * would survive the clipboard otherwise.
 */
export function vitalsLine(row: HostVitalsRow): string {
  const parts = [
    row.alias,
    `cpu ${pctLabel(row.cpuPct)}`,
    `ram ${pctLabel(row.memPct)}`,
    `disk ${pctLabel(row.diskPct)}`,
  ]
  if (row.load1 !== undefined) parts.push(`load ${row.load1.toFixed(2)}${row.cores ? `/${row.cores}` : ''}`)
  if (row.conversations !== undefined) parts.push(`convs ${row.conversations}`)
  parts.push(row.stale ? `LAST SEEN ${formatAge(row.ageMs)} ago` : `sampled ${formatAge(row.ageMs)} ago`)
  return parts.join('  ')
}

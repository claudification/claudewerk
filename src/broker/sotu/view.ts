/**
 * SOTU read model (Phase 5) -- the ONE assembler shared by every read surface:
 * the `get_state_of_union` MCP tool, the `GET /api/sotu` REST route, the
 * SessionStart inject, and the dispatcher overlay tie-in. Building it ONCE here
 * keeps the four surfaces from drifting (no duplicated derivation).
 *
 * It fuses the PAID chronicle (the distilled narrative) with the FREE floor:
 *   - active claims/stakes with human provenance + the passive-collision
 *     CONTENDED flag, derived from the live (non-expired) queue -- zero LLM;
 *   - git escalation alerts (at-risk/unpushed/stalled) from the latest scan.
 *
 * CLAIMS & STAKES (design addendum): a CLAIM is a file/path matched by exact
 * normalized-string equality (the free, reliable tier); a STAKE is a concept
 * matched by tag (free) or -- untagged -- by the Opus reconcile (not here). A
 * target held by 2+ DISTINCT convs is CONTENDED: in passive mode that badge is
 * the entire coordination mechanism, so it must reach every render + the inject.
 */

import type { GitAlert, GitFabric, ScribeNoteTarget, SotuTargetHold, SotuView } from '../../shared/protocol'
import { readChronicle } from './chronicle'
import { readLiveQueue } from './queue'
import type { Contribution } from './types'

/** Normalize a claim path for exact-equality matching (the free reliable tier):
 *  trim + drop a leading `./`. Deliberately light -- not a full realpath. */
function normPath(p: string): string {
  return p.trim().replace(/^\.\//, '')
}

/** The grouping key + display target for a claim/stake. Claims key on the
 *  normalized path; stakes key on the tag when present (the real-time free match)
 *  else the lowercased concept (best-effort floor match before reconcile). */
function targetKey(t: ScribeNoteTarget): { key: string; target: string; tag?: string } {
  if (t.kind === 'claim') {
    const target = normPath(t.path)
    return { key: `claim:${target}`, target }
  }
  const concept = t.concept.trim()
  return t.tag
    ? { key: `stake:tag:${t.tag.trim().toLowerCase()}`, target: concept, tag: t.tag }
    : { key: `stake:concept:${concept.toLowerCase()}`, target: concept }
}

interface HoldAcc {
  kind: 'claim' | 'stake'
  target: string
  tag?: string
  etaHint?: string
  scope?: string
  holders: Map<string, number> // convId -> earliest ts
}

/** Fold one targeted callout into the accumulator (mutates `acc` in place). */
function mergeHold(acc: Map<string, HoldAcc>, c: Extract<Contribution, { kind: 'callout' }>): void {
  if (!c.target) return
  const { key, target, tag } = targetKey(c.target)
  const cur = acc.get(key) ?? ({ kind: c.target.kind, target, holders: new Map<string, number>() } as HoldAcc)
  if (tag) cur.tag = tag
  // Latest non-empty eta/scope wins -- a re-stated hold can sharpen the hint.
  if (c.target.etaHint) cur.etaHint = c.target.etaHint
  if (c.target.scope) cur.scope = c.target.scope
  const prev = cur.holders.get(c.convId)
  if (prev === undefined || c.ts < prev) cur.holders.set(c.convId, c.ts)
  acc.set(key, cur)
}

/** Finalize an accumulator into the wire shape (holders sorted by `since`). */
function finalizeHold(a: HoldAcc): SotuTargetHold {
  const holders = [...a.holders.entries()]
    .map(([convId, since]) => ({ convId, since }))
    .sort((x, y) => x.since - y.since)
  return {
    kind: a.kind,
    target: a.target,
    ...(a.tag ? { tag: a.tag } : {}),
    ...(a.etaHint ? { etaHint: a.etaHint } : {}),
    ...(a.scope ? { scope: a.scope } : {}),
    holders,
    contended: holders.length >= 2,
  }
}

/** Active claims/stakes with provenance + CONTENDED flags, from the live queue.
 *  Pure: takes the already-filtered live contributions so it unit-tests cleanly.
 *  CONTENDED (2+ distinct convs) first, then by holder count. */
export function deriveHolds(live: Contribution[]): SotuTargetHold[] {
  const acc = new Map<string, HoldAcc>()
  for (const c of live) if (c.kind === 'callout') mergeHold(acc, c)
  return [...acc.values()]
    .map(finalizeHold)
    .sort((x, y) => Number(y.contended) - Number(x.contended) || y.holders.length - x.holders.length)
}

/** The latest git-fabric snapshot in the queue (the most recent git_scan). */
function latestFabric(live: Contribution[]): GitFabric | undefined {
  let best: GitFabric | undefined
  for (const c of live) if (c.kind === 'git_scan') best = c.git
  return best
}

/** Deduped union of escalation alerts across all branches in a fabric snapshot. */
export function deriveAlerts(fabric: GitFabric | undefined): GitAlert[] {
  if (!fabric) return []
  const seen = new Set<GitAlert>()
  for (const b of fabric.branches) for (const a of b.alerts) seen.add(a)
  return [...seen]
}

export interface BuildViewArgs {
  slug: string
  project: string
  enabled: boolean
  now: number
  /** Pre-read live (non-expired) queue. Pass this to reuse a queue the caller
   *  already read (the fleet handler builds 200+ views -- reading each queue
   *  once instead of twice halves its FS + JSON.parse cost). Omit to read here. */
  live?: Contribution[]
}

/** Assemble the full SOTU read model for a project (chronicle + free floor). */
export function buildSotuView({ slug, project, enabled, now, live: liveArg }: BuildViewArgs): SotuView {
  const chronicle = readChronicle(slug)
  const live = liveArg ?? readLiveQueue(slug, now)
  const fabric = chronicle.git ?? latestFabric(live)
  return {
    project,
    enabled,
    chronicle,
    holds: deriveHolds(live),
    alerts: deriveAlerts(fabric),
    builtAt: now,
  }
}

/** A target with its holders, for a one-line render ("path -- 2 convs, ~1h"). */
function holdLine(h: SotuTargetHold): string {
  const who = h.holders.length === 1 ? '1 conv' : `${h.holders.length} convs`
  const eta = h.etaHint ? `, ${h.etaHint}` : ''
  const badge = h.contended ? ' [CONTENDED]' : ''
  return `- ${h.kind === 'claim' ? h.target : `"${h.target}"`} -- ${who}${eta}${badge}`
}

/** Compact markdown brief for the SessionStart inject -- the narrative headline,
 *  the live trample-guard (active claims/stakes, CONTENDED first), and git alerts.
 *  Bounded so it never bloats a new conversation's system prompt. Returns '' when
 *  there is genuinely nothing to say (no narrative, no holds, no alerts). */
export function renderSotuBrief(view: SotuView, projectLabel: string): string {
  const lines: string[] = []
  const narrative = view.chronicle.narrative.trim()
  if (narrative) lines.push(narrative.split('\n').slice(0, 6).join('\n'))

  const contended = view.holds.filter(h => h.contended)
  const solo = view.holds.filter(h => !h.contended)
  if (contended.length) {
    lines.push('', 'CONTENDED -- 2+ conversations on the same target right now (coordinate before editing):')
    for (const h of contended.slice(0, 8)) lines.push(holdLine(h))
  }
  if (solo.length) {
    lines.push('', 'Spoken for (active claims/stakes):')
    for (const h of solo.slice(0, 10)) lines.push(holdLine(h))
  }
  if (view.alerts.length) lines.push('', `Git alerts: ${view.alerts.join(', ')}.`)

  const body = lines.join('\n').trim()
  if (!body) return ''
  return `## State of the Union -- ${projectLabel}\n\n${body}`
}

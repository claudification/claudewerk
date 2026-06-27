/**
 * SOTU distill prompts + output parsing (Phase 4).
 *
 * SCRIBE fold: (current chronicle + new queued items) -> updated chronicle. Cheap,
 * frequent, Haiku-class. The bard adding lines as the quest unfolds.
 * RECONCILE: (whole chronicle + measured git fabric) -> re-grounded chronicle. Rare,
 * Opus-class. The editor fact-checking the bard against git truth -- collapse
 * integrated work, surface at-risk/unpushed/stalled, prune absorbed.
 *
 * Both emit ONE JSON object (`responseFormat: json_object`) with the chronicle
 * sections `{ now, justDone, narrative }`; the runner stamps version/git/generatedAt.
 */

import { findFirstJsonObject } from '../llm-engine'
import type { ChronicleEntry, Contribution, GitFabric } from '../types'
import { integratedBranches } from './decay'

/** The mutable sections an LLM distill produces (the runner stamps the rest). */
export interface ChronicleSections {
  now: ChronicleEntry[]
  justDone: ChronicleEntry[]
  narrative: string
}

class ChronicleParseError extends Error {}

const SCRIBE_SYSTEM = [
  'You are the SCRIBE of a project State-of-the-Union chronicle: a terse "where are we / where do I look" briefing for engineers and agents sharing one repo.',
  'You are given the CURRENT chronicle plus NEW contributions since the last fold. Update the chronicle to absorb the new signal. Be a careful editor, not a hype machine.',
  'Rules: keep entries one line, factual, no marketing. NOW = conversations actively working + what they declared (locks, focus, blockers). JUST DONE = work that wrapped, with a short final state. Move finished NOW items into JUST DONE. The narrative is 1-3 plain sentences of "where are we". Never invent facts not present in the inputs.',
  'Output ONE JSON object: {"now":[{"convId","title","detail","ts"}],"justDone":[...],"narrative":"..."}. ts is epoch ms. Output JSON only.',
].join('\n')

const RECONCILE_SYSTEM = [
  'You are the RECONCILE editor of a project State-of-the-Union chronicle. You re-ground the WHOLE chronicle against MEASURED git truth and prune drift.',
  'Decay is a VALUE function whose heaviest signal is integration into main. Apply it: work on a branch measured INTEGRATED is absorbed -- collapse it to a one-line "shipped" note in JUST DONE (or drop it if already stale), never keep narrating it as live. Surface git ALERTS prominently: at-risk (uncommitted work, loss risk), unpushed (local main ahead of origin), stalled (unmerged branch rotting). Remove hallucinated continuity the scribe may have folded in.',
  'Be conservative: when an input does not support a claim, drop the claim. Keep it terse.',
  'Output ONE JSON object: {"now":[{"convId","title","detail","ts"}],"justDone":[...],"narrative":"..."}. ts is epoch ms. Output JSON only.',
].join('\n')

/** Build the SCRIBE fold prompt from the prior sections + the new items. */
export function buildScribePrompt(prior: ChronicleSections, items: Contribution[]): { system: string; user: string } {
  const user = [
    '## Current chronicle',
    JSON.stringify(prior),
    '',
    `## New contributions (${items.length})`,
    items.map(renderContribution).join('\n') || '(none)',
  ].join('\n')
  return { system: SCRIBE_SYSTEM, user }
}

/** Build the RECONCILE prompt from the whole chronicle + the git fabric. */
export function buildReconcilePrompt(
  chronicle: ChronicleSections,
  git: GitFabric | undefined,
): { system: string; user: string } {
  const integrated = integratedBranches(git)
  const user = [
    '## Whole chronicle',
    JSON.stringify(chronicle),
    '',
    '## Measured git fabric',
    git ? summarizeGitFabric(git) : '(no git fabric available this pass)',
    '',
    '## Branches measured INTEGRATED (collapse their work to shipped)',
    integrated.length ? integrated.join(', ') : '(none)',
  ].join('\n')
  return { system: RECONCILE_SYSTEM, user }
}

/** One compact line per contribution for the prompt body. */
function renderContribution(c: Contribution): string {
  const who = c.convId ? c.convId.slice(0, 8) : 'derived'
  switch (c.kind) {
    case 'callout':
      return `- [callout/${c.type}] ${who}${c.target ? ` (target ${JSON.stringify(c.target)})` : ''}: ${c.payload}`
    case 'turn_digest':
      return `- [turn] ${who}: ${renderDigestBits(c)}`
    case 'lifecycle':
      return `- [lifecycle/${c.event}] ${who}`
    case 'git_scan':
      return `- [git] ${summarizeGitFabric(c.git)}`
    case 'status': {
      const fields = [c.done, c.pending, c.blocked, c.caveats].filter(Boolean).join(' | ')
      return `- [status/${c.state}] ${who}${fields ? `: ${fields}` : ''}`
    }
  }
}

/** The non-empty fields of a turn-digest, joined compactly. */
function renderDigestBits(c: { intent?: string; touching?: string[]; result?: string; blockedOn?: string }): string {
  const bits = [
    c.intent && `intent: ${c.intent}`,
    c.touching?.length && `touched: ${c.touching.join(', ')}`,
    c.result && `result: ${c.result}`,
    c.blockedOn && `blocked: ${c.blockedOn}`,
  ].filter((b): b is string => typeof b === 'string')
  return bits.join(' | ') || '(empty)'
}

/** A terse human summary of the git fabric for the reconcile prompt. */
function summarizeGitFabric(git: GitFabric): string {
  if (!git.branches.length) return 'no branches'
  return git.branches
    .map(b => {
      const alerts = b.alerts.length ? ` !${b.alerts.join('+')}` : ''
      return `${b.branch}[${b.integration} +${b.aheadOrigin}/-${b.behindOrigin}${alerts}]`
    })
    .join(' ')
}

/** Parse + validate an LLM distill's JSON output into chronicle sections. Lenient
 *  on entries (bad ones are dropped) but throws when no JSON object is present at
 *  all -- the runner then keeps the prior chronicle and records the spend. */
export function parseChronicleOutput(raw: string): ChronicleSections {
  const json = findFirstJsonObject(raw)
  if (!json) throw new ChronicleParseError('distill output had no JSON object')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    throw new ChronicleParseError(
      `distill output JSON unparseable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return {
    now: coerceEntries(obj.now),
    justDone: coerceEntries(obj.justDone),
    narrative: typeof obj.narrative === 'string' ? obj.narrative.trim() : '',
  }
}

function coerceEntries(value: unknown): ChronicleEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(coerceEntry).filter((e): e is ChronicleEntry => e !== null)
}

/** Coerce one raw entry, or null if it has no usable detail. */
function coerceEntry(raw: unknown): ChronicleEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.detail !== 'string' || !e.detail.trim()) return null
  return {
    convId: typeof e.convId === 'string' ? e.convId : '',
    detail: e.detail.trim(),
    ts: typeof e.ts === 'number' ? e.ts : 0,
    ...(typeof e.title === 'string' ? { title: e.title } : {}),
  }
}

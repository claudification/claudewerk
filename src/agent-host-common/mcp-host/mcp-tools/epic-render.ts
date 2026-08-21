/**
 * Rendering an epic run for the thing that asked -- which is an AGENT deciding
 * what to do next, not a dashboard.
 *
 * Everything here returns prose rather than JSON, deliberately. A JSON dump
 * makes the reader re-derive the same summary every single call, and the summary
 * is the whole product: "why is this epic not moving" has an exact answer that
 * `epic-ready.ts` already computed, and printing the raw lanes instead of
 * leading with it would waste the one line worth reading first.
 *
 * `renderEpic` is the only export. The section builders stay private because
 * their SEAM is a section of one document, not an API -- a caller reaching for
 * one of them directly would be assembling a half-report.
 */

import { formatEpicRunCaps } from '../../../shared/epic-run-caps'
import type { EpicLogEntry } from '../../../shared/epic-run-types'
import { formatWhen } from '../../../shared/epic-when'
import type {
  EpicInspectCard,
  EpicInspectLive,
  EpicInspectPlan,
  EpicInspectResult,
  EpicRunListEntry,
  EpicRunSnapshot,
} from '../../../shared/protocol'

export interface EpicRunPayload {
  ok?: boolean
  error?: string
  run?: EpicRunSnapshot | null
  lease?: { convId: string; gen: number; at: string } | null
  baton?: EpicLogEntry[]
  inspect?: EpicInspectResult
  runs?: EpicRunListEntry[]
  beat?: { note: string; actions: number; spawned: string[]; error?: string }
  note?: string
}

const NONE = '(none)'

/** `t5 [in-review] Add the thing`, or with the deps that hold it. */
function card(c: EpicInspectCard): string {
  const waiting = c.waitingOn?.length ? ` <- waiting on ${c.waitingOn.join(', ')}` : ''
  return `${c.id} [${c.status}] ${c.title}${waiting}`
}

function lane(label: string, cards: readonly EpicInspectCard[]): string[] {
  if (cards.length === 0) return [`${label} (0): ${NONE}`]
  return [`${label} (${cards.length}):`, ...cards.map(c => `  - ${card(c)}`)]
}

function runHeader(run: EpicRunSnapshot): string[] {
  return [
    `epic ${run.epicId}: ${run.status} (generation ${run.gen}/${run.maxGens})`,
    `when ${formatWhen(run.cadence)} . target ${run.target} . concurrency ${run.concurrency} . dry generations ${run.dryGens}`,
    // THE THREE HANDBRAKES, on the line under the status, because "how much of
    // its budget has this run left" is a question about the run and not a detail
    // of it. `Date.now()` rather than an injected clock: this is a renderer, the
    // elapsed figure it prints is only ever read by a human or an agent right
    // now, and threading a clock through every call site to format a string
    // would be ceremony. The DECISION uses the executor's injected clock.
    `caps: ${formatEpicRunCaps(run, Date.now())}`,
    ...(run.abortReason ? [`aborted: ${run.abortReason}`] : []),
  ]
}

/** One line for the overseer singleton. `convId: ''` means it ran and released,
 *  which is a different fact from never having run -- and the difference is what
 *  tells you whether a wake is overdue or the epic has simply never started. */
function leaseLine(lease: EpicRunPayload['lease']): string {
  if (lease?.convId) return `lease: held by ${lease.convId} at gen ${lease.gen} since ${lease.at}`
  return lease ? `lease: free (last gen ${lease.gen})` : 'lease: free (never run)'
}

function batonBlock(baton: readonly EpicLogEntry[], heading: string): string[] {
  if (baton.length === 0) return []
  return [
    '',
    heading,
    ...baton.map(e => `- ${e.ts} ${e.kind}${e.cardId ? ` [${e.cardId}]` : ''}: ${e.body.slice(0, 200)}`),
  ]
}

/**
 * THE VERBS THAT ANSWER WITH A STATUS BLOCK ALONE.
 *
 * `start` doubles as arm / resume / reconfigure, so the overwhelmingly common
 * call is a one-field change -- raising a ceiling on a parked run. Printing the
 * whole plan-of-record back at a caller who just moved `max_usd` costs ~1500
 * tokens of context they wrote themselves ten minutes ago, and it makes the verb
 * that RELEASES a brake feel expensive enough to avoid. The caps line in the
 * header already answers the only question a reconfigure has.
 *
 * Not gated on "was it already armed", deliberately: a genuinely fresh arm has
 * no digest yet, only the placeholder the first overseer generation replaces, so
 * the case the gate would exist to serve has nothing to show. `get` is the
 * digest's home and stays one call away.
 */
const STATUS_ONLY_OPS = new Set(['start'])

const DIGEST_POINTER = 'digest not shown -- action=get for the plan of record'

/** start / get / pause / abort -- the run, its digest, and the baton tail. */
function renderRun(json: EpicRunPayload, op?: string): string {
  const run = json.run
  if (!run) return 'No run for this epic yet. Use action=start to arm one.'
  return [
    ...runHeader(run),
    leaseLine(json.lease),
    ...(op && STATUS_ONLY_OPS.has(op) ? [DIGEST_POINTER] : ['', '## Digest', run.digest]),
    ...batonBlock(json.baton ?? [], '## Baton (tail)'),
  ].join('\n')
}

/** The DAG's verdict. `idleReason` leads because it is the answer; the lanes
 *  below it are the evidence for that answer. */
function planSection(p: EpicInspectPlan): string[] {
  return [
    '',
    '## Why it is or is not moving',
    p.idleReason ?? `${p.dispatch.length} card(s) ready to dispatch now`,
    '',
    `## Plan (${p.children} child card(s), complete: ${p.complete ? 'yes' : 'no'})`,
    ...lane('dispatch', p.dispatch),
    ...lane('verify', p.verify),
    ...lane('questions for the overseer', p.questions),
    ...lane('held back by the concurrency ceiling', p.heldBack),
    ...lane('waiting on dependencies', p.waitingOnDeps),
  ]
}

/** What is actually running. `armed NO` on a run that says `armed` is the tell
 *  for a broker restart, and the mismatch warning is the tell for spawns racing
 *  the lease -- both were previously invisible outside the logs. */
function liveSection(l: EpicInspectLive): string[] {
  const convs = l.conversations.map(
    c => `  - ${c.id} ${c.role}${c.cardId ? ` ${c.cardId}` : ''} gen ${c.gen} [${c.status}]${c.live ? ' LIVE' : ''}`,
  )
  return [
    '',
    '## Live',
    `armed ${l.armed ? 'yes' : 'NO'} . overseer alive ${l.overseerAlive ? 'yes' : 'no'} . max gen seen ${l.maxGenSeen}`,
    `in flight: ${l.inFlight.join(', ') || NONE}`,
    `settled: ${l.settled.join(', ') || NONE}`,
    `settled but NOT acknowledged by the baton: ${l.unacknowledged.join(', ') || NONE}`,
    ...(l.generationMismatch ? [`WARNING: ${l.generationMismatch}`] : []),
    ...(convs.length > 0 ? ['conversations:', ...convs] : []),
  ]
}

function beatsSection(beats: EpicInspectResult['beats']): string[] {
  if (beats.length === 0) {
    return [
      '',
      '## Beats the sweep performed',
      '(none recorded -- this broker has not beaten this epic since it started)',
    ]
  }
  return [
    '',
    '## Beats the sweep performed (newest last)',
    ...beats.map(b => `- ${b.at} gen ${b.gen}: ${b.note}${b.error ? ` -- ERROR ${b.error}` : ''}`),
  ]
}

const NO_RUN = 'NO RUN ARTIFACT -- never armed, or armed on a broker that has since restarted'

/** The debug read. Order is the design: the reason FIRST, then what the DAG
 *  wants, then what is actually running, then what the machine last did. */
function renderInspect(i: EpicInspectResult): string {
  return [
    ...(i.run ? runHeader(i.run) : [`epic ${i.epicId}: ${NO_RUN}`]),
    // THE QUEUE, ABOVE THE PLAN. "Why is nothing dispatching" has a different
    // answer for a queued run than the DAG's, and printing the DAG's first would
    // send the reader hunting through card lanes for a reason that is not there.
    ...(i.queue ? [`queue: ${i.queue.reason}`] : []),
    leaseLine(i.lease),
    ...(i.error ? [`error: ${i.error}`] : []),
    ...(i.plan ? planSection(i.plan) : []),
    ...liveSection(i.live),
    ...beatsSection(i.beats),
    ...batonBlock(i.baton, '## Baton'),
  ].join('\n')
}

/**
 * THE BURIAL SUFFIX. Cleared runs are MARKED here rather than dropped: `list` is
 * the enumeration surface an agent uses to FIND a run, so hiding one leaves it
 * with no name anything can reach. The date is not decoration -- "cleared" with
 * no when reads as a state rather than as something a human did on a day.
 */
function clearedSuffix(r: EpicRunListEntry): string {
  if (!r.cleared) return ''
  const day = r.clearedAt?.slice(0, 10) ?? 'unknown date'
  return r.cleared === 'acknowledged'
    ? ` . CLEARED ${day} (acknowledged -- a human has seen this run end)`
    : ` . CLEARED ${day} (aged out -- dead longer than 7 days, nobody acknowledged it)`
}

function renderList(runs: readonly EpicRunListEntry[]): string {
  if (runs.length === 0) return 'No epic runs visible in this project (none armed, none with live conversations).'
  const buried = runs.filter(r => r.cleared !== null).length
  return [
    `${runs.length} epic run(s)${buried > 0 ? ` (${buried} cleared, listed last)` : ''}:`,
    ...runs.map(
      r =>
        `- ${r.epicId}: ${r.status ?? 'no run artifact'} gen ${r.gen} . armed ${r.armed ? 'yes' : 'no'} . ${r.inFlight} in flight . overseer ${r.overseerAlive ? 'alive' : 'not running'}${clearedSuffix(r)}`,
    ),
  ].join('\n')
}

function renderBeat(beat: NonNullable<EpicRunPayload['beat']>): string {
  return [
    `beat: ${beat.note}`,
    `${beat.actions} action(s), ${beat.spawned.length} conversation(s) spawned`,
    ...(beat.spawned.length > 0 ? [`spawned: ${beat.spawned.join(', ')}`] : []),
    ...(beat.error ? [`error: ${beat.error}`] : []),
  ].join('\n')
}

/**
 * One payload -> one string. WHICH renderer is chosen by the SHAPE of the reply
 * rather than by the action name, so a route that grows a field renders without
 * the tool having to learn a new case.
 *
 * `op` is a hint, not a dispatch key: the four run verbs come back in one
 * indistinguishable shape, and only the caller knows whether it asked to READ
 * the plan or to CHANGE a knob. Absent, the reply renders in full -- the verbose
 * answer is the safe default for a caller that did not say.
 */
export function renderEpic(json: EpicRunPayload, op?: string): string {
  if (json.inspect) return renderInspect(json.inspect)
  if (json.runs) return renderList(json.runs)
  if (json.beat) return renderBeat(json.beat)
  if (json.note) return json.note
  return renderRun(json, op)
}

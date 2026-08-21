/**
 * THE WORK-ORDER SCANNER -- the consumer for `#ready`.
 *
 * `ready` means "authorised for unattended work, whenever" (board-system-tags).
 * Without something reading it, the tag is a label and the `work orders`
 * checkbox is a toggle with nothing behind it -- the "enabled, last ran never"
 * failure that killed nightshift, scheduled tasks and quests in turn.
 *
 *   reads    the board + the conversation registry
 *   selects  cards tagged `ready`
 *   skips    anything with a live conversation
 *   refuses  into named buckets -- `WORK_ORDER_BUCKETS`, and nothing else
 *   does     dispatch an IMPLEMENTER@1 seat against the card
 *   is       self-catching (via `runScan`), effects injected, no broker needed
 *
 * NOTHING NEW IS DECIDED HERE. Readiness is `planTagged` (the shared fold in
 * `epic-ready.ts`, selecting by tag instead of by epic); liveness and the
 * failed-launch ceiling are `groupEpicConversations` (the shared fold in
 * `epic-sweep.ts`); the seat is `IMPLEMENTER@1` compiled by
 * `planImplementerSpawn`. This file is selection, refusal and dispatch, and it
 * is deliberately the smallest of the five scanners because all three of those
 * folds already existed.
 *
 * NOT A SCHEDULER, and it does not read settings. The caller owns the clock, the
 * per-project opt-in and the last-run stamp (scanner-opt-in). A scanner that
 * consults settings is a scanner you cannot test without them.
 */

import { type EpicPlan, planTagged } from '../../shared/epic-ready'
import type { ProjectTaskMeta } from '../../shared/project-task-types'
import { type EpicSpawnCtx, type EpicSpawnPlan, planImplementerSpawn } from '../epic-spawn-plan'
import { emptyGroup, groupEpicConversations, type ProducedOutput } from '../epic-sweep'
import type { Refusal, Scanner, ScannerDeps, ScanOutcome } from './scanner'

/**
 * The tag this scanner selects on.
 *
 * The literal rather than an import because `board-system-tags.ts` is a REGISTRY
 * of `{tag, detail}` rows for a picker, not a constants module, and it belongs to
 * `scanner-contract`. `work-order-scanner.test.ts` asserts this string is still
 * in that registry, so the two cannot drift without a test going red.
 */
export const READY_TAG = 'ready'

/**
 * THE EPIC ID EVERY WORK-ORDER SEAT IS TAGGED WITH -- a reserved lane, not a
 * real epic.
 *
 * `planImplementerSpawn` compiles a seat that always carries an `EpicLaunchTag`,
 * and that tag is what `groupEpicConversations` folds liveness out of -- so a
 * work-order seat needs an epic id whether or not its card belongs to an epic.
 * It is the scanner's own id, and it is DELIBERATELY NOT any real epic's: a seat
 * tagged with a live epic's id would be absorbed into that epic's group, counted
 * as one of its in-flight legs and acknowledged into its baton, which is two
 * engines dispatching the same card. See `epic-owned` below for the other half
 * of that guard.
 */
export const WORK_ORDER_EPIC_ID = 'work-orders'

/**
 * Every way this scanner can decline a `ready` card. Closed, so a reason it did
 * not declare is a compile error, and countable, so a pane can render the shape
 * of a backlog instead of a log nobody greps.
 */
export type WorkOrderBucket =
  | 'live-conversation'
  | 'epic-owned'
  | 'already-run'
  | 'awaiting-verdict'
  | 'needs-overseer'
  | 'waiting-on-deps'
  | 'held-back'
  | 'unspawnable'
  | 'not-actionable'
  | 'dispatch-failed'

export const WORK_ORDER_BUCKETS: readonly WorkOrderBucket[] = [
  'live-conversation',
  'epic-owned',
  'already-run',
  'awaiting-verdict',
  'needs-overseer',
  'waiting-on-deps',
  'held-back',
  'unspawnable',
  'not-actionable',
  'dispatch-failed',
] as const

export interface WorkOrderDeps extends ScannerDeps {
  /** The board for the project being scanned. Async because the board lives
   *  sentinel-side; injected because a scanner does not own an RPC. */
  getCards: () => Promise<readonly ProjectTaskMeta[]>
  /** Did this conversation ever produce a transcript entry? Feeds the shared
   *  failed-launch fold -- see `epic-sweep.ts`, which explains the default. */
  producedOutput: ProducedOutput
  /**
   * MAX WORK-ORDER SEATS IN FLIGHT. The ceiling is not optional: a backlog of
   * forty `ready` cards must not take every seat on the box. Over it, cards land
   * in `held-back` with a count rather than being truncated silently -- the rule
   * `epic-ready.ts` already states for the epic lane.
   */
  concurrency: number
  /** Everything `planImplementerSpawn` needs except the two fields this scanner
   *  supplies itself: the reserved epic id and the per-card attempt number. */
  spawnCtx: Omit<EpicSpawnCtx, 'epicId' | 'gen'>
  /** Hand a compiled seat to whatever spawns. `false` means the spawn was
   *  refused, and the card is then refused into `dispatch-failed` rather than
   *  counted as acted on -- a dispatch nobody accepted moved nothing. */
  dispatch: (plan: EpicSpawnPlan, cardId: string) => Promise<boolean>
}

/** Refuse a whole lane of the plan into one bucket, in one line. */
function refuseLane(
  cards: readonly ProjectTaskMeta[],
  bucket: WorkOrderBucket,
  detail: (card: ProjectTaskMeta) => string,
): Refusal<WorkOrderBucket>[] {
  return cards.map(card => ({ unit: card.slug, bucket, detail: detail(card) }))
}

/**
 * Cards that are `ready` but belong to an epic.
 *
 * REFUSED, NOT DISPATCHED, and this is the one judgement call in the file. An
 * epic's cards are its run's to sequence -- the overseer decides the order, the
 * DAG decides readiness, and a card the epic engine is about to dispatch must
 * not also be dispatched from here. Refusing is the recoverable direction: the
 * card is visible with a count and a reason, and dropping the `ready` tag (or
 * arming the epic) resolves it. Dispatching would have been the unrecoverable
 * one -- two implementers, one branch.
 */
function epicOwned(cards: readonly ProjectTaskMeta[]): ProjectTaskMeta[] {
  return cards.filter(c => c.epic !== undefined)
}

/** One card's attempt number, used only for the seat NAME, so a re-authorised
 *  card reads as a second attempt rather than colliding with its first. */
function attemptsFor(deps: WorkOrderDeps, cardId: string): number {
  return deps
    .getAllConversations()
    .filter(c => c.launchConfig?.epic?.epicId === WORK_ORDER_EPIC_ID && c.launchConfig.epic.cardId === cardId).length
}

/** Compile the seat and hand it over. Its own function so `scanWorkOrders` reads
 *  as select -> refuse -> dispatch and nothing else. */
async function dispatchCard(deps: WorkOrderDeps, card: ProjectTaskMeta): Promise<boolean> {
  const plan = planImplementerSpawn(
    { ...deps.spawnCtx, epicId: WORK_ORDER_EPIC_ID, gen: attemptsFor(deps, card.slug) },
    card.slug,
    'main',
    card.dependsOn ?? [],
  )
  return deps.dispatch(plan, card.slug)
}

/** Which lanes of the shared plan map onto which refusal bucket. The whole
 *  refusal vocabulary in one table, so a reader can check the cover without
 *  following the control flow. */
function planRefusals(plan: EpicPlan): Refusal<WorkOrderBucket>[] {
  return [
    ...refuseLane(plan.heldBack, 'held-back', () => 'ready, but the work-order concurrency ceiling is full'),
    ...refuseLane(
      plan.waitingOnDeps.map(w => w.card),
      'waiting-on-deps',
      card => `waiting on ${(card.dependsOn ?? []).join(', ')}`,
    ),
    ...refuseLane(plan.questions, 'needs-overseer', () => 'a question for the overseer, not a unit of work'),
    ...refuseLane(plan.unspawnable, 'unspawnable', () => 'seats keep dying before producing anything; not retried'),
    ...refuseLane(plan.verify, 'awaiting-verdict', () => 'in review -- this scanner dispatches implementers only'),
  ]
}

/**
 * ONE PASS.
 *
 * Order matters exactly once: the epic-owned and already-run guards run BEFORE
 * the fold, so a card either engine might claim never reaches the ceiling and
 * never consumes a slot another card could have used.
 */
async function scanWorkOrders(deps: WorkOrderDeps): Promise<ScanOutcome<WorkOrderBucket>> {
  const cards = await deps.getCards()
  const selected = cards.filter(c => c.tags.includes(READY_TAG))
  if (selected.length === 0) {
    return { selected: [], acted: [], refused: [], idleReason: `no card carries \`${READY_TAG}\`` }
  }

  // The SHARED liveness fold, over this scanner's own reserved lane. It answers
  // in-flight, settled and unspawnable in one pass and the epic sweep uses the
  // identical one, so the two engines cannot disagree about what is alive.
  const group =
    groupEpicConversations(deps.getAllConversations(), deps.isLive, deps.producedOutput).get(WORK_ORDER_EPIC_ID) ??
    emptyGroup(WORK_ORDER_EPIC_ID, deps.spawnCtx.project)

  const owned = epicOwned(selected)
  const ownedIds = new Set(owned.map(c => c.slug))
  const live = new Set(group.inFlight)
  const settled = new Set(group.settled)

  const refused: Refusal<WorkOrderBucket>[] = [
    ...refuseLane(owned, 'epic-owned', card => `belongs to epic \`${card.epic}\` -- that run dispatches it`),
    ...refuseLane(
      selected.filter(c => !ownedIds.has(c.slug) && live.has(c.slug)),
      'live-conversation',
      () => 'a seat is already working it',
    ),
    // THE BOUND ON THE RETRY PATH, and the reason this scanner cannot bill
    // forever. A seat that ran and finished leaves the card wherever the
    // implementer put it. If nobody moved it out of `open`, the fold would call
    // it not-started and dispatch it again, and again, every tick. A settled
    // card is re-authorised by MOVING it or by dropping the tag -- by a decision
    // somebody made, never by the clock.
    ...refuseLane(
      selected.filter(c => !ownedIds.has(c.slug) && !live.has(c.slug) && settled.has(c.slug)),
      'already-run',
      () => 'a work-order seat already ran for this card; move it or drop `ready` to re-authorise',
    ),
  ]
  const refusedIds = new Set(refused.map(r => r.unit))

  const plan = planTagged({
    cards: cards.filter(c => !refusedIds.has(c.slug)),
    tag: READY_TAG,
    concurrency: deps.concurrency,
    inFlight: group.inFlight,
    inVerify: group.inVerify,
    unspawnable: group.unspawnable,
  })
  refused.push(...planRefusals(plan))

  const acted: string[] = []
  for (const card of plan.dispatch) {
    const ok = await dispatchCard(deps, card).catch(err => {
      deps.log(`[work-orders] dispatch threw for ${card.slug}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    })
    if (ok) acted.push(card.slug)
    else refused.push({ unit: card.slug, bucket: 'dispatch-failed', detail: 'the spawn was refused' })
  }

  // WHATEVER IS LEFT. A `ready` card in a lane the fold has no opinion about --
  // `in-progress` with no live seat, `done`, `archived` -- is still a unit this
  // scanner selected, so it gets a name rather than falling out of the
  // accounting. `runScan` is what would otherwise shout about it, and shouting
  // about a done card every tick is not news.
  const accountedFor = new Set([...acted, ...refused.map(r => r.unit)])
  refused.push(
    ...refuseLane(
      selected.filter(c => !accountedFor.has(c.slug)),
      'not-actionable',
      card => `tagged \`${READY_TAG}\` but sitting in \`${card.status}\``,
    ),
  )

  return {
    selected: selected.map(c => c.slug),
    acted,
    refused,
    idleReason: acted.length > 0 ? undefined : (plan.idleReason ?? `${selected.length} card(s) selected, none ready`),
  }
}

export const workOrderScanner: Scanner<WorkOrderDeps, WorkOrderBucket> = {
  id: 'work-orders',
  tag: '[work-orders]',
  selects: `cards tagged \`${READY_TAG}\``,
  does: 'dispatch',
  buckets: WORK_ORDER_BUCKETS,
  scan: scanWorkOrders,
}

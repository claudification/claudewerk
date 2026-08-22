/**
 * NIGHTSHIFT BY TAG -- the night run's INPUT, expressed as a scanner.
 *
 * The Nightshift button used to COPY a card into `.nightshift/queue/`: title,
 * body, and a `boardRef` string pointing back at the card it was copied from.
 * Four things fell out of that, and all four are properties of the copy rather
 * than bugs in it:
 *
 *   - the copy drifts -- refine the card, the queued copy keeps the old body
 *   - `boardRef` rots -- rename or delete the card and the entry points nowhere
 *   - the queue is invisible from the board -- a second place nobody looks
 *   - nothing drained it (0 runs since 2026-06-26), so it only ever filled
 *
 * Jonas, 2026-08-21: "copy is not good.. a reference is better."
 *
 * So the tag IS the selection and the CARD is the item. This scanner reads the
 * board, takes the cards carrying `#nightshift`, and builds the run's task list
 * FRESH from each card's current body at the moment the run opens. There is no
 * second store to drift from and no pointer to dangle: a renamed card is simply
 * a card the next scan reads under its new id, and a deleted one stops being
 * selected.
 *
 * WHAT THIS FILE IS NOT. It does not revive the run engine, touch `.nightshift/`
 * or fix Phase F. `runNightshiftImpl` still receives exactly the
 * `NightshiftQueueItem[]` it received before; only where that array comes from
 * changed. The engine's own health is a separate question and a separate card.
 */

import { NIGHTSHIFT_TAG, type NightshiftQueueItem } from '../../shared/nightshift-types'
import type { ProjectTask, ProjectTaskMeta } from '../../shared/project-task-types'
import { NIGHTSHIFT_REFUSAL_BUCKETS, type NightshiftRefusalBucket } from '../../shared/scanner-buckets'
import { SCANNER_CONTRACTS } from '../../shared/scanner-contracts'
import type { TaskStatus } from '../../shared/task-statuses'
import type { Refusal, Scanner, ScannerDeps, ScanOutcome } from './scanner'

const CONTRACT = SCANNER_CONTRACTS.nightshift

/**
 * Every way this scan can decline a card it selected.
 *
 * `over-cap` is the one that would not have existed under the old queue: the
 * engine did `queue.slice(0, caps.totalTasks)` and the remainder vanished
 * without a word. Under the contract a truncation has to name itself, so the
 * cards a cap pushed out of tonight's run are countable rather than invisible.
 *
 * DECLARED IN `src/shared/scanner-buckets.ts`, with the reason for each name
 * beside it, because the per-project opt-in panel renders this vocabulary and
 * cannot import a broker module. Re-exported here so callers are unchanged.
 */
export type { NightshiftRefusalBucket }

/**
 * Lanes a tagged card is NOT run from. Deliberately only the two closed ones:
 * the TAG is the authorisation, not the lane, and refusing `in-progress` here
 * would silently mean "a card someone opened this afternoon is off tonight's
 * list", which nobody asked for. A card that is genuinely being worked is caught
 * by `live-conversation` instead, which is a fact rather than a guess.
 */
const CLOSED_LANES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'archived'])

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

/** High before low, then oldest first. Deterministic, so a cap always cuts the
 *  same tail and two scans of an unchanged board agree. */
function byPriorityThenAge(a: ProjectTaskMeta, b: ProjectTaskMeta): number {
  const rank = (PRIORITY_RANK[a.priority ?? 'medium'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'medium'] ?? 1)
  if (rank !== 0) return rank
  return a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug)
}

/**
 * The effects this scanner needs on top of the contract's four.
 *
 * `readCard` is separate from `listCards` ON PURPOSE. The list carries only a
 * `bodyPreview`; the task's prompt is the card's WHOLE body, and reading it in
 * the same pass that dispatches it is precisely what "built from the card at
 * dispatch time, never from a copy" means. One extra round-trip per admitted
 * card, at most `totalTasks` of them, once a night.
 */
export interface NightshiftScanDeps extends ScannerDeps {
  /** Canonical project URI the run belongs to -- stamped on every task. */
  project: string
  /** Every card on the board, any lane. Filtering is this scanner's job. */
  listCards: () => Promise<ProjectTaskMeta[]>
  /** The card WITH its body, read at dispatch time. `null` = gone or unreadable. */
  readCard: (slug: string) => Promise<ProjectTask | null>
  /** `caps.totalTasks` -- how many tasks one run may open with. */
  totalTasks: number
  /** Where admitted tasks land: the run's `pending` list, in dispatch order. */
  admitted: NightshiftQueueItem[]
}

/** Zero-padded ordinal, the id shape every `.nightshift/` artifact already uses
 *  (`writeTask` pads it into the filename, the branch name interpolates it). */
const ordinal = (n: number): string => String(n).padStart(3, '0')

/**
 * One card -> one task, with the card's id kept in `boardRef`.
 *
 * `boardRef` used to be the WEAK half of the arrangement -- a string that
 * outlived whatever it pointed at. Here it is the only half: the task is
 * rebuilt from the card every run, so the reference cannot go stale between
 * runs, and if the card is gone there is no task at all.
 */
export function cardToNightshiftTask(
  card: ProjectTask,
  project: string,
  index: number,
  nowMs: number,
): NightshiftQueueItem {
  return {
    id: ordinal(index),
    title: card.title,
    project,
    status: 'queued',
    source: 'board',
    boardRef: card.slug,
    created: new Date(nowMs).toISOString(),
    body: card.body,
  }
}

/** Card ids a live conversation is already working -- today, the epic seats,
 *  which are the only conversations that name their card on the wire
 *  (`launchConfig.epic.cardId`). A night worker carries a run/task ordinal
 *  instead, and cannot collide anyway: the card is untagged the moment it is
 *  dispatched, and a project runs one night at a time. */
function liveCardIds(deps: NightshiftScanDeps): Set<string> {
  const out = new Set<string>()
  for (const conv of deps.getAllConversations()) {
    const cardId = conv.launchConfig?.epic?.cardId
    if (cardId && deps.isLive(conv)) out.add(cardId)
  }
  return out
}

async function scanNightshift(deps: NightshiftScanDeps): Promise<ScanOutcome<NightshiftRefusalBucket>> {
  const tagged = (await deps.listCards()).filter(c => c.tags.includes(NIGHTSHIFT_TAG)).sort(byPriorityThenAge)
  const live = liveCardIds(deps)
  const acted: string[] = []
  const refused: Refusal<NightshiftRefusalBucket>[] = []

  for (const card of tagged) {
    if (CLOSED_LANES.has(card.status)) {
      refused.push({ unit: card.slug, bucket: 'closed-lane', detail: `card is in \`${card.status}\`` })
      continue
    }
    if (live.has(card.slug)) {
      refused.push({ unit: card.slug, bucket: 'live-conversation', detail: 'a live conversation is on this card' })
      continue
    }
    if (acted.length >= deps.totalTasks) {
      refused.push({ unit: card.slug, bucket: 'over-cap', detail: `run opens with at most ${deps.totalTasks} task(s)` })
      continue
    }
    // THE READ THAT MAKES IT A REFERENCE. Everything above decided from the
    // list; the task itself is built from the card's body as it is right now.
    const full = await deps.readCard(card.slug)
    if (!full) {
      refused.push({ unit: card.slug, bucket: 'unreadable', detail: 'the card could not be read at dispatch time' })
      continue
    }
    deps.admitted.push(cardToNightshiftTask(full, deps.project, acted.length + 1, deps.now()))
    acted.push(card.slug)
  }

  return { selected: tagged.map(c => c.slug), acted, refused, idleReason: idleReason(tagged.length, acted.length) }
}

function idleReason(selected: number, acted: number): string | undefined {
  if (acted > 0) return undefined
  if (selected === 0) return `no cards tagged #${NIGHTSHIFT_TAG}`
  return `${selected} card(s) tagged #${NIGHTSHIFT_TAG}, none of them runnable`
}

export const nightshiftScanner: Scanner<NightshiftScanDeps, NightshiftRefusalBucket> = {
  id: CONTRACT.id,
  tag: '[nightshift-scan]',
  // Quoted from the shared contract rather than restated -- the opt-in panel
  // renders the same strings, and the two describing different selections is
  // the one lie a default-deny opt-in cannot afford.
  selects: CONTRACT.selects,
  does: CONTRACT.does,
  buckets: NIGHTSHIFT_REFUSAL_BUCKETS,
  scan: scanNightshift,
}

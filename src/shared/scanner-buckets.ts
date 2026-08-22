/**
 * THE REFUSAL VOCABULARY OF EVERY SCANNER, with the reason beside each name.
 *
 * A scanner must account for every unit it selected: acted on, or refused into a
 * NAMED bucket (`src/broker/scanners/scanner.ts` is the contract). Those names
 * used to be four `as const` arrays inside four broker modules, which was fine
 * while nothing outside the broker needed them -- and the per-project opt-in
 * panel needs exactly them, to say what a checkbox will skip and why.
 *
 * A browser bundle cannot import `src/broker/scanners/*` (spawn planner, board
 * reader, sweep folds), so the vocabulary lives here and the scanners derive
 * their unions from it. THE PAIRING IS THE POINT: a bucket cannot enter a union
 * without a `why` for a human to read, because the union IS the table.
 *
 * Split from `scanner-contracts.ts` purely on size -- that file is the
 * human-facing contract per scanner, this one is the vocabulary underneath it.
 */

/**
 * THE BUCKET FOR "THE DISPATCH ITSELF DID NOT HAPPEN", spelled once.
 *
 * Every dispatching scanner needs it; `src/broker/scanners/scanner.ts`
 * re-exports it so broker callers are unchanged. It moved out of the broker
 * because the panel renders this vocabulary, and a second spelling of this
 * string is how a column silently stops counting.
 */
export const DISPATCH_FAILED_BUCKET = 'dispatch-failed'

/** The bucket name as a type, for a scanner's own `Bucket` union to include. */
export type DispatchFailedBucket = typeof DISPATCH_FAILED_BUCKET

/** One named way a scanner declines a unit it selected, plus why -- the prose a
 *  human reads next to the checkbox, and the name a pane counts. */
export interface ScannerSkip {
  bucket: string
  why: string
}

/** In the order the scanner applies them: first rule that claims a card wins. */
const REFINE_SKIPS = [
  { bucket: 'not-actionable', why: 'it is past `inbox`/`open` -- a refiner rewrites a card nobody is building yet' },
  { bucket: 'live-conversation', why: 'a refiner is already working it' },
  { bucket: 'unspawnable', why: 'its refiner seats keep dying before producing anything; not retried' },
  { bucket: 'already-run', why: 'a refiner already ran for it -- re-tag to re-authorise' },
  { bucket: 'held-back', why: 'the refiner ceiling is full this pass' },
  { bucket: 'order-refused', why: 'the refiner order asked for more privilege than the caller holds' },
  { bucket: DISPATCH_FAILED_BUCKET, why: 'the spawn itself was refused' },
] as const

const NIGHTSHIFT_SKIPS = [
  { bucket: 'closed-lane', why: 'the card is `done` or `archived`' },
  { bucket: 'live-conversation', why: 'a conversation is already working it' },
  { bucket: 'unreadable', why: 'its card file could not be read' },
  { bucket: 'over-cap', why: "the run's task cap pushed it out of tonight" },
] as const

const WORK_ORDER_SKIPS = [
  {
    bucket: 'epic-owned',
    why: 'it belongs to an epic -- that run dispatches it, and two seats on one branch is worse',
  },
  { bucket: 'live-conversation', why: 'a seat is already working it' },
  { bucket: 'already-run', why: 'a seat already ran for it -- move it or drop the tag to re-authorise' },
  { bucket: 'held-back', why: 'the work-order concurrency ceiling is full this pass' },
  { bucket: 'waiting-on-deps', why: 'a card it depends on is not done' },
  { bucket: 'needs-overseer', why: 'it is a question for the overseer, not a unit of work' },
  { bucket: 'unspawnable', why: 'its seats keep dying before producing anything; not retried' },
  { bucket: 'awaiting-verdict', why: 'it is in review -- this scanner dispatches implementers only' },
  { bucket: 'not-actionable', why: 'it is tagged but sitting in a lane the readiness fold has no opinion about' },
  { bucket: DISPATCH_FAILED_BUCKET, why: 'the spawn itself was refused' },
] as const

const EPIC_SKIPS = [
  { bucket: 'idle', why: 'the beat ran and found nothing to do -- a healthy quiet run' },
  { bucket: 'beat-crashed', why: 'the beat threw; the epic or the sentinel wants a human' },
] as const

/** Keyed by scanner, for the panel. `morning-report` has no implementation and
 *  therefore no vocabulary -- an empty list, not an invented one. */
export const SCANNER_SKIPS = {
  refine: REFINE_SKIPS,
  nightshift: NIGHTSHIFT_SKIPS,
  'work-order': WORK_ORDER_SKIPS,
  epics: EPIC_SKIPS,
  'morning-report': [],
} as const satisfies Record<string, readonly ScannerSkip[]>

export type RefineBucket = (typeof REFINE_SKIPS)[number]['bucket']
export type NightshiftRefusalBucket = (typeof NIGHTSHIFT_SKIPS)[number]['bucket']
export type WorkOrderBucket = (typeof WORK_ORDER_SKIPS)[number]['bucket']
export type EpicRefusalBucket = (typeof EPIC_SKIPS)[number]['bucket']

/** What each `Scanner` record hands to its `buckets` field, so the declared
 *  vocabulary and the rendered one are the same array. */
export const REFINE_BUCKETS: readonly RefineBucket[] = REFINE_SKIPS.map(s => s.bucket)
export const NIGHTSHIFT_REFUSAL_BUCKETS: readonly NightshiftRefusalBucket[] = NIGHTSHIFT_SKIPS.map(s => s.bucket)
export const WORK_ORDER_BUCKETS: readonly WorkOrderBucket[] = WORK_ORDER_SKIPS.map(s => s.bucket)
export const EPIC_REFUSAL_BUCKETS: readonly EpicRefusalBucket[] = EPIC_SKIPS.map(s => s.bucket)

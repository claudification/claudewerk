/**
 * THE KEY TABLES -- the one declaration of what a card's frontmatter may carry.
 *
 * Before this, the knowledge was smeared across `ORDERED_KEYS`
 * (project-card-file.ts), `STORE_KEYS` (project-doctor-linkage-match.ts), the
 * doctor's hand-written title/status checks, the gate's `str(meta.test_cmd)`
 * reads, and whatever an agent happened to type. Same move as the linkage-verb
 * work: one registry, one resolver. Everything above now derives from here.
 *
 * WHY TYPESCRIPT AND NOT A `card-schema.yml` BESIDE THE BOARD: the installed
 * rclaude and sentinel are a FROZEN bun bundle, and `~/projects/remote-claude`
 * is not reachable from every agent host. A file sitting next to the board is
 * unreachable at exactly the moment it is needed. Living in `src/shared/` means
 * it ships INSIDE the bundle, and both halves already import from here.
 *
 * LINKAGE IS NOT RESTATED. `card-linkage.ts` already owns the relationship verbs
 * -- their arity, their targets, their findings -- so those entries are DERIVED
 * from `LINKAGE_VERBS`. A second copy of `epic` is precisely the drift this file
 * exists to end.
 *
 * Pure string + object work. No `node:` imports, no fs, and no zod (pinned at
 * 4.3.6 here for the MCP SDK's sake -- a plain table plus a narrow validator is
 * smaller anyway and carries no version risk).
 */

import { GATE_MODES } from './board-gate'
import { LINKAGE_VERBS, type LinkageVerb } from './card-linkage'
import type { CardKeySpec } from './card-schema-types'
import { TASK_STATUSES } from './task-statuses'
import { WALL_PINNED_KEY } from './wall-pin'

/** Matches `PRIORITIES` in project-card-file.ts, which reads it back from here. */
export const CARD_PRIORITIES = ['low', 'medium', 'high'] as const

/**
 * Store-owned keys, keyed by name so the render ORDER can be declared once,
 * below, with the linkage verbs interleaved where cards already put them.
 */
const STORE_SPECS: Record<string, CardKeySpec> = {
  title: {
    key: 'title',
    type: 'string',
    doc: 'one-line human name for the card',
    consequence: 'the board falls back to showing the raw id',
    owner: 'store',
    required: { check: 'card-title-missing', severity: 'info' },
  },
  status: {
    key: 'status',
    type: 'enum',
    values: TASK_STATUSES,
    doc: 'the lane the card is in -- a card NEVER moves, only this key changes',
    consequence: 'the board silently renders it as `inbox`',
    owner: 'store',
    required: {
      check: 'card-status-missing',
      severity: 'warning',
      remedy: 'add a `status:` line, or move the card once with project_set_status',
    },
    // An unrecognised lane means the card turns up somewhere nobody put it. The
    // board is LYING, so it is an error -- and both the id and that severity
    // have shipped, so neither may drift just because the check moved in here.
    invalid: { check: 'card-status-invalid', severity: 'error' },
  },
  priority: {
    key: 'priority',
    type: 'enum',
    values: CARD_PRIORITIES,
    doc: 'how much it matters, for sorting and the board badge',
    owner: 'store',
  },
  tags: {
    key: 'tags',
    type: 'string[]',
    doc: 'free-form labels, used for filtering',
    consequence: 'the card reads as having no tags at all',
    owner: 'store',
  },
  created: {
    key: 'created',
    type: 'date',
    doc: 'ISO timestamp the card was written; stamped from the filesystem if absent',
    consequence: 'the board shows no creation date',
    owner: 'store',
    // Absent is only INFO because project-doctor-created.ts REPAIRS it rather
    // than nagging -- the finding exists for the `preview` path and for a card
    // whose filesystem stats are all junk.
    required: { check: 'card-created-missing', severity: 'info' },
  },
  renamed_from: {
    key: 'renamed_from',
    // SCALAR, because a card is renamed once in the overwhelming case and that
    // is the spelling the board already carries. The READER takes a list too
    // (project-card-file.ts) so a card renamed twice keeps both names -- which
    // is why the finding below is an info line with an honest remedy instead of
    // the default warning. `string[]` would have been the other way round: the
    // doctor would call the bare id on the one card that has one "mute" and
    // auto-rewrite it, which is a false statement plus an unasked-for edit.
    type: 'string',
    doc: 'the id this card used to have, so keys frozen under the old name still resolve',
    // Not a vague "nothing reads it": the thing that stops working is specific,
    // and naming it is the only way a reader learns that renaming a card is an
    // operation with a second half.
    consequence: 'an epic seat launched under the old id stops counting as work on this card',
    // HUMAN, not store: nothing writes it, because nothing performs a rename --
    // a rename is somebody moving the file. The board's job is to be told.
    owner: 'human',
    invalid: {
      check: 'card-key-type',
      severity: 'info',
      remedy: 'a bare id is canonical; a list is read too, and is the right shape for a card renamed twice',
    },
    // NOT LINKAGE, though it holds card ids and looks exactly like it. Every
    // value names a card that by definition no longer exists, so the resolver
    // would report each one `missing` forever -- an error the card can never
    // clear. Declaring it here instead is what keeps it out of that pass while
    // still teaching the schema prompt, the validator and the doctor about it.
  },
  model: {
    key: 'model',
    // STRING, NOT ENUM, and that is forced by what an enum COSTS here rather
    // than by any doubt about the value list. `card-schema-prompt.ts` renders
    // `values` inline -- forty-odd accepted slugs on one line, in the system
    // prompt of every agent that touches the board. The value IS validated
    // (card-model.ts, against the same registry the spawn layer uses); the
    // finding just lives there instead, where it can be phrased in one line.
    type: 'string',
    doc: 'model hint for a seat dispatched against this card, e.g. `opus` -- an order may clamp it, never raise it',
    consequence: 'the seat runs on the project default and the judgement behind the hint is lost',
    // HUMAN: typed at capture time or suggested by a werk-refiner. The store passes
    // it through and nothing machine-authors it.
    owner: 'human',
  },
  archived_reason: {
    key: 'archived_reason',
    // NOT an enum, and that is forced: two of the three values are the literals
    // `done` and `cold`, but the third is `duplicate-of:<card-id>` -- a POINTER,
    // which no fixed value list can express. The shape is checked by
    // project-doctor-lifecycle.ts instead, which can also resolve the id.
    type: 'string',
    doc: 'why an archived card was archived: `done`, `cold`, or `duplicate-of:<card-id>`',
    consequence: 'the card is archived with no record of what happened to it',
    // MACHINE: the morning report's `apply` op writes it at archive time from a
    // proposal the human ticked. Hand-editing it claims a decision nobody made.
    owner: 'machine',
  },
  archived_by: {
    key: 'archived_by',
    type: 'string',
    doc: 'the actor that archived the card, e.g. `report-2026-08-22`',
    // The whole point of D5 (epic-morning-report): "what happened to this card"
    // must be answerable FROM THE CARD, without scanning every report written.
    consequence: 'the archive becomes an unattributed mutation',
    owner: 'machine',
  },
  delete_at: {
    key: 'delete_at',
    type: 'date',
    // A MARKER, NOT AN INSTRUCTION, and the doc says so because that is the one
    // thing a reader could get catastrophically wrong. F18: nothing is ever
    // hard-deleted automatically -- the scavenger logs that the date elapsed and
    // stops there. Removal is a human act, always.
    doc: 'ISO 8601 date after which this card MAY be deleted -- a marker a human acts on, never an instruction',
    consequence: 'the marker is invisible to the sweep, so the card is never proposed for removal',
    // HUMAN: nothing writes this. A person decides a card has an expiry.
    owner: 'human',
  },
}

/**
 * A linkage verb said in this registry's terms. Arity IS the type: `many` means
 * the store writes an inline list, `one` a bare scalar.
 */
function fromLinkageVerb(verb: LinkageVerb, ordered: boolean): CardKeySpec {
  return {
    key: verb.key,
    type: verb.arity === 'many' ? 'string[]' : 'string',
    doc: verb.meaning,
    owner: 'store',
    ...(ordered ? { ordered: true as const } : {}),
    ...(verb.deprecated ? { deprecated: verb.deprecated } : {}),
    ...(verb.storedAs ? { storedAs: verb.storedAs } : {}),
    linkage: true,
  }
}

/**
 * THE RENDER ORDER, and the only place it is written down. This sequence is
 * exactly what cards on disk already carry, so deriving `ORDERED_KEYS` from it
 * is a no-op for every existing file -- asserted in card-schema.test.ts against
 * the literal list it replaced.
 *
 * APPEND-ONLY, and card-schema.test.ts pins that rather than the exact list: a
 * key added at the END never reshuffles a card that does not carry it, while one
 * inserted in the middle rewrites the frontmatter of every card on the board.
 */
const ORDER = [
  'title',
  'status',
  'priority',
  'tags',
  'refs',
  'quest',
  'epic',
  'depends_on',
  'relates_to',
  'created',
  // Only present on a card that has actually been renamed -- which is where the
  // one card carrying it today already puts it.
  'renamed_from',
  // THE LIFECYCLE KEYS, appended last and together. Ordered rather than merely
  // known for the two things ordering buys: the store writes them, so they get
  // a fixed position instead of landing wherever a hand edit left them; and an
  // ordered key set to `''` is DROPPED rather than written as an empty line, so
  // clearing `archived_reason:` on an un-archive leaves no residue.
  'archived_reason',
  'archived_by',
  'delete_at',
  // APPENDED, like every key before it: a key added at the end never reshuffles
  // the frontmatter of a card that does not carry one, and today that is every
  // card on the board.
  'model',
] as const

/**
 * DONE-gate keys. Two halves that must not be confused: `gate` / `test_cmd` /
 * `base` / `acceptance_verified` are hand-authored CONFIGURATION the gate reads,
 * while every `evidence_*` plus `verdict` is written BY the gate from git and
 * `ctx.getIdentity()` at transition time. That is why the second half says
 * `machine` out loud -- editing one by hand forges evidence the gate produced.
 */
const GATE_SPECS: readonly CardKeySpec[] = [
  { key: 'gate', type: 'enum', values: GATE_MODES, doc: 'per-card DONE-gate override', owner: 'human' },
  { key: 'test_cmd', type: 'string', doc: 'command the gate runs before allowing in-review/done', owner: 'human' },
  { key: 'base', type: 'string', doc: 'git ref the gate diffs against (default main)', owner: 'human' },
  {
    key: 'acceptance_verified',
    type: 'string[]',
    doc: 'acceptance criteria a human confirmed, copied into evidence',
    owner: 'human',
  },
  { key: 'evidence_branch', type: 'string', doc: 'branch HEAD was on when the gate ran', owner: 'machine' },
  { key: 'evidence_base', type: 'string', doc: 'base ref the gate actually diffed against', owner: 'machine' },
  { key: 'evidence_commits', type: 'number', doc: 'commits between base and HEAD at gate time', owner: 'machine' },
  { key: 'evidence_diffstat', type: 'string', doc: 'git --shortstat for the gated diff', owner: 'machine' },
  {
    key: 'evidence_tests',
    type: 'enum',
    values: ['pass', 'fail', 'none'],
    doc: "outcome of the card's test_cmd at gate time",
    owner: 'machine',
  },
  { key: 'evidence_tests_tail', type: 'string', doc: 'tail of the test output, for a failed gate', owner: 'machine' },
  {
    key: 'evidence_suites',
    type: 'string[]',
    doc: 'every command the gate ran, named, with its result -- test_cmd plus the suites the diff obliged',
    owner: 'machine',
  },
  {
    key: 'evidence_acceptance_verified',
    type: 'string[]',
    doc: 'acceptance_verified as captured at gate time',
    owner: 'machine',
  },
  {
    key: 'evidence_worker',
    type: 'string',
    doc: 'conversation that moved the card to in-review -- it may NOT approve itself',
    owner: 'machine',
  },
  { key: 'evidence_verified_at', type: 'string', doc: 'ISO time the independent verdict landed', owner: 'machine' },
  { key: 'verdict', type: 'string', doc: 'who approved the card, written by the Tier-1 check', owner: 'machine' },
]

/**
 * Keys the DASHBOARD owns. Deliberately outside `ORDER`: adding one there would
 * churn the frontmatter of every card on the board to move a line, and this key
 * is absent from all but a handful of them.
 */
const WALL_SPECS: readonly CardKeySpec[] = [
  {
    key: WALL_PINNED_KEY,
    // `enum: [true]` and not a boolean type, because the frontmatter subset has
    // no booleans to validate (card-schema-validate.ts says so out loud) and
    // because `true` is the ONLY value ever written: unpinning DELETES the key,
    // so `wall_pinned: false` is a card in a state the board never produces.
    type: 'enum',
    values: ['true'],
    doc: "watchlisted onto THE WALL's pinned-epics pane; only meaningful on an epic card",
    consequence: 'the epic stops being watched on the wall',
    owner: 'human',
  },
]

/**
 * DISPATCH PRECONDITIONS -- what must be true of the WORLD, not of other cards,
 * before a seat may be sent at this one.
 *
 * Outside `ORDER` for `WALL_SPECS`' reason: all but a handful of cards will ever
 * carry one, and an ordered key would churn the frontmatter of the whole board
 * to move a line nobody has.
 */
const PRECONDITION_SPECS: readonly CardKeySpec[] = [
  {
    key: 'requires_deploy',
    type: 'string[]',
    doc: 'capability tokens the running build must already provide before a seat is dispatched here (deployed-capabilities.ts)',
    // Not "the key is ignored": what actually happens is the specific bad thing
    // the key was written to stop, and naming it is the only way a reader learns
    // that `depends_on:` is not a substitute.
    consequence: 'a card whose work is only valid after a deploy goes out to a seat before that deploy',
    // HUMAN: whoever writes the card knows it is code+data coupled. Nothing can
    // infer that from the diff.
    owner: 'human',
  },
]

const ORDERED_SET = new Set<string>(ORDER)

/** The ordered block, in ORDER, drawing each entry from whichever table owns it. */
function orderedSpecs(): CardKeySpec[] {
  const byLinkageKey = new Map(LINKAGE_VERBS.map(v => [v.key, v]))
  return ORDER.map(key => {
    const store = STORE_SPECS[key]
    if (store) return { ...store, ordered: true as const }
    const verb = byLinkageKey.get(key)
    if (verb) return fromLinkageVerb(verb, true)
    throw new Error(`card-schema ORDER names "${key}", which no table declares`)
  })
}

/**
 * Every key the board KNOWS: the ordered block first, then the linkage verbs the
 * store does not reposition (aliases and the deprecated `blocks`), then the gate
 * keys. Membership here grants NOTHING -- an unlisted key is still preserved
 * verbatim and reported by nobody.
 */
export function buildCardKeys(): CardKeySpec[] {
  return [
    ...orderedSpecs(),
    ...LINKAGE_VERBS.filter(v => !ORDERED_SET.has(v.key)).map(v => fromLinkageVerb(v, false)),
    ...GATE_SPECS,
    ...WALL_SPECS,
    ...PRECONDITION_SPECS,
  ]
}

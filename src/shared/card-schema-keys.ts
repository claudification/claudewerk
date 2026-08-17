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
  ]
}

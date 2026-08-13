/**
 * THE CLOSED VOCABULARY of card-to-card linkage.
 *
 * A card's frontmatter is deliberately an open bag (PRESERVE-UNKNOWN-KEYS in
 * project-card-file.ts) because the DONE-gate machine-authors `evidence_*` and
 * nobody should have to teach the store about every one. But LINKAGE is the one
 * part that cannot be open: a key that claims a relationship between two cards
 * and is not read by anything is worse than no key at all. It looks like it
 * works. `relates_to` sat on 13 cards for months doing precisely nothing.
 *
 * So linkage -- and only linkage -- gets a registry. Every verb declares its
 * arity, what its targets ARE, and which findings the resolver reports for it.
 * A key not in here is not a relationship; if it merely LOOKS like one, the
 * doctor says so (project-doctor-linkage.ts) instead of letting it vanish.
 *
 * ALIASES over second keys. `blocked_by` is exactly `depends_on` said the other
 * way round -- there is no fact one can express that the other cannot. A real
 * second key would double every read site forever and re-create the mess
 * `blocks:` just got cleaned out of (see epic-cards.ts). So aliases normalise to
 * ONE stored form on write, and the read path folds them anyway, because an
 * alias that silently does nothing is the exact bug this file exists to kill.
 *
 * Pure string + object work. No `node:` imports, no fs -- the control panel, the
 * sentinel and the doctor all share this one definition.
 */

/** What a verb's targets are, which decides whether "does it exist?" is even
 *  a question the board can answer. */
export type LinkageTargetKind =
  /** Another card's id. Resolvable -- the doctor can check it. */
  | 'card'
  /** A free string: petname, file path, commit, URL. Never resolved as a card. */
  | 'free'

export type LinkageArity = 'one' | 'many'

/** Which finding ids the shared resolver emits for this verb. Spelled out per
 *  verb rather than derived from the key, because `epic-orphan` and friends are
 *  a SHIPPED, greppable vocabulary (project-doctor-epics.ts) and renaming them
 *  to fit a prefix scheme would be churn for nobody's benefit. */
export interface LinkageChecks {
  /** Target id is not on the board. ALWAYS a warning -- see SEVERITY below. */
  missing: string
  /** The card names itself. */
  self: string
  /** Following the verb returns to where it started. Only set for verbs where
   *  that is a contradiction rather than a shrug. */
  cycle?: string
}

export interface LinkageVerb {
  /** The frontmatter key as written on disk. */
  key: string
  arity: LinkageArity
  target: LinkageTargetKind
  /** Human-readable, used verbatim in findings ("depends_on \"x\", which..."). */
  meaning: string
  /** Set on an ALIAS: the verb key this one is stored as. Reading folds it in;
   *  writing emits the stored form only. */
  storedAs?: string
  /** A relates B implies B relates A. Only meaningful for `card` targets. */
  symmetric?: boolean
  /** Parsed and reported, never written. The remedy text says what replaced it. */
  deprecated?: string
  /** Findings for a `card`-target verb. Absent for `free` ones -- there is
   *  nothing to resolve. */
  checks?: LinkageChecks
  /** Self-reference is a contradiction the board cannot resolve (error), not
   *  merely pointless (info). True for sequencing and parenthood. */
  selfIsError?: boolean
}

/**
 * SEVERITY, and it is the rule the whole registry turns on: a reference to a
 * card that does not exist YET is a WARNING, never an error. Cards get written
 * out of order constantly -- you sketch the children before the epic exists, or
 * name a sibling you are about to write. A gate that fails on that teaches
 * people to stop writing links, which costs far more than the dangling
 * reference ever did. Only a contradiction the board cannot resolve -- a cycle,
 * a self-dependency -- is an error.
 */
export const LINKAGE_VERBS: readonly LinkageVerb[] = [
  {
    key: 'epic',
    arity: 'one',
    target: 'card',
    meaning: 'the epic this card belongs to',
    checks: { missing: 'epic-orphan', self: 'epic-cycle', cycle: 'epic-cycle' },
    selfIsError: true,
  },
  {
    key: 'depends_on',
    arity: 'many',
    target: 'card',
    meaning: 'cards that must reach done before this one is ready',
    checks: { missing: 'epic-depends-missing', self: 'epic-depends-self', cycle: 'depends-cycle' },
    selfIsError: true,
  },
  {
    // The human-natural inverse spelling. Jira, GitHub and every tracker that
    // offers both map them onto one link type with a computed inverse; so do we.
    key: 'blocked_by',
    arity: 'many',
    target: 'card',
    meaning: 'cards that must reach done before this one is ready',
    storedAs: 'depends_on',
  },
  {
    // 13 cards already carry this and every value is a card id, so it is a real
    // relation people reach for. Promoted rather than reported as unknown.
    // It asserts nothing about scheduling or parenthood, so it cannot produce a
    // contradiction: no cycle check, and naming yourself is pointless, not wrong.
    key: 'relates_to',
    arity: 'many',
    target: 'card',
    meaning: 'cards worth reading alongside this one',
    symmetric: true,
    checks: { missing: 'relates-missing', self: 'relates-self' },
  },
  {
    key: 'see_also',
    arity: 'many',
    target: 'card',
    meaning: 'cards worth reading alongside this one',
    storedAs: 'relates_to',
  },
  {
    // Deprecated as PARENTHOOD (anvil-epic used it for its 13 children) and as
    // storage generally: `blocks` is now computed as the inverse of depends_on,
    // so a stored copy can only ever go stale. Still parsed so a card carrying
    // it gets told, rather than being reported as an unknown key.
    key: 'blocks',
    arity: 'many',
    target: 'card',
    meaning: 'cards that wait on this one',
    deprecated:
      'blocks is computed as the inverse of depends_on now -- put `depends_on: [this card]` on each waiter instead',
    checks: { missing: 'blocks-missing', self: 'blocks-self' },
  },
  { key: 'quest', arity: 'one', target: 'free', meaning: 'quest membership (a petname, not a card id)' },
  { key: 'refs', arity: 'many', target: 'free', meaning: 'untyped references: card paths, files, docs, commits' },
] as const

const BY_KEY = new Map(LINKAGE_VERBS.map(v => [v.key, v]))

/** The verb for a frontmatter key, or undefined if the key is not linkage. */
export function linkageVerb(key: string): LinkageVerb | undefined {
  return BY_KEY.get(key)
}

/** Where a verb's values actually live on disk -- itself, unless it is an alias. */
export function storageKey(verb: LinkageVerb): string {
  return verb.storedAs ?? verb.key
}

/** Verbs that resolve to real cards, so the shared resolver has something to
 *  check. Aliases are excluded: their values are folded into the stored verb
 *  before resolution, so checking them twice would double every finding. */
export const RESOLVABLE_VERBS: readonly LinkageVerb[] = LINKAGE_VERBS.filter(
  v => v.target === 'card' && !v.storedAs && v.checks,
)

/**
 * CARD SEAM -- what a "card" is to the UI, independent of who stores it.
 *
 * Today the only backend is the file-based project board
 * (`.rclaude/project/cards/<id>.md`, read through the sentinel). Tomorrow it may
 * be GitHub issues, Linear, or Jira. Everything above this file -- the inline
 * glyph, the hover card, the epic rollup -- speaks ONLY these types, so adding a
 * backend is one `registerCardProvider()` call and zero component changes.
 *
 * The rule that makes that possible: a provider maps its native workflow onto
 * the canonical `CardState` (six values, fixed) and ALSO hands back its own
 * `statusLabel` verbatim. Colour comes from the canonical state; the words the
 * user reads come from the backend. A Jira lane called "Awaiting UAT" stays
 * "Awaiting UAT" on screen while painting as `review`.
 */

/**
 * Canonical lifecycle position. The ONLY thing colour keys off.
 *
 * Seven values, chosen because every tracker worth supporting already has them:
 * `triage` (our inbox, Linear's Triage, Jira's backlog), `todo`, `active`,
 * `review`, `done`, `dropped` (archived / won't-fix / closed-not-planned), and
 * `unknown` for an id nobody claims.
 */
export type CardState = 'triage' | 'todo' | 'active' | 'review' | 'done' | 'dropped' | 'unknown'

export type CardKind = 'card' | 'epic'

export type CardPriority = 'low' | 'medium' | 'high'

/** A card address. `scope` is the provider's container (project URI, repo, board). */
export interface CardRef {
  provider: string
  id: string
  scope?: string
}

/** Epic rollup over child cards. `total` excludes dropped -- see epic-cards.ts. */
export interface CardProgress {
  todo: number
  active: number
  done: number
  dropped: number
  total: number
  /** 0-100, or null when there is nothing to measure. */
  pct: number | null
}

export interface CardSummary {
  ref: CardRef
  kind: CardKind
  state: CardState
  /** The backend's own word for the lane, shown verbatim. */
  statusLabel: string
  /** `partial` = identity + state known (manifest-cheap), detail still loading. */
  detail: 'partial' | 'full'
  title?: string
  /** The card's opening lines, as the backend already summarises them. What the
   *  card SAYS is the question a hover asks, and a title plus a lane is not an
   *  answer to it. Absent when the backend has no cheap preview. */
  preview?: string
  priority?: CardPriority
  tags: string[]
  /** ISO date the card was created. */
  created?: string
  /** Last-modified, ms since epoch. */
  updated?: number
  /** Epics only, and only once children are known. */
  progress?: CardProgress
}

export type CardLookup =
  | { status: 'resolving' }
  | { status: 'ready'; summary: CardSummary }
  /** The backend answered and has no such card. */
  | { status: 'unknown' }
  /** Nothing to ask -- no project selected, provider offline. */
  | { status: 'unavailable' }

export interface CardProvider {
  id: string
  /** Recognize an href as one of mine, or return null. Fills `scope` if it has one. */
  matchHref(href: string): CardRef | null
  /** Synchronous read of what is already cached. Never fetches. */
  peek(ref: CardRef): CardLookup
  /** Ask the backend for this card (cheap identity first, then detail). */
  resolve(ref: CardRef): void
  /** Ask for whatever the epic rollup needs. Called on hover, not on render. */
  resolveDeep?(ref: CardRef): void
  /** Fires whenever a later `peek` could answer differently. */
  subscribe(fn: () => void): () => void
}

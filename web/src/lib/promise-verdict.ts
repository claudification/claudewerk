/**
 * How a `PromiseVerdict` reads on screen. ONE definition, both surfaces.
 *
 * P3 and the project action panel render the same five states at different
 * widths, and the failure this file exists to prevent is the two of them
 * disagreeing about what a state MEANS -- a wall pill saying one thing and the
 * panel row beside it implying another is worse than either alone, because then
 * neither can be trusted and the ledger goes unread.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  `could not verify` IS NOT GREY, AND IT IS NEVER FOLDED INTO ANOTHER      ┃
 * ┃  STATE.                                                                  ┃
 * ┃                                                                          ┃
 * ┃  It gets its OWN tone and its OWN glyph, distinct from both the benign    ┃
 * ┃  states and the broken ones. "I could not check" is not "it is fine" and  ┃
 * ┃  it is not "it is broken" either; a UI that greys it in with `not         ┃
 * ┃  started` tells the reader nothing went wrong, which is the same lie in a ┃
 * ┃  nicer font.                                                             ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * TONE, NOT A CLASS NAME. The wall paints from CSS variables in `wall.css` and
 * the panel paints from the board's semantic tailwind tokens, so a shared
 * `className` here would have to be wrong on one of them. What is genuinely
 * shared is the SEVERITY, and each surface maps it with its own palette.
 */

import type { PromiseVerdict } from '@shared/promise-ledger'

/**
 * Four tones for five verdicts: the two BROKEN states share one, because
 * "the sha is fiction" and "the sha is real but not on main" are the same news
 * to a reader scanning a wall -- the promise is not backed. They keep separate
 * WORDS, which is where the difference belongs.
 */
export type VerdictTone =
  /** Every named commit is on main. The row that needs no reader. */
  | 'delivered'
  /** Named commits that do not stand up. The accusation, and it had better be right. */
  | 'broken'
  /** The resolver could not answer. Its own tone, always. */
  | 'unknown'
  /** Nobody claimed anything. Benign on an open card; damning on a filed one. */
  | 'unclaimed'
  /** Filed before the ledger existed. Recedes furthest -- it is the one state
   *  that is genuinely not news, and there are hundreds of them. */
  | 'historic'

export interface VerdictFace {
  tone: VerdictTone
  /** A single character, so a row can carry the state at any width. */
  glyph: string
  /** For a wall row -- the widest this can be and still leave room for a title. */
  short: string
  /** The card's own wording, verbatim. Used wherever there is room, and in the
   *  accessible name everywhere there is not. */
  long: string
}

/** The five states, and nothing folds. */
const FACES: Record<PromiseVerdict, VerdictFace> = {
  delivered: { tone: 'delivered', glyph: '✓', short: 'delivered', long: 'delivered' },
  'commit-missing': {
    tone: 'broken',
    glyph: '✗',
    short: 'no such commit',
    long: 'names a commit that does not exist',
  },
  'not-on-main': { tone: 'broken', glyph: '✗', short: 'not on main', long: 'commit is NOT on main' },
  // `?` and not `-`: the glyph has to READ as a question, because the whole
  // point of this state is that nobody answered one.
  unverifiable: { tone: 'unknown', glyph: '?', short: 'could not verify', long: 'could not verify' },
  'not-started': { tone: 'unclaimed', glyph: '·', short: 'not started', long: 'not started' },
  // `~` and not `·`: it has to be distinguishable from `not started` at a glance,
  // because the two differ by exactly the thing a reader needs -- whether this
  // card is being accused or excused.
  'pre-ledger': { tone: 'historic', glyph: '~', short: 'pre-ledger', long: 'filed before the ledger existed' },
}

export function verdictFace(verdict: PromiseVerdict): VerdictFace {
  return FACES[verdict]
}

/**
 * Why a card is in the LOUD table, said in one sentence.
 *
 * The table's heading is "filed as finished with NO commit behind it", which is
 * exactly true of `not-started` and only roughly true of the rest -- a card with
 * an unresolvable sha did name something. Saying so per row is what stops the
 * table from over-claiming, and a table that over-claims is one people learn to
 * discount.
 */
export function brokenReason(verdict: PromiseVerdict): string {
  if (verdict === 'not-started') return 'nothing behind it -- no commit was ever named'
  if (verdict === 'commit-missing') return 'names a commit that does not exist'
  if (verdict === 'not-on-main') return 'the commit it names is NOT on main'
  // Never reached from the loud table -- `isBrokenPromise` excludes it -- but a
  // reason function that throws away a case is one that lies the day it is.
  if (verdict === 'pre-ledger') return 'filed before the ledger existed -- no promise was possible'
  return 'could not verify -- the commit it names was never checked'
}

/** The ledger's own summary line: how many of each, worst first, zeroes dropped. */
export function verdictTally(verdicts: readonly PromiseVerdict[]): { verdict: PromiseVerdict; count: number }[] {
  const order: PromiseVerdict[] = [
    'commit-missing',
    'not-on-main',
    'unverifiable',
    'not-started',
    'delivered',
    'pre-ledger',
  ]
  return order
    .map(verdict => ({ verdict, count: verdicts.filter(v => v === verdict).length }))
    .filter(entry => entry.count > 0)
}

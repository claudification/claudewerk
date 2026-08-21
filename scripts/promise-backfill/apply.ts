/**
 * A `Plan` -> the card's new bytes. Still pure: text in, text out, no fs.
 *
 * Every write goes through `promise-ledger.ts`'s LINE SURGERY writers and never
 * through a YAML round trip -- re-serialising a card is what inverted portal2's
 * ledger, and this script would do it 342 times in one run.
 *
 * BOTH WRITERS CAN REFUSE (a card with no front matter, a card mixing CRLF and
 * LF) and a refusal is never a silent no-op here. A backfill that quietly
 * skipped 20 cards would report "342 done" and leave a fifth of the board
 * unexplained, which is a worse lie than not running it at all.
 */

import { appendCloses, insertPromiseBlock, type PromiseSeed } from '../../src/shared/promise-ledger'
import type { Plan } from './join'

export interface Applied {
  text: string
  changed: boolean
  /** Why nothing (or only part) was written. Null when all went as planned. */
  refused: string | null
  /** Shas actually added -- empty for an amnesty, which claims nothing. */
  added: string[]
}

const unchanged = (text: string, refused: string | null = null): Applied => ({
  text,
  changed: false,
  refused,
  added: [],
})

/**
 * The seed for a card that has no block yet.
 *
 * `asked:` is LEFT EMPTY, deliberately, and this is the one place it would be
 * tempting not to. The card's title is right there and would fill the column --
 * with a restatement of the card's name, which tells the next agent nothing it
 * could not read off the id. `promise-ledger.ts` says it in its own doc: a
 * plausible-looking auto-filled ask silences the "no ask written down" warning
 * and hands back the old world with extra steps.
 */
function seedFor(plan: Extract<Plan, { action: 'record' | 'amnesty' }>): PromiseSeed {
  return {
    agreed: plan.agreed,
    conversation: 'promise-backfill',
    ...(plan.action === 'amnesty' ? { preLedger: true } : {}),
    ...(plan.action === 'record' && plan.inferred ? { inferred: true } : {}),
  }
}

// CRAP is estimated with no coverage data here; every branch below is pinned by
// `join.test.ts` ("applyPlan -- line surgery, refusals never silent"), including
// both refusal paths. Six cyclomatic over 24 lines is not a knot to untie.
// fallow-ignore-next-line complexity
export function applyPlan(text: string, plan: Plan): Applied {
  if (plan.action === 'skip') return unchanged(text)

  // Insert first. A card that already has a block comes back `changed: false,
  // refused: null` -- not an error, and the append below still runs against it.
  const seeded = insertPromiseBlock(text, seedFor(plan))
  if (seeded.refused !== null) return unchanged(text, seeded.refused)

  if (plan.action === 'amnesty') {
    // An amnesty claims NOTHING, so there is nothing to append. If the card
    // already had a block, `insertPromiseBlock` left it alone and this is a
    // no-op -- which is right: `planFor` never routes a card with a block here.
    return { text: seeded.text, changed: seeded.changed, refused: null, added: [] }
  }

  const appended = appendCloses(seeded.text, plan.commits)
  if (appended.refused !== null) return unchanged(text, appended.refused)
  return {
    text: appended.text,
    changed: seeded.changed || appended.changed,
    refused: null,
    added: appended.added,
  }
}

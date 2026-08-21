/**
 * `model:` ON A CARD -- reading it, reporting it, and clamping it to a seat.
 *
 * A refiner reads the card and the code it points at, which is exactly the
 * moment somebody knows whether this is a rename-three-symbols job or a design
 * job. That judgement used to be thrown away. This key is where it lands, and
 * this file is everything that is true about the key that a key table cannot
 * express.
 *
 * IT IS A HINT, AND THE ORDER STILL WINS. `composeOrderCaps` treats `model` as a
 * SELECTION field -- "the EXPLICIT choice of whoever runs the order wins" --
 * which is right for a human at a spawn dialog and WRONG for a card: handing a
 * card's `model: opus` straight in as the base would let a card silently BUY a
 * tier its seat's order refused it, which is the one direction an order may
 * never move. So the hint is clamped HERE, before it ever reaches the base, and
 * what reaches `composeOrderCaps` is already a narrowing.
 *
 * CLAMP, NOT REFUSE. The alternative -- refusing to dispatch a card whose hint
 * overshoots -- is a card that never runs and nobody can see why, on a board
 * nobody is watching. A clamp runs the work at the seat's own tier and says so
 * in the dispatch log, which is a bad outcome you can read rather than a silent
 * one you cannot.
 *
 * UNKNOWN IS IGNORED, NEVER FATAL. A free-string model on a card is a spawn that
 * fails hours later with nobody watching, so the value is validated on the way
 * in; but a card that fails to READ is a card that vanishes off the board, so an
 * unrecognised slug drops to `undefined` and gets a doctor finding instead.
 *
 * Pure string + registry work. No `node:` imports, no fs.
 */

import { modelSpendRank, validateModel } from './models'
import type { DoctorFinding } from './project-doctor-types'

/** The frontmatter key, spelled once. */
export const CARD_MODEL_KEY = 'model'

/**
 * The `#model-<slug>` tag prefix.
 *
 * Jonas wrote `#model-opus` on the card that asked for this feature, and it is
 * the only spelling that works on a keyboard-less iPad where the `:` completer
 * has no popup to accept from. It is ACCEPTED and then normalised into the
 * `model:` key on write -- leaving a routing tag on the board would mean every
 * reader of the hint had to check two places forever.
 */
export const CARD_MODEL_TAG_PREFIX = 'model-'

/**
 * The card's hint as a slug the spawn layer will accept, or `undefined`.
 *
 * A list where a scalar belongs reads as NOTHING rather than as its first entry,
 * matching every other scalar key on the board (card-schema-validate.ts): the
 * doctor is busy reporting the key as mute, and projecting a value out of it
 * would invent the one thing the report says is absent.
 */
export function readCardModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const slug = value.trim()
  if (slug === '') return undefined
  return validateModel(slug).valid ? slug : undefined
}

/**
 * The model hidden in a `#model-<slug>` tag, or `undefined`.
 *
 * An UNKNOWN slug returns undefined and the tag survives as an ordinary tag --
 * eating `#model-frobnicate` off the board would destroy the only evidence of
 * what the human actually typed, which is the fact the doctor needs to report.
 */
export function modelFromTag(tag: string): string | undefined {
  const lower = tag.trim().toLowerCase()
  if (!lower.startsWith(CARD_MODEL_TAG_PREFIX)) return undefined
  return readCardModel(lower.slice(CARD_MODEL_TAG_PREFIX.length))
}

/** Tags with every recognised `#model-<slug>` removed, plus the model they named
 *  (the LAST one wins, matching how a scalar key behaves when written twice). */
export function foldModelTags(tags: readonly string[]): { tags: string[]; model?: string } {
  let model: string | undefined
  const kept: string[] = []
  for (const tag of tags) {
    const found = modelFromTag(tag)
    if (found === undefined) kept.push(tag)
    else model = found
  }
  return { tags: kept, model }
}

/** What a card contributes to a seat's model, after the order has had its say. */
export interface CardModelChoice {
  /** Hand this to the spawn as its explicit model. `undefined` means the card
   *  said nothing usable and the order's own cap stands untouched. */
  model?: string
  /** One line for the dispatch log. Present ONLY when the hint did not survive
   *  intact -- a clamp that logs nothing is a silent downgrade, which is the
   *  failure mode this whole file is arranged around. */
  note?: string
}

/**
 * Clamp a card's hint to what the seat's order allows.
 *
 * FOUR CASES, and the interesting one is the fourth:
 *
 *   no hint          the card said nothing; the order's cap stands
 *   no cap           nothing to narrow against; the hint is the choice
 *   hint <= cap      a real narrowing (or a match); the hint wins
 *   hint > cap       CLAMPED to the cap, with a line saying so
 *
 * A slug that cannot be RANKED (an unknown id, a provider-specific one, a
 * dynamic alias like `best`) falls into the last case on purpose: a value that
 * cannot be proven to be a narrowing is not one, and guessing in the permissive
 * direction is how "an order may only ever narrow" stops being true.
 */
export function clampCardModel(hint: string | undefined, cap: string | undefined): CardModelChoice {
  if (!hint) return {}
  if (!cap) return { model: hint }
  if (hint === cap) return { model: hint }
  const hintRank = modelSpendRank(hint)
  const capRank = modelSpendRank(cap)
  if (hintRank !== undefined && capRank !== undefined && hintRank <= capRank) return { model: hint }
  const why = hintRank === undefined || capRank === undefined ? 'cannot be ranked against' : 'asks for more than'
  return {
    model: cap,
    note: `card asks for \`${hint}\`, which ${why} the seat's cap \`${cap}\` -- running on \`${cap}\``,
  }
}

export interface CardModelSource {
  id: string
  /** Raw frontmatter exactly as parsed. NOT a projected card: projection has
   *  already dropped the unrecognised value that is the thing being reported. */
  meta: Record<string, unknown>
}

/**
 * The doctor's view: a `model:` key present but unusable.
 *
 * NOT in the key registry's own type check, and that absence is a decision. The
 * key would have to be declared `type: 'enum'` to get one, and its value list is
 * forty-odd slugs -- which `card-schema-prompt.ts` renders inline into the
 * system prompt of every agent that touches the board. Forty slugs to teach one
 * key is how a prompt stops being read.
 *
 * WARNING, not error: the board renders perfectly, the seat simply runs on the
 * project default. Nothing is lost except the judgement the refiner made.
 */
export function checkCardModel(source: CardModelSource): DoctorFinding[] {
  const value = source.meta[CARD_MODEL_KEY]
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) {
    return [
      {
        check: 'card-model-invalid',
        severity: 'warning',
        subject: source.id,
        problem: `\`${CARD_MODEL_KEY}:\` holds a list where one slug belongs -- the hint is ignored and the seat runs on the project default`,
        remedy: `write it bare: \`${CARD_MODEL_KEY}: opus\``,
      },
    ]
  }
  if (readCardModel(value) !== undefined) return []
  return [
    {
      check: 'card-model-invalid',
      severity: 'warning',
      subject: source.id,
      problem: `\`${CARD_MODEL_KEY}: ${String(value)}\` is not a model CC accepts -- the hint is ignored and the seat runs on the project default`,
      remedy: `use a slug from the model registry, e.g. \`${CARD_MODEL_KEY}: opus\`, or delete the key`,
    },
  ]
}

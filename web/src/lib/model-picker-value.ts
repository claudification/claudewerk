/**
 * Map a model slug onto a value the model picker can actually select.
 *
 * A conversation's `model` is what CC reported at RUNTIME -- `claude-opus-4-8[1m]`,
 * `claude-haiku-4-5-20251001` -- while the picker's options are spawn-option ids.
 * Handing the Select a value that matches no option makes Radix render a BLANK
 * trigger, which is how the fork dialog ended up showing an empty Model field
 * while Effort next to it read "Default".
 *
 * Returns '' when nothing matches, which the picker shows as "Default" -- an
 * honest fallback, and never a blank control.
 */

import { DROPDOWN_MODEL_ENTRIES, resolveModelFamily } from '@shared/models'

const DROPDOWN_IDS: ReadonlySet<string> = new Set(DROPDOWN_MODEL_ENTRIES.map(m => m.id))

const IS_1M = /\[1m\]$/i

export function modelPickerValue(slug: string | undefined): string {
  if (!slug) return ''
  if (DROPDOWN_IDS.has(slug)) return slug

  // Not a picker id -- fall back to the family and take one of its accepted
  // slugs that the picker does offer.
  const accepted = resolveModelFamily(slug)?.acceptedSlugs ?? []
  const offered = accepted.filter(a => DROPDOWN_IDS.has(a))
  if (offered.length === 0) return ''

  // Preserve the 1M-context choice when the picker offers that variant; most
  // families only list the standard one, in which case any match is the best
  // available and dropping [1m] is the honest outcome.
  const want1m = IS_1M.test(slug)
  return offered.find(a => IS_1M.test(a) === want1m) ?? offered[0]
}

/**
 * THE BATON'S TAG SLOT -- fitting BOTH an epic id and a card id into the ONE
 * opaque token `md-section-log.ts` gives a header line.
 *
 * A project run has ONE baton carrying entries from every epic it serves, so an
 * entry that names only its card cannot be attributed: card ids are unique, but
 * "which epic asked for this" is the question the ledger and the digest are
 * built on, and the card id alone does not answer it.
 *
 * THE FORMAT DOES NOT CHANGE, AND THAT IS THE POINT. `md-section-log.ts` was
 * extracted because quest-log.ts and epic-log.ts had the same parser twice, and
 * its header says a divergence between them would be SILENT -- the reader skips
 * sections it no longer recognises, so a baton would appear to have FEWER
 * ENTRIES rather than fail. Widening its `HEADER` regex to a second token would
 * rewrite the parser under quest logs to buy something only epics need. So the
 * slot stays one token and the epic layer COMPOSES it: `epicId/cardId` on the
 * way out, split on the way back in. Quest logs never write a tag at all and are
 * untouched by any of this.
 *
 * Both directions are TOTAL functions. There is no shape of tag -- bare, empty,
 * slash-only, several slashes -- that throws or returns nothing, because the
 * inputs include 1.7 MB of batons already on disk written before this file
 * existed, every entry of them tagged with a bare card id.
 */

/** What a header's tag slot means, once the log's own epic is known. */
export interface BatonTag {
  /** The epic the entry belongs to. Never empty: falls back to the log's epic. */
  epicId: string
  /** The card the entry concerns, when it concerns one. */
  cardId?: string
}

const SEP = '/'

/**
 * Compose the on-disk token. `undefined` means "write no tag at all", which is
 * what an entry with neither an epic nor a card has always done.
 *
 * An entry that names an epic but no card still gets a token (`epicId/`), so its
 * attribution survives a project-scoped baton where the file no longer says
 * which epic it belongs to. That trailing separator is not decoration -- it is
 * the difference between an `intent` line the digest can bill to an epic and one
 * it cannot.
 */
export function composeBatonTag(epicId?: string, cardId?: string): string | undefined {
  if (!epicId) return cardId || undefined
  return cardId ? `${epicId}${SEP}${cardId}` : `${epicId}${SEP}`
}

/**
 * Split the on-disk token back into an epic and a card.
 *
 * `logEpicId` is what a missing or bare tag falls back to, and it is a FACT
 * rather than a guess: every reader already has to know which epic's log it
 * opened in order to open it (`readEpicLog` takes it as an argument). That is
 * what makes backward compatibility total rather than heuristic -- the five
 * batons on disk today are all bare tags in a per-epic file, and every one of
 * them parses to exactly the epic it is stored under.
 *
 * FIRST separator, not the last: an epic id is itself a board card id and so
 * never contains a `/`, while the remainder is treated as opaque. A tag with
 * several separators therefore keeps everything after the first as the card id
 * verbatim, which is the only reading that round-trips what `composeBatonTag`
 * would have written for such a card.
 */
export function parseBatonTag(tag: string | undefined, logEpicId: string): BatonTag {
  if (!tag) return { epicId: logEpicId }
  const cut = tag.indexOf(SEP)
  if (cut === -1) return { epicId: logEpicId, cardId: tag }
  const head = tag.slice(0, cut)
  const tail = tag.slice(cut + 1)
  return { epicId: head || logEpicId, ...(tail ? { cardId: tail } : {}) }
}

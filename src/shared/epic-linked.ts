/**
 * CARDS AN EPIC IS CONNECTED TO BUT DOES NOT OWN.
 *
 * Membership in an epic is the `epic:` frontmatter key on the child and nothing
 * else -- `buildEpicIndex` skips any card without it. That is correct and must
 * stay correct, because `planEpic` builds the run's DAG from the same rollup:
 * a card the epic does not OWN is a card the engine will never dispatch.
 *
 * Which makes the failure mode quiet and expensive. A card written with
 * `relates_to: [some-epic]` looks connected to a human reading the file, is
 * invisible in the epic view, and is never worked on. It happened twice on this
 * board while the werk-master window was being built.
 *
 * So: surface the connection WITHOUT inventing a second kind of membership. This
 * is a suggestion list -- "these look like they belong to you" -- and the only
 * way a card joins is still the one key, written deliberately.
 *
 * A pure fold over cards the caller already holds. No fs, no `node:` imports.
 */

import { type EpicRollup, epicBucket } from './epic-cards'
import type { ProjectTaskMeta } from './project-task-types'

/** How a card came to be linked. Direct beats family: a card naming the epic
 *  itself is a stronger signal than one naming a sibling. */
export type LinkKind = 'direct' | 'family'

export interface LinkedCard {
  card: ProjectTaskMeta
  kind: LinkKind
  /** Which card the link runs through. The epic id for `direct`, otherwise the
   *  child that connects them -- shown so a suggestion can be judged, not
   *  guessed at. */
  via: string
  /** The epic that already owns this card, if any. Present => adopting is a
   *  MOVE out of someone else's epic, and the UI must say so. */
  ownedBy?: string
}

/** Everything one card points at. `refs` is deliberately NOT included: it holds
 *  file paths and docs far more often than card ids, so folding it in would fill
 *  the list with noise and make the honest links harder to see. */
function outbound(card: ProjectTaskMeta): string[] {
  return [...(card.relatesTo ?? []), ...(card.dependsOn ?? [])]
}

/** Terminal cards are excluded wholesale. Nobody adopts a finished card, and
 *  including them would bury the live suggestions under the archive -- the same
 *  reasoning `splitUnparented` uses for the unparented pile. */
function isLive(card: ProjectTaskMeta): boolean {
  const bucket = epicBucket(card.status)
  return bucket !== 'done' && bucket !== 'dropped'
}

function record(found: Map<string, LinkedCard>, next: LinkedCard): void {
  const existing = found.get(next.card.slug)
  // Direct wins, and the first direct link wins over later ones -- re-recording
  // would make the `via` depend on card iteration order.
  if (existing && (existing.kind === 'direct' || next.kind === 'family')) return
  found.set(next.card.slug, next)
}

/**
 * Cards linked to this epic in either direction, that the epic does not own.
 *
 * Four ways to be linked, all of them symmetric on purpose -- which end of the
 * arrow somebody happened to write it from says nothing about whether the two
 * belong together:
 *   1. the card names the epic
 *   2. the epic's own card names the card
 *   3. the card names one of the epic's children
 *   4. one of the epic's children names the card
 */
export function linkedCards(rollup: EpicRollup, cards: readonly ProjectTaskMeta[]): LinkedCard[] {
  const owned = new Set(rollup.children.map(c => c.card.slug))
  const childIds = new Set(owned)
  const byId = new Map(cards.map(c => [c.slug, c]))
  const found = new Map<string, LinkedCard>()

  const consider = (card: ProjectTaskMeta | undefined, kind: LinkKind, via: string) => {
    // The epic's own card is not a suggestion about itself, and a card it
    // already owns is not a suggestion at all.
    if (!card || card.slug === rollup.epicId || owned.has(card.slug)) return
    if (!isLive(card)) return
    record(found, { card, kind, via, ...(card.epic ? { ownedBy: card.epic } : {}) })
  }

  // (2) and (4): outbound from the epic and from its children.
  for (const id of rollup.card ? outbound(rollup.card) : []) consider(byId.get(id), 'direct', rollup.epicId)
  for (const child of rollup.children) {
    for (const id of outbound(child.card)) consider(byId.get(id), 'family', child.card.slug)
  }

  // (1) and (3): inbound, from any card on the board.
  for (const card of cards) {
    for (const id of outbound(card)) {
      if (id === rollup.epicId) consider(card, 'direct', rollup.epicId)
      else if (childIds.has(id)) consider(card, 'family', id)
    }
  }

  return [...found.values()].sort(byLinkStrength)
}

/** Direct first, then unowned before owned (an adopt is cheaper than a move),
 *  then by slug so the list does not reorder between renders. */
function byLinkStrength(a: LinkedCard, b: LinkedCard): number {
  if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1
  if (Boolean(a.ownedBy) !== Boolean(b.ownedBy)) return a.ownedBy ? 1 : -1
  return a.card.slug.localeCompare(b.card.slug)
}

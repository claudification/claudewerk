/**
 * LINK ROT -- card links that no longer land anywhere.
 *
 * The board's own convention is `[card-id](.rclaude/project/cards/<id>.md)`, and
 * because a card's path is fixed for life those links are supposed to resolve
 * forever. They stop resolving for exactly two reasons: the target was deleted,
 * or the id was mistyped when the link was written. Both look identical in a
 * rendered card -- a link that does nothing -- so nobody notices either.
 *
 * Every historical path shape is accepted here (`cards/`, an old `<lane>/`, a
 * `views/` symlink), because `canonicalizeCardPath` resolves them all to the
 * same id. A link is rotten only if the ID does not exist.
 */

import { canonicalizeCardPath } from './card-path'
import type { DoctorFinding } from './project-doctor-types'

/** Any board-card path in prose: markdown link target, inline code, or bare. */
const CARD_PATH_IN_TEXT = /(?:\.\/)?(?:[\w.-]+\/)*\.rclaude\/project\/[\w./-]+\.md/g

export interface LinkSource {
  id: string
  body: string
  /** `refs:` frontmatter entries -- these hold card paths too, plus commits and docs. */
  refs: string[]
}

/** Every distinct card id referenced by one card's body and refs. */
export function referencedCardIds(source: LinkSource): string[] {
  const found = new Set<string>()
  for (const text of [source.body, ...source.refs]) {
    for (const match of text.matchAll(CARD_PATH_IN_TEXT)) {
      const ref = canonicalizeCardPath(match[0])
      if (ref) found.add(ref.id)
    }
  }
  return [...found]
}

/**
 * Rotten links, given the set of ids that actually exist. A card linking itself
 * is fine (an anchor into its own file), so it is never reported.
 */
export function checkLinks(source: LinkSource, existingIds: ReadonlySet<string>): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  for (const target of referencedCardIds(source)) {
    if (target === source.id || existingIds.has(target)) continue
    findings.push({
      check: 'link-rot',
      severity: 'warning',
      subject: source.id,
      problem: `links to card "${target}", which this board does not have`,
      remedy: `fix the id, point it at the card that replaced it, or drop the link`,
    })
  }
  return findings
}

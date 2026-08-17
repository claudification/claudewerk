/**
 * THE BOARD SCHEMA, SAID TO AN AGENT.
 *
 * The system prompt used to hand-restate the frontmatter as one frozen line --
 * "title, priority, tags, refs, created" -- written before `epic:` existed and
 * never touched again. On 2026-08-17 an agent built a ten-card epic out of that
 * line and got it structurally wrong in the only way the line allowed: it hung
 * a parent-side `blocks: [ten children]` list off the epic, because nothing had
 * ever told it that parenthood lives on the CHILD as `epic:`. Ten cards, no
 * `epic:` key between them, and an epic that rendered as an ordinary card.
 *
 * A hand-copied schema drifts the moment the real one moves. So this renders
 * from `buildCardKeys()` -- the same registry the store, the doctor and the
 * validator read. Add a key there and the prompt says it; deprecate one there
 * and the prompt warns about it. There is no second copy to forget.
 *
 * SCOPE: the ordered block plus the linkage verbs. The DONE-gate keys
 * (`gate`, `test_cmd`, every `evidence_*`) are deliberately absent -- they are
 * a separate feature with its own instructions, and most agents never touch
 * them. Listing forty keys to teach ten is how a prompt stops being read.
 *
 * Pure string work over a pure table. No fs, no `node:` imports.
 */

import { buildCardKeys } from './card-schema-keys'
import type { CardKeySpec } from './card-schema-types'
import { EPIC_TAG } from './epic-cards'

/** Enum values inline, so the agent never has to guess a lane or a priority. */
function valueHint(spec: CardKeySpec): string {
  if (spec.type === 'enum' && spec.values) return ` (one of: ${spec.values.map(v => `\`${v}\``).join(', ')})`
  if (spec.type === 'string[]') return ' (list)'
  return ''
}

function renderKey(spec: CardKeySpec): string {
  // An alias says nothing its stored form does not, so it gets ONE clause and no
  // repeat of the meaning -- otherwise `blocked_by` and `depends_on` read as two
  // different relations and an agent picks between them by coin-flip.
  if (spec.storedAs) return `- \`${spec.key}:\` -- alias for \`${spec.storedAs}:\`, normalised on write`
  const deprecated = spec.deprecated ? ` **DEPRECATED** -- ${spec.deprecated}` : ''
  return `- \`${spec.key}:\` -- ${spec.doc}${valueHint(spec)}${deprecated}`
}

/**
 * The frontmatter section of the board prompt, as prompt lines.
 *
 * Ordered keys come first in their canonical render order (that IS the order a
 * card is written in), then the linkage verbs the store does not reposition --
 * the aliases and the deprecated `blocks`, which an agent is most likely to
 * reach for by instinct and most needs to be corrected about.
 */
export function renderCardFrontmatterPrompt(): string[] {
  const keys = buildCardKeys().filter(k => k.ordered || k.linkage)
  return [
    'Frontmatter keys, in the order a card writes them:',
    ...keys.map(renderKey),
    '',
    'PARENTHOOD LIVES ON THE CHILD. To put a card in an epic, write `epic: <epic-card-id>`',
    'on THAT card. Never hand-maintain a list of children on the epic -- `blocks:` is computed',
    'as the inverse of `depends_on:` and a stored copy only goes stale.',
    `Tag the epic card itself \`tags: [..., ${EPIC_TAG}]\` so it renders as an epic before its children exist.`,
    '`depends_on:` is SEQUENCING and only sequencing -- it is not "my children".',
  ]
}

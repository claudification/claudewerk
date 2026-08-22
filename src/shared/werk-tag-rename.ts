/**
 * `needs-overseer` -> `needs-werk-master`, on the cards that carry it.
 *
 * THE TAG IS A STORED, HAND-APPLIED WORD, and it is the blocked channel: a seat
 * that cannot ask a human files a question card tagged with it, and
 * `epic-ready.ts` folds over the tag to put those questions in front of the
 * supervisor. Rename the constant and leave the board alone and every open
 * question silently stops being a question -- the epic proceeds as if nobody
 * had asked. So the rename needs the same treatment as the conversation rows:
 * rewrite what is stored, keep no alias.
 *
 * A LINE EDIT, NOT A RE-SERIALISE. The obvious implementation parses the card,
 * mutates `tags`, and writes the card back -- which rewrites every byte of a
 * file whose other keys this pass has no business touching, and puts a torn
 * write in the path of a card somebody is holding open. This rewrites the ONE
 * frontmatter line and copies the rest through unchanged.
 *
 * Pure, for `epic-migrate.ts`' reason: the decision is testable without a board
 * on disk, and `scripts/migrate-werk-tags.ts` is the only thing that writes.
 */

/** The word the engine used to fold over. Deliberately NOT exported: nothing
 *  may read it except the rewrite below, which is what stops it becoming an
 *  alias. */
const OLD_TAG = 'needs-overseer'

/** The word it becomes. Spelled out rather than imported from
 *  `epic-run-types.ts` so this module stays a leaf a script can load without
 *  dragging the epic engine's type graph in; the registry test pins that the
 *  two agree. */
const NEW_TAG = 'needs-werk-master'

/** Where the frontmatter block ends -- the second `---`, or -1 if the file has
 *  no complete block (in which case there is nothing here to rename). */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i
  }
  return -1
}

/**
 * The card's text with the tag renamed, or `null` if it does not carry it.
 *
 * `null` rather than the unchanged string so a caller cannot rewrite a file it
 * did not change -- an mtime bump on every card on the board is what makes the
 * nightly sweep think the whole board moved.
 *
 * ONLY INSIDE THE FRONTMATTER. The same word appears in card BODIES, quoted,
 * as prose about the mechanism ("raise a `needs-overseer` question") -- and on
 * a card written before the rename that sentence is a historical statement
 * about what the code did then. Rewriting body prose would be editing somebody
 * else's argument to make a grep come out clean.
 */
export function renameNeedsOverseerTag(text: string): string | null {
  const lines = text.split('\n')
  const end = frontmatterEnd(lines)
  if (end < 0) return null

  let changed = false
  for (let i = 1; i < end; i++) {
    if (!/^tags\s*:/.test(lines[i])) continue
    // Word-bounded: `needs-overseer-later` is somebody else's tag, not this one.
    const next = lines[i].replace(new RegExp(`(?<![\\w-])${OLD_TAG}(?![\\w-])`, 'g'), NEW_TAG)
    if (next !== lines[i]) {
      lines[i] = next
      changed = true
    }
  }
  return changed ? lines.join('\n') : null
}

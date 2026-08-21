/**
 * Validate a board card THE MOMENT AN AGENT WRITES IT.
 *
 * `board:doctor` finds rot after the fact, which means somebody has to remember
 * to run it. Agents write these cards constantly and a mistyped `status:` or a
 * link to a card id that does not exist looks completely fine at write time --
 * the board just silently renders the card in `inbox`, or the link quietly does
 * nothing when clicked. Both were real bugs before they were checks.
 *
 * So the same checks run on the PostToolUse edge and hand the findings straight
 * back to the agent that just wrote the file, while it still has the context to
 * fix them. Nothing is blocked and nothing is rewritten: the write already
 * happened, this is feedback.
 *
 * Pure -- the filesystem arrives through `readFile` / `listIds` so the whole
 * thing is testable without a hook, a board, or a process.
 */

import { parseCardFrontmatter } from './card-frontmatter'
import { CARDS_DIR, canonicalizeCardPath } from './card-path'
import { checkCard } from './project-doctor-cards'
import { checkLifecycleKeys, duplicateTargetOf } from './project-doctor-lifecycle'
import { checkLinkageKeys } from './project-doctor-linkage'
import { checkLinks } from './project-doctor-links'
import type { DoctorFinding } from './project-doctor-types'

/** Tools whose payload means "a file now has different bytes". */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Where `.rclaude/project/` sits inside a path, splitting root from board. */
const BOARD_SPLIT = /^(.*)\/\.rclaude\/project\/(.+)$/

export interface CardWriteTarget {
  /** Project root -- everything left of `/.rclaude/project/`. */
  root: string
  /** The card id this write landed on. */
  id: string
  /** True when the file was written where cards actually live. */
  canonical: boolean
}

/**
 * The board card a tool call just wrote, or null when the call had nothing to
 * do with one. A non-write tool, a non-card path and a malformed payload all
 * return null -- a hook that guesses is worse than a hook that stays quiet.
 */
export function cardWriteTarget(toolName: string, filePath: string): CardWriteTarget | null {
  if (!WRITE_TOOLS.has(toolName) || !filePath) return null
  const split = BOARD_SPLIT.exec(filePath)
  if (!split) return null
  const ref = canonicalizeCardPath(filePath)
  if (!ref) return null
  return { root: split[1], id: ref.id, canonical: split[2] === `${CARDS_DIR}/${ref.id}.md` }
}

export interface CardWriteChecks {
  /** Card contents as just written; null if it could not be read back. Also the
   *  reader for OTHER cards on the board: `duplicate-of:` is a pointer, and a
   *  chain of them can only be walked by reading each card it passes through. */
  readFile: (root: string, id: string) => string | null
  /** Every card id on that board -- for spotting links that land nowhere. */
  listIds: (root: string) => string[]
  /** Wall clock at write time. Injected rather than read from `Date.now()` so
   *  "is this `delete_at` in the future" is testable without freezing time. */
  now?: () => number
}

/**
 * The board as the lifecycle pass needs to see it, built from the same two
 * readers everything else here uses. `duplicateTarget` re-reads a card per step
 * of a chain, which is at most a handful of small files on a write that carries
 * a `duplicate-of:` -- and zero on every other write, because nothing calls it.
 */
function lifecycleBoard(target: CardWriteTarget, io: CardWriteChecks, ids: ReadonlySet<string>) {
  return {
    has: (id: string) => ids.has(id),
    duplicateTarget: (id: string) => {
      const content = io.readFile(target.root, id)
      if (content === null) return null
      const reason = parseCardFrontmatter(content).meta.archived_reason
      return duplicateTargetOf(reason) || null
    },
    writtenAt: (io.now ?? Date.now)(),
  }
}

/**
 * Check one freshly-written card. Info-level findings are dropped: an agent
 * mid-task does not need to hear about an empty body it is about to fill in,
 * and a hook that cries wolf gets ignored (or switched off) within a day.
 */
export function checkWrittenCard(target: CardWriteTarget, io: CardWriteChecks): DoctorFinding[] {
  const content = io.readFile(target.root, target.id)
  const findings: DoctorFinding[] = []

  if (!target.canonical) {
    findings.push({
      check: 'card-written-outside-cards',
      severity: 'warning',
      subject: target.id,
      problem: `written somewhere other than ${CARDS_DIR}/${target.id}.md -- lane folders are read-only legacy`,
      remedy: `write the card at .rclaude/project/${CARDS_DIR}/${target.id}.md; its lane is the \`status:\` key`,
    })
  }

  findings.push(...checkCard({ id: target.id, content }))
  if (content !== null) {
    const { meta, body } = parseCardFrontmatter(content)
    const refs = Array.isArray(meta.refs) ? meta.refs.map(String) : []
    const ids = new Set(io.listIds(target.root))
    // A mistyped linkage verb is the one thing on a card that is completely
    // invisible afterwards -- it parses, it persists, and nothing reads it. This
    // is the only moment somebody is still looking at the key they just typed.
    findings.push(...checkLinkageKeys({ id: target.id, meta }))
    findings.push(...checkLinks({ id: target.id, body, refs }, ids))
    // THE ONE MOMENT the lifecycle keys can be checked against the clock: "in
    // the future" is a fact about when the value was written, and this is the
    // write. See project-doctor-lifecycle.ts.
    findings.push(...checkLifecycleKeys({ id: target.id, meta }, lifecycleBoard(target, io, ids)))
  }

  return findings.filter(f => f.severity !== 'info')
}

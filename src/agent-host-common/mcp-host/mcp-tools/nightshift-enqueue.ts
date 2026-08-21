/**
 * `nightshift action=enqueue` -- ASSIGNING WORK TO TONIGHT'S RUN.
 *
 * It used to POST `op: 'enqueue'` and land a file in `.nightshift/queue/`.
 * Nothing reads that directory any more: the night run's input is the
 * `#nightshift` tag on a board card. So the old door answered `{ ok: true }` for
 * work that could never run -- a success nobody investigates, which is worse
 * than an error.
 *
 * The VERB is unchanged ("this goes on tonight's list"); where it writes is not.
 * An enqueue now either TAGS the card it names (`board_ref`) or files a new one
 * carrying the tag. Either way the card IS the item -- the same object the run
 * reads at dispatch time. No copy, no second store, nothing to drift.
 *
 * The board is plain files under the project root, reached through the same
 * `project-store` seam `project_list` and `project_set_status` use. It is NOT
 * relayed to the sentinel, so unlike every other nightshift action this one
 * never leaves the host.
 */

import { existsSync, statSync } from 'node:fs'
import { NIGHTSHIFT_TAG } from '../../../shared/nightshift-types'
import { cardRelPath, createProjectTask, getProjectTask, updateProjectTask } from '../../../shared/project-store'
import { tryParseProjectUri } from '../../../shared/project-uri'
import { debug } from '../debug'
import type { McpToolContext, ToolResult } from './types'

type Params = Record<string, string>

const okResult = (payload: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
})
const failResult = (message: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
})

/** What the caller gets told about where the work now lives. */
const NOTE =
  `filed on the project board -- the night run selects cards tagged #${NIGHTSHIFT_TAG}, ` +
  'so this card IS the queue item. Untag it to cancel; the run untags it when it dispatches.'

/** One successful write, in the shape the JSON result carries. */
interface EnqueueWrite {
  /** Project-relative card path, e.g. `.rclaude/project/cards/foo.md`. */
  card: string
  /** Card id -- the board's primary key. */
  id: string
  /** True when a new card was filed, false when an existing one was tagged. */
  created: boolean
  /** True when the card already carried the tag and nothing changed. */
  alreadyTagged: boolean
}

type WriteOutcome = EnqueueWrite | { error: string }

/**
 * The project root whose board this enqueue writes to.
 *
 * `project` is required and names the project ON THE WIRE, so it -- not the
 * calling conversation's cwd -- decides which board gets the card. An agent that
 * names project B must never silently file into project A.
 *
 * The board is files, so that root has to exist on THIS host. A project owned by
 * another sentinel is refused out loud instead of half-written, because a
 * plausible-looking success is the exact failure this module was written to end.
 */
function resolveBoardRoot(projectUri: string): { root: string } | { error: string } {
  const root = projectRootFromUri(projectUri)
  if (!root) return { error: `cannot resolve a project root from ${JSON.stringify(projectUri)}` }
  if (!isDirectory(root))
    return {
      error:
        `project root ${root} is not a directory on this host. The nightshift list is the #${NIGHTSHIFT_TAG} tag ` +
        'on a board card, and a board is files -- so a card can only be filed for a project this host can see. ' +
        'Run the enqueue from a conversation in that project.',
    }
  return { root }
}

/** The absolute host path a project URI names -- `''` when it names none. A
 *  wildcard URI is no project in particular, so it is no root either. */
function projectRootFromUri(projectUri: string): string {
  const path = tryParseProjectUri(projectUri)?.path ?? projectUri
  if (path === '/' || path === '*') return ''
  return path.startsWith('/') ? path : ''
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The card body: the description, plus the queue-item fields that have no
 * frontmatter home, written as prose. A board card has no `acceptance`, `risk`
 * or `feasibility` key and inventing three is a decision for whoever revives the
 * run engine -- so nothing the caller typed is dropped, and no schema is coined.
 *
 * Deliberately the same shape the Assign dialog writes, so a hand-typed task and
 * an agent-filed one read alike on the board.
 */
function buildEnqueueCardBody(p: Params): string {
  const qualifiers = [p.risk && `risk: ${p.risk}`, p.feasibility && `feasibility: ${p.feasibility}`].filter(Boolean)
  return [
    (p.description || '').trim(),
    (p.acceptance || '').trim() && `## Acceptance\n${p.acceptance.trim()}`,
    qualifiers.length > 0 && `_${qualifiers.join(' -- ')}_`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * `board_ref` names a card that already exists: put the tag ON it.
 *
 * Re-reads the card's tags rather than assuming, and appending is idempotent --
 * enqueueing the same card twice is a no-op, not a second entry, which is the
 * whole reason the tag beats a queue file.
 */
function tagExistingCard(root: string, id: string): WriteOutcome {
  const card = getProjectTask(root, id)
  if (!card)
    return {
      error:
        `board_ref "${id}" is not a card on this board. Filing a NEW card under a different id would recreate ` +
        'exactly the drifting copy the tag exists to kill, so nothing was written. Fix the id, or drop ' +
        'board_ref to file a new card.',
    }
  if (card.tags.includes(NIGHTSHIFT_TAG)) return { card: cardRelPath(id), id, created: false, alreadyTagged: true }
  if (!updateProjectTask(root, id, { tags: [...card.tags, NIGHTSHIFT_TAG] }))
    return { error: `failed to tag card "${id}"` }
  return { card: cardRelPath(id), id, created: false, alreadyTagged: false }
}

/** No `board_ref`: the task has no card yet, so it becomes one. */
function fileNewCard(root: string, p: Params): WriteOutcome {
  const meta = createProjectTask(
    root,
    { title: p.title.trim(), body: buildEnqueueCardBody(p), tags: [NIGHTSHIFT_TAG] },
    Date.now(),
  )
  return { card: cardRelPath(meta.slug), id: meta.slug, created: true, alreadyTagged: false }
}

/** Handle `action=enqueue`. Synchronous: it is a local file write, not an RPC. */
export function handleNightshiftEnqueue(ctx: McpToolContext, p: Params): ToolResult {
  if (!p.project) return failResult('project (URI) is required')
  if (!p.title) return failResult('title is required for enqueue')
  const ref = (p.board_ref || '').trim()
  // `source=board` asserts the task came from a card. Without the id that is an
  // assertion nothing can act on, and filing a fresh card would silently make a
  // duplicate of the card the caller meant.
  if (!ref && p.source === 'board')
    return failResult('source=board needs board_ref -- say WHICH card, or use source=manual to file a new one')

  const resolved = resolveBoardRoot(p.project)
  if ('error' in resolved) return failResult(resolved.error)

  const write = ref ? tagExistingCard(resolved.root, ref) : fileNewCard(resolved.root, p)
  if ('error' in write) return failResult(write.error)

  ctx.callbacks.onProjectChanged?.()
  debug(`[channel] nightshift enqueue -> ${write.card} (${write.created ? 'created' : 'tagged'})`)
  return okResult({ ok: true, action: 'enqueue', ...write, tag: NIGHTSHIFT_TAG, note: NOTE })
}

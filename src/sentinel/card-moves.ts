/**
 * Lane transitions, derived at the source.
 *
 * The board watcher already computes a manifest diff to decide whether to push
 * `project_changed`. That diff knows a card's OLD status and its NEW one, which
 * is exactly a ledger line -- but the diff throws the pair away and the panel
 * only ever learns "something changed". This module keeps the pair.
 *
 * Two rules live here and nowhere else:
 *
 *   1. A move is a STATUS change. A card whose body was edited, or whose mtime
 *      merely bumped, is not a move -- otherwise the ledger fills with noise the
 *      moment anyone types in a card.
 *   2. EPIC CARDS ARE DROPPED. An epic is a container; its lane is a rollup of
 *      its children and reads as a move that nobody made. Excluding it here
 *      means no consumer has to know the rule (Done means: "excluded at the
 *      source, not filtered in the UI").
 *
 * Pure: a fold over two snapshots the caller already holds. No fs, no wire.
 */

import { isEpicCard } from '../shared/epic-cards'
import type { ProjectTaskManifestEntry, ProjectTaskMeta } from '../shared/project-task-types'
import type { CardMove } from '../shared/protocol'

/** Children per epic id -- the second half of `isEpicCard`'s question. A card
 *  with no `epic:` tag is still an epic if anything claims it as a parent. */
function childCounts(notes: ProjectTaskMeta[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    if (!note.epic) continue
    counts.set(note.epic, (counts.get(note.epic) ?? 0) + 1)
  }
  return counts
}

/**
 * One `CardMove` per card whose lane actually changed between `prev` and `next`.
 *
 * `notes` is the full board snapshot the watcher already fetched -- it supplies
 * the title, priority and epic membership the manifest does not carry. A card in
 * the manifest but missing from `notes` is a read race (deleted between the two
 * scans) and is skipped rather than emitted with invented metadata.
 *
 * Additions and deletions are NOT moves: neither has a `from` lane, and a wire
 * shape whose `from` is sometimes absent stops being a ledger line.
 */
export function deriveCardMoves(
  prev: Map<string, ProjectTaskManifestEntry>,
  next: ProjectTaskManifestEntry[],
  notes: ProjectTaskMeta[],
  project: string,
  now: number,
): CardMove[] {
  const byId = new Map(notes.map(n => [n.slug, n]))
  const counts = childCounts(notes)
  const moves: CardMove[] = []

  for (const entry of next) {
    const prior = prev.get(entry.slug)
    if (!prior || prior.status === entry.status) continue
    const note = byId.get(entry.slug)
    if (!note) continue
    if (isEpicCard(note, counts.get(entry.slug) ?? 0)) continue
    moves.push({
      id: entry.slug,
      project,
      title: note.title,
      from: prior.status,
      to: entry.status,
      priority: note.priority,
      epic: note.epic,
      ts: now,
    })
  }

  return moves
}

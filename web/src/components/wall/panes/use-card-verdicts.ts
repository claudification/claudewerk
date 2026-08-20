/**
 * P3's promise data: a verdict per card, and the LOUD list, for exactly the
 * projects the pane is currently showing.
 *
 * FETCHED ON DEMAND, NOT RIDDEN IN ON THE FRAME. P3's registry entry declares
 * `feeds: []` and it stays that way. A verdict is a question about git -- a
 * directory scan plus a `merge-base` per sha -- and putting that on the wall
 * frame would make every connected panel pay for it on every tick, for a pill
 * that changes when a commit lands. The pane asks for the projects it has rows
 * for and nothing else, so a wall showing one project costs one ask.
 *
 * A CARD WITH NO ROW IS `not-started`, and that is a fact rather than a
 * fallback: the fold emits a row for every card that carries a `promise:` block
 * and every card filed as finished, so a card it did not mention is one nobody
 * has claimed to have built. What is NOT a fact is the same silence while the
 * project has never answered -- that is `unverifiable`, and the two are kept
 * apart here rather than collapsed into a convenient default.
 */

import type { PromiseRow, PromiseVerdict } from '@shared/promise-ledger'
import { useMemo } from 'react'
import { usePromiseLedger } from '@/hooks/use-promise-ledger'
import type { LedgerRow } from '@/lib/wall/card-ledger'

export interface CardVerdicts {
  /** The verdict for one card on one project. */
  verdictFor(project: string, id: string): PromiseVerdict
  /** Filed as finished with nothing standing behind it, worst first. Carries the
   *  project so a row stays an address you can click. */
  broken: (PromiseRow & { project: string })[]
  /** No project has answered yet -- "not asked", which is not "clean". */
  loading: boolean
  /** A sentinel refused. An empty loud table plus this means "we cannot tell". */
  refused: string | null
}

export function useCardVerdicts(rows: readonly LedgerRow[]): CardVerdicts {
  // The projects with rows ON SCREEN. Recomputed from the rows themselves so a
  // filter that empties the pane also stops the asks.
  const projects = useMemo(() => [...new Set(rows.map(row => row.project))], [rows])
  const { byProject, loading, refused } = usePromiseLedger(projects)

  return useMemo(() => {
    const verdicts = new Map<string, PromiseVerdict>()
    const answered = new Set<string>()
    const broken: (PromiseRow & { project: string })[] = []

    for (const [project, entry] of byProject) {
      if (!entry.ledger) continue
      answered.add(project)
      for (const row of entry.ledger.rows) {
        verdicts.set(`${project}::${row.id}`, row.verdict)
        // The fold already ordered its rows worst-first and already knows which
        // lanes count as filed; re-deriving "done" here would be a second answer.
        if (isFiled(row.status) && row.verdict !== 'delivered') broken.push({ ...row, project })
      }
    }

    return {
      verdictFor: (project, id) =>
        verdicts.get(`${project}::${id}`) ?? (answered.has(project) ? 'not-started' : 'unverifiable'),
      broken,
      loading,
      refused,
    }
  }, [byProject, loading, refused])
}

/** DONE or ARCHIVED -- the two lanes that assert the work is finished. Matches
 *  `closedWithoutCommit` in the core module; kept to one line here so the wall
 *  never grows a second opinion about what "filed" means. */
function isFiled(status: string): boolean {
  return status === 'done' || status === 'archived'
}

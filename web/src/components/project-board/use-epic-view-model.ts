/**
 * Everything the EPICS view DERIVES from the card list.
 *
 * Split out of `epics-view.tsx` because that component had grown to hold four
 * pieces of state, three memos and the whole two-pane layout, and the arithmetic
 * is the half you actually want to read on its own. The view is now layout plus
 * two dialogs.
 *
 * Every field is a pure function of (tasks, sort, showComplete, selected). No
 * I/O -- the board already holds the cards in memory.
 */

import { buildEpicIndex, type EpicRollup, splitUnparented, type UnparentedSplit } from '@shared/epic-cards'
import { type LinkedCard, linkedCards } from '@shared/epic-linked'
import { useMemo } from 'react'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { sortEpics } from './epic-sorts'
import type { EpicSort } from './epics-toolbar'

export interface EpicViewModel {
  rollups: EpicRollup[]
  loose: UnparentedSplit
  /** Sorted and filtered, split by whether the epic has any children yet. */
  withWork: EpicRollup[]
  empty: EpicRollup[]
  current: EpicRollup | undefined
  /** Cards linked to the SELECTED epic that it does not own. */
  links: LinkedCard[]
}

/**
 * MEMOISED IN THREE STAGES, keyed on what each one actually depends on.
 *
 * Not decoration. Extracting this hook from the view initially dropped the
 * memos the view had, and every one of these folds then re-ran on every render
 * -- `buildEpicIndex` and `splitUnparented` walk the whole board. It slowed the
 * board enough to time out a 5s test that had always passed. Same lesson as the
 * grouping cache: a fold over every card is not free just because it is pure.
 *
 * The stages are separate because their inputs are: the index only changes when
 * the cards do, the ordering also on sort/filter, and the links also on which
 * epic is selected. One combined memo would recompute the board index every
 * time somebody clicked a different epic.
 */
export function useEpicViewModel(
  tasks: ProjectTaskMeta[],
  sort: EpicSort,
  showComplete: boolean,
  selected: string | null,
): EpicViewModel {
  const { rollups, loose } = useMemo(() => {
    const index = buildEpicIndex(tasks)
    return { rollups: [...index.values()], loose: splitUnparented(tasks, index) }
  }, [tasks])

  const { withWork, empty } = useMemo(() => {
    const visible = sortEpics(showComplete ? rollups : rollups.filter(r => !r.complete), sort)
    return {
      withWork: visible.filter(r => r.children.length > 0),
      empty: visible.filter(r => r.children.length === 0),
    }
  }, [rollups, sort, showComplete])

  const current = rollups.find(r => r.epicId === selected)

  // Only the SELECTED epic's links. The fold is cheap but O(cards) per epic,
  // and a board with forty epics would run it forty times to render one pane.
  const links = useMemo(() => (current ? linkedCards(current, tasks) : []), [current, tasks])

  return { rollups, loose, withWork, empty, current, links }
}

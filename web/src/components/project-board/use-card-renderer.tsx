/**
 * ONE card, wired to the board's handlers.
 *
 * The lane columns and the archive drawer both draw cards, and they must not
 * drift apart -- so they take the same renderer rather than each spelling out a
 * `<ProjectCard>` of their own. It lives outside the board component because a
 * factory that returns a component that closes over four handlers is the single
 * densest thing the orchestrator held, and it is not orchestration.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { useMemo } from 'react'
import type { BoardViewConfig } from '@/hooks/use-board-view-config'
import type { ProjectTaskMeta, TaskStatus } from '@/hooks/use-project'
import { ProjectCard } from './project-card'

interface CardHandlers {
  move: (id: string, to: TaskStatus) => Promise<void>
  remove: (id: string) => Promise<void>
  archive: (id: string) => Promise<void>
  openCardBySlug: (slug: string) => Promise<void>
}

export type CardRenderer = (task: ProjectTaskMeta) => React.ReactNode

export function useCardRenderer(
  view: BoardViewConfig,
  epicIndex: Map<string, EpicRollup>,
  handlers: CardHandlers,
): CardRenderer {
  return useMemo(
    () => (task: ProjectTaskMeta) => (
      <ProjectCard
        key={task.slug}
        task={task}
        view={view}
        epicIndex={epicIndex}
        onMove={handlers.move}
        onDelete={handlers.remove}
        onArchive={handlers.archive}
        onEdit={meta => void handlers.openCardBySlug(meta.slug)}
        onOpenSlug={slug => void handlers.openCardBySlug(slug)}
      />
    ),
    [view, epicIndex, handlers],
  )
}

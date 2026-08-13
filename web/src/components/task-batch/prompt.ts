/**
 * The markdown a batch of selected cards is turned into, for the "Work" /
 * "Refine" / "Analyze" templates and for the clipboard.
 *
 * Extracted from task-batch-selector.tsx so the path emission is testable. It
 * had drifted to `.rclaude/project/<status>/<id>.md` -- the pre-migration lane
 * layout, deleted 2026-08-13 -- so every prompt handed the agent a file that
 * does not exist. `cardRelPath` is the one definition of a card's location and
 * the only thing allowed to build one.
 */

import { cardRelPath } from '@shared/card-path'
import type { ProjectTaskMeta } from '@/hooks/use-project'

/** One card as a prompt bullet: title, priority, and a path that resolves. */
export function taskPromptLine(task: ProjectTaskMeta): string {
  const prio = task.priority ? ` (${task.priority})` : ''
  return `- **${task.title}**${prio}\n  ${cardRelPath(task.slug)}`
}

export function buildBatchPrompt(instructions: string, tasks: ProjectTaskMeta[]): string {
  return `${instructions}\n\nTasks:\n${tasks.map(taskPromptLine).join('\n')}`
}

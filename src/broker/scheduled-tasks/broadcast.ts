/**
 * Pushing schedule state to the control panel.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE: a schedule that changes, fires, or disarms
 * itself emits a typed wire message, so the sidebar badge and the modal update
 * live instead of discovering it on the next refresh. No polling (WS over HTTP).
 *
 * Schedules are visible to anyone who may see the panel -- unlike launch profiles
 * these are not per-user, they belong to the project.
 */

import type { ServerWebSocket } from 'bun'
import type { ScheduledRun } from '../../shared/scheduled-run'
import type { ScheduledTask } from '../../shared/scheduled-task'

function sendAll(subscribers: Iterable<ServerWebSocket<unknown>>, payload: unknown): void {
  const json = JSON.stringify(payload)
  for (const ws of subscribers) {
    try {
      ws.send(json)
    } catch {
      /* dead socket -- the registry reaps it */
    }
  }
}

/** The full list, after any create / edit / delete / disarm. */
export function broadcastScheduledTasks(
  subscribers: Iterable<ServerWebSocket<unknown>>,
  scheduledTasks: ScheduledTask[],
): void {
  sendAll(subscribers, { type: 'scheduled_tasks_updated', scheduledTasks })
}

/** One firing, so an open history view appends without refetching. */
export function broadcastScheduledRun(
  subscribers: Iterable<ServerWebSocket<unknown>>,
  scheduleId: string,
  run: ScheduledRun | null,
): void {
  sendAll(subscribers, { type: 'scheduled_task_run', scheduleId, run })
}

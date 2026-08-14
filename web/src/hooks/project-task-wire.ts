/**
 * Board wire plumbing: request/response correlation over the conversation
 * WebSocket, plus the single shared handler the broker's project messages land
 * in. Split out of `use-project-tasks.ts` so the cache above it is pure state
 * and this stays pure transport.
 *
 *   project_board_request { op, project, requestId } -> project_board_result
 *   project_file_request  { project, relPath }       -> project_file_result
 *   project_changed       { project, diff, notes }   live push (no requestId)
 */

import type { ProjectTaskRef as TaskRef } from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { createWsRequestChannel } from '@/lib/ws-request'
import { useConversationsStore } from './use-conversations'

const channel = createWsRequestChannel('project')

/** Board op params (subset of the wire envelope the dashboard is allowed to set). */
export interface BoardOpParams {
  status?: TaskStatus
  slug?: string
  filterStatus?: TaskStatus
  refs?: TaskRef[]
  input?: { title?: string; body: string; priority?: 'low' | 'medium' | 'high'; tags?: string[] }
  patch?: { title?: string; body?: string; priority?: 'low' | 'medium' | 'high'; tags?: string[] }
  fromStatus?: TaskStatus
  toStatus?: TaskStatus
}

export type BoardOp = 'list' | 'manifest' | 'get' | 'getBatch' | 'create' | 'update' | 'move' | 'delete'

/** Send a board op for a project and resolve on the matching result. */
export function sendBoardOp(
  projectUri: string,
  op: BoardOp,
  params: BoardOpParams = {},
): Promise<Record<string, unknown>> {
  return channel.send({ type: 'project_board_request', project: projectUri, op, ...params })
}

/** Read a project-relative file through the sentinel (markdown viewer). */
export async function readProjectFile(
  projectUri: string,
  relPath: string,
  maxBytes?: number,
): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }> {
  const resp = await channel.send({ type: 'project_file_request', project: projectUri, relPath, maxBytes })
  return {
    ok: !!resp.ok,
    content: resp.content as string | undefined,
    truncated: resp.truncated as boolean | undefined,
    error: resp.error as string | undefined,
  }
}

export function sendProjectMessage(payload: Record<string, unknown>): void {
  useConversationsStore.getState().sendWsMessage(payload)
}

let handlerInstalled = false

/** Install the one shared project handler. `onChanged` gets live sentinel pushes. */
export function installProjectHandler(onChanged: (msg: Record<string, unknown>) => void): void {
  if (handlerInstalled) return
  handlerInstalled = true
  useConversationsStore.setState({
    projectHandler: (msg: Record<string, unknown>) => {
      if (msg.type === 'project_changed') onChanged(msg)
      else channel.settle(msg)
    },
  })
}

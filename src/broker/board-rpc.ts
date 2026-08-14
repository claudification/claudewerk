/**
 * Promise-shaped board RPC: broker -> sentinel -> board files.
 *
 * `handlers/project.ts` already relays board ops for the DASHBOARD, but that
 * path is socket-shaped: it writes its reply back onto the requesting
 * WebSocket. The MCP tools have no socket to reply on -- they need a value.
 *
 * WHY THIS EXISTS: `project_list` / `project_set_status` were still reading a
 * `project:tasks` KV blob that nothing has written since the board moved to
 * files (`.rclaude/project/cards/*.md`). The tools therefore reported an empty
 * board forever -- 385 real cards invisible -- and `project_set_status` mutated
 * a value no reader consults. No deploy could have fixed that; the data source
 * was simply dead. This module gives those tools the same sentinel-backed
 * source the panel uses, so there is ONE board of record.
 */

import { parseProjectUri } from '../shared/project-uri'
import type { ProjectBoardOp } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'

/** Matches the dashboard relay's budget -- the sentinel is doing the same work. */
const BOARD_RPC_TIMEOUT_MS = 10_000

export interface BoardRpcResult {
  ok: boolean
  error?: string
  tasks?: unknown[]
  task?: unknown
  slug?: string | null
  [key: string]: unknown
}

let requestSeq = 0
function nextRequestId(): string {
  requestSeq += 1
  return `mcp-board-${requestSeq}-${Math.floor(performance.now())}`
}

/**
 * Run one board op against the sentinel that owns `project` (a `claude://` URI).
 *
 * Never rejects: a missing sentinel, a send failure and a timeout all resolve to
 * `{ ok: false, error }` so a tool can report the reason instead of throwing an
 * opaque MCP error at the caller.
 */
export function callBoard(
  conversations: ConversationStore,
  project: string,
  op: Omit<ProjectBoardOp, 'type' | 'requestId' | 'projectRoot'>,
): Promise<BoardRpcResult> {
  const parsed = parseProjectUri(project)
  const sentinel =
    (parsed.authority ? conversations.getSentinelByAlias(parsed.authority) : undefined) ?? conversations.getSentinel?.()
  if (!sentinel) return Promise.resolve({ ok: false, error: 'no sentinel connected for this project' })

  const requestId = nextRequestId()
  const message: ProjectBoardOp = {
    ...op,
    type: 'project_board_op',
    requestId,
    // The sentinel owns URI <-> path; the broker passes the parsed path through
    // opaquely and never reasons about it (CWD IS INFORMATIONAL).
    projectRoot: parsed.path,
  } as ProjectBoardOp

  return new Promise<BoardRpcResult>(resolve => {
    let settled = false
    const finish = (result: BoardRpcResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conversations.removeProjectListener(requestId)
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ ok: false, error: `sentinel timed out (${BOARD_RPC_TIMEOUT_MS / 1000}s)` }),
      BOARD_RPC_TIMEOUT_MS,
    )

    conversations.addProjectListener(requestId, result => finish(result as BoardRpcResult))

    try {
      sentinel.send(JSON.stringify(message))
    } catch {
      finish({ ok: false, error: 'sentinel send failed' })
    }
  })
}

/**
 * The project URI an MCP call should act on: the caller conversation's own
 * project. An MCP tool has no project argument -- the board it means is the one
 * for the repo it is running in.
 */
export function callerProject(conversations: ConversationStore, callerConversationId?: string | null): string | null {
  if (!callerConversationId) return null
  return conversations.getConversation(callerConversationId)?.project ?? null
}

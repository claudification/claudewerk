/**
 * BROKER-INITIATED SENTINEL RPC -- the shape `nightshift-broker-rpc.ts` proved,
 * generalised so the epic engine is not a second copy of it.
 *
 * Distinct from `handlers/project-op-relay.ts`, and the difference matters: that
 * one answers a CLIENT (a dashboard socket is waiting, and the reply goes back
 * down it). This one has no client at all -- the broker itself wants an answer,
 * so the result resolves a Promise. Same resolve-target + listener + timeout,
 * different destination.
 *
 * Boundary: `parsed.path` is passed THROUGH to the sentinel as opaque data. The
 * broker derives nothing from it (CWD IS INFORMATIONAL).
 */

import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { parseProjectUri } from '../shared/project-uri'

const RPC_TIMEOUT_MS = 10_000

/**
 * Minimal sentinel-RPC surface. `ConversationStore` and the watchdog's deps both
 * satisfy it structurally, which is why every broker-internal caller can share
 * one implementation instead of cloning it per substrate.
 */
export interface SentinelRpcDeps {
  getSentinel: () => ServerWebSocket<unknown> | undefined
  getSentinelByAlias: (alias: string) => ServerWebSocket<unknown> | undefined
  addProjectListener: (requestId: string, cb: (result: unknown) => void) => void
  removeProjectListener: (requestId: string) => void
}

export interface SentinelRpcSpec<Result> {
  /** Wire type sent to the sentinel, e.g. `epic_op`. */
  opType: string
  /** requestId prefix, so a stuck request is attributable in a log. */
  idPrefix: string
  /** Build the failure result for this substrate's own result shape. */
  fail: (requestId: string, error: string) => Result
}

/**
 * One request, one answer, never a hang: every failure path (no sentinel, send
 * threw, sentinel silent) resolves rather than rejecting, because the callers
 * are sweep loops and an unhandled rejection there kills the whole timer.
 */
export function sendSentinelOp<Result>(
  spec: SentinelRpcSpec<Result>,
  deps: SentinelRpcDeps,
  project: string,
  op: object,
): Promise<Result> {
  const parsed = parseProjectUri(project)
  const sentinel = (parsed.authority ? deps.getSentinelByAlias(parsed.authority) : undefined) ?? deps.getSentinel()
  const requestId = `${spec.idPrefix}-${randomUUID()}`

  return new Promise<Result>(resolve => {
    if (!sentinel) {
      resolve(spec.fail(requestId, 'no sentinel connected for project'))
      return
    }
    const timeout = setTimeout(() => {
      deps.removeProjectListener(requestId)
      resolve(spec.fail(requestId, 'sentinel timed out'))
    }, RPC_TIMEOUT_MS)

    deps.addProjectListener(requestId, result => {
      clearTimeout(timeout)
      resolve(result as Result)
    })

    try {
      sentinel.send(JSON.stringify({ type: spec.opType, requestId, projectRoot: parsed.path, ...op }))
    } catch {
      clearTimeout(timeout)
      deps.removeProjectListener(requestId)
      resolve(spec.fail(requestId, 'sentinel send failed'))
    }
  })
}

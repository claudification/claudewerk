/**
 * THE PROJECT-OP RELAY -- one implementation of a shape that had three copies.
 *
 * Every substrate that lives in a project's files (board, nightshift, quests,
 * now epics) is read and written THROUGH THE SENTINEL, because the sentinel owns
 * the filesystem and the broker must never touch it. That makes all four the
 * same relay: resolve a project URI to a sentinel, forward an op, await a
 * result, reply to the caller, and fan a permission-scoped beat on a write.
 *
 * quest.ts, nightshift and project each carry that flow inline, each with a
 * `fallow-ignore-next-line code-duplication` on top of it. This is that flow,
 * once, parameterised. Epic mode is the first caller; the other three can adopt
 * it in place (see the `broker-relay-adopt` card) -- they are tested and working,
 * so they move deliberately rather than as a drive-by.
 *
 * Boundary: never touches ccSessionId, and `projectRoot` is passed THROUGH from
 * the trusted URI -- the broker derives nothing from it (CWD IS INFORMATIONAL).
 */

import { parseProjectUri } from '../../shared/project-uri'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'

const RPC_TIMEOUT_MS = 10_000

export interface RelaySpec<Req extends { requestId: string; project: string }, Res> {
  /** Wire type of the message sent to the sentinel, e.g. `epic_op`. */
  opType: string
  /** Wire type of the reply sent back to the caller, e.g. `epic_result`. */
  resultType: string
  /** Reject anything malformed BEFORE a permission check runs, so a junk message
   *  can never be the thing that decides which permission is required. */
  valid: (d: Req) => boolean
  /** Does this op write? Decides `files` vs `files:read`. */
  isWrite: (d: Req) => boolean
  /** Build the sentinel-bound op from the request + the resolved root.
   *  `object` rather than `Record<string, unknown>`: the concrete wire types are
   *  interfaces, and a TS interface has no index signature, so requiring one
   *  here would force every caller to launder its own protocol type. */
  toOp: (d: Req, projectRoot: string) => object
  /** The broadcast beat for a successful write, or null for no beat. */
  beatFor: (d: Req, result: Res) => object | null
  /** Fields echoed back on an error reply so the caller can correlate it. */
  errorEcho: (d: Req) => Record<string, unknown>
}

/** Resolve a project URI to its host root + owning sentinel socket. */
function resolveTarget(ctx: HandlerContext, project: string) {
  const parsed = parseProjectUri(project)
  const sentinel =
    (parsed.authority ? ctx.conversations.getSentinelByAlias(parsed.authority) : undefined) ?? ctx.getSentinel()
  return { projectRoot: parsed.path, sentinel }
}

/**
 * Build the caller-facing handler for one substrate. The returned handler owns
 * the whole round trip including the timeout, so a sentinel that never answers
 * still produces exactly one reply rather than a caller waiting forever.
 */
export function buildRelayHandler<Req extends { requestId: string; project: string }, Res>(
  spec: RelaySpec<Req, Res>,
): MessageHandler {
  return (ctx, data) => {
    const d = data as unknown as Req
    if (!d.project || !d.requestId || !spec.valid(d)) return

    // Reads need files:read; writes need files. Throws GuardError on denial.
    ctx.requirePermission(spec.isWrite(d) ? 'files' : 'files:read', d.project)

    const replyWs = ctx.ws
    const sendReply = (msg: Record<string, unknown>) => {
      try {
        replyWs.send(JSON.stringify(msg))
      } catch {
        /* socket gone -- caller navigated away */
      }
    }
    const fail = (error: string) =>
      sendReply({ type: spec.resultType, requestId: d.requestId, ...spec.errorEcho(d), ok: false, error })

    const { projectRoot, sentinel } = resolveTarget(ctx, d.project)
    if (!sentinel) return fail('no sentinel connected for project')

    const timeout = setTimeout(() => {
      ctx.conversations.removeProjectListener(d.requestId)
      fail('sentinel timed out (10s)')
    }, RPC_TIMEOUT_MS)

    ctx.conversations.addProjectListener(d.requestId, result => {
      clearTimeout(timeout)
      sendReply(result as unknown as Record<string, unknown>)
      const beat = spec.beatFor(d, result as unknown as Res)
      if (beat) ctx.broadcastScoped(beat as unknown as MessageData, d.project)
    })

    try {
      sentinel.send(JSON.stringify({ type: spec.opType, ...spec.toOp(d, projectRoot) }))
    } catch {
      clearTimeout(timeout)
      ctx.conversations.removeProjectListener(d.requestId)
      fail('sentinel send failed')
    }
  }
}

/** Sentinel -> broker: resolve the pending listener, which replies to the caller. */
export const relayResultHandler: MessageHandler = (ctx, data: MessageData) => {
  if (data.requestId) ctx.conversations.resolveProject(data.requestId as string, data)
}

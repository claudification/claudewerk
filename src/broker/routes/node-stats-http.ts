/**
 * NODE STATS over HTTP -- the SECOND transport for the one vitals contract.
 *
 * `POST /api/node-stats`, body = a `node_stats` frame, bearer = an `rpt_` or
 * `snt_` secret. It exists so a box you would never install a toolchain on can
 * report vitals with fifteen lines of `sh` and a `curl` instead of 93 MB of
 * compiled Bun (`scripts/node-stats-report.sh` is the sanctioned one).
 *
 * IT RE-VALIDATES AND RE-STORES NOTHING. The body is `ingestNodeStats`, the
 * exact function the WebSocket handler calls -- same stamping, same validator,
 * same store, same broadcast. This file owns only what is HTTP about it:
 * resolving the bearer into a node identity, and turning the ingest outcome into
 * a status code.
 *
 * WHAT THE TRANSPORT LOSES (card `node-stats-http-ingest`, accepted): one
 * connection per key. That rule is a property of a CONNECTION, and a stateless
 * POST has nothing to hold. What survives is one ROW per key, because rows are
 * keyed by the credential -- two posters sharing a key overwrite each other
 * rather than double-counting. A leaked key can spoof that node's vitals, which
 * was already true over WS.
 */

import { Hono } from 'hono'
import { NODE_STATS_INGEST_PATH } from '../../shared/node-stats'
import { resolveAuth } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { canIngestNodeStatsHttp } from '../node-capability'
import { ingestNodeStats, type NodeStatsCredential } from '../node-stats-ingest'
import { broadcastToSubscribers } from './shared'

/**
 * Turn a bearer secret into the node identity the frame will be stamped with.
 *
 * TWO gates, both required. The capability says the ROLE may post vitals; the
 * id says this credential IS a node with a row to write. An admin secret passes
 * neither -- it has no node id, so there is nothing for it to be -- and that is
 * why it gets a 403 here rather than a fabricated row.
 */
function nodeCredentialFromRequest(req: Request): NodeStatsCredential | null {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const auth = resolveAuth(header.slice(7))
  if (!canIngestNodeStatsHttp(auth.role)) return null
  if (auth.role === 'reporter') return { nodeId: auth.reporterId, sender: 'reporter' }
  if (auth.role === 'sentinel') return { nodeId: auth.sentinelId, sender: 'sentinel' }
  return null
}

/**
 * The identity-stamp line is logged ONCE PER NODE here, not once per POST.
 *
 * On a socket the latch lives on the connection; a stateless POST has no
 * connection to hang it on, and at the shared 5s cadence an unlatched line is
 * ~17k lines a day per node restating that a node cannot know its own broker id.
 * Process-wide and unbounded-by-design: it holds one string per node that has
 * ever posted, which is the same order as the store itself.
 */
const announced = new Set<string>()

/** Tests only -- the latch is process-wide state. */
export function resetNodeStatsHttpAnnouncements(): void {
  announced.clear()
}

/** `verbose` gates the per-sample debug line exactly as `ctx.log.debug` does on
 *  the WS path -- one accepted frame every 5s per node is a firehose the two
 *  transports must not disagree about. */
export function createNodeStatsHttpRouter(conversationStore: ConversationStore, verbose = false): Hono {
  const app = new Hono()

  app.post(NODE_STATS_INGEST_PATH, async c => {
    const credential = nodeCredentialFromRequest(c.req.raw)
    if (!credential) {
      // requireAuth already turned away anyone with no credential at all, so
      // reaching here means a credential that authenticates HTTP generally
      // (admin) but is not a NODE. LOG EVERYTHING: a misconfigured poster that
      // gets a silent 403 is a node missing from the wall for no stated reason.
      console.log(`[node-stats] refused POST ${NODE_STATS_INGEST_PATH}: caller carries no node credential`)
      return c.json({ error: 'Forbidden: not a node credential' }, 403)
    }

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      console.log(`[node-stats] rejected node=${credential.nodeId} sender=${credential.sender} errors=[invalid JSON]`)
      return c.json({ error: 'invalid JSON body' }, 400)
    }

    const announceIdentity = !announced.has(credential.nodeId)
    if (announceIdentity) announced.add(credential.nodeId)

    const result = ingestNodeStats(credential, payload, {
      log: {
        info: msg => console.log(`[http] ${msg}`),
        debug: msg => {
          if (verbose) console.log(`[http] ${msg}`)
        },
      },
      broadcast: msg => broadcastToSubscribers(conversationStore, msg),
      announceIdentity,
    })
    // A malformed or non-`node_stats` body comes back with the validator's own
    // reasons -- the same strings the WS path logs -- so a shell script author
    // can see which field they got wrong instead of guessing at a bare 400.
    if (!result.ok) return c.json({ error: 'invalid node_stats frame', reasons: result.errors }, 400)

    return c.json({ ok: true, nodeId: credential.nodeId, machineOwner: result.machineOwner })
  })

  return app
}

/**
 * `POST /api/epic-seat` -- the HTTP face of the per-card seat mutex.
 *
 * ITS OWN ROUTE rather than another `op` on `/api/epic`, and the reason is the
 * shape of the request rather than tidiness: every action on that route names a
 * `project` and an `epicId`, and a seat knows NEITHER. It knows only that it is
 * itself. Everything else -- project, epic, card, role -- is read from the
 * caller's own launch tag by the broker (epic-seat-claim.ts), which is exactly
 * what makes the tool impossible to point at somebody else's card.
 *
 * So this route parses three fields, hands them over, and shapes the reply. The
 * permission question is asked INSIDE, once the caller's project is known.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { claimSeat, type SeatClaimDeps } from '../epic-seat-claim'
import { buildSweepDeps } from '../epic-sweep-loop'
import type { Permission } from '../permissions'
import { readJsonBody } from './json-body'

interface SeatBody {
  conversationId?: string
  action?: 'claim' | 'release'
  /** An ASSERTION the broker checks against the caller's launch tag, never a
   *  selector. See `SeatClaimInput.cardId`. */
  cardId?: string
}

type SeatBodyReady = SeatBody & { conversationId: string; action: 'claim' | 'release' }

function validate(b: SeatBody): string | null {
  if (!b.conversationId) return 'conversationId required'
  if (b.action !== 'claim' && b.action !== 'release') return 'action must be claim or release'
  return null
}

export interface EpicSeatRouteHelpers {
  httpHasPermission: (req: Request, permission: Permission, project: string, conversationId?: string) => boolean
}

export function createEpicSeatRouter(conversationStore: ConversationStore, helpers: EpicSeatRouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/epic-seat', async c => {
    const parsed = await readJsonBody<SeatBody, SeatBodyReady>(c, validate)
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400)
    const body = parsed.body

    const sweep = buildSweepDeps(conversationStore)
    const deps: SeatClaimDeps = {
      ...sweep,
      // BOTH actions write a card's frontmatter, so both ask for `files`. There
      // is no read-only shape of this call: a seat that only wanted to look
      // would use `epic_run inspect`.
      authorize: (project: string) => helpers.httpHasPermission(c.req.raw, 'files', project, body.conversationId),
    }

    const reply = await claimSeat(deps, {
      convId: body.conversationId,
      action: body.action,
      ...(body.cardId ? { cardId: body.cardId } : {}),
    })

    // `status` rides in the BODY as well as on the response, because the caller
    // has to tell two failures apart that both arrive as `outcome: 'error'`:
    // 502 means the question could not be put (proceed), 4xx means the caller is
    // not entitled to ask it (a real problem it should report, not route around).
    const payload = {
      ok: reply.ok,
      outcome: reply.outcome,
      note: reply.note,
      ...(reply.status ? { status: reply.status } : {}),
      ...(reply.exit ? { exit: true } : {}),
      ...(reply.seat ? { seat: reply.seat } : {}),
      ...(reply.lease ? { lease: reply.lease } : {}),
    }
    return reply.status ? c.json(payload, reply.status) : c.json(payload)
  })

  return app
}

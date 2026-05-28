/**
 * Sheaf route -- 24/48h fleet overview.
 *
 *   GET /api/sheaf?windowH=24
 *
 * Admin only. Returns a `SheafResponse` (see `src/shared/sheaf-types.ts`).
 *
 * See `.claude/docs/plan-sheaf.md` for the design.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { buildSheaf } from '../handlers/sheaf-build'
import type { StoreDriver } from '../store/types'
import type { TerminationLog } from '../termination-log'
import type { RouteHelpers } from './shared'

export function createSheafRouter(
  store: StoreDriver,
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
  terminationLog?: TerminationLog,
): Hono {
  const app = new Hono()

  // fallow-ignore-next-line complexity
  app.get('/api/sheaf', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) {
      return c.json({ error: 'Forbidden: admin only' }, 403)
    }
    const url = new URL(c.req.url)
    const windowHRaw = url.searchParams.get('windowH')
    const parsed = windowHRaw ? Number.parseInt(windowHRaw, 10) : 24
    const windowH = Number.isFinite(parsed) && parsed > 0 ? parsed : 24
    const response = buildSheaf({
      store,
      conversationStore,
      terminationLog,
      windowH,
    })
    return c.json(response)
  })

  return app
}

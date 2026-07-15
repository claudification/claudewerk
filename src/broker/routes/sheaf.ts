/**
 * Sheaf route -- 24/48h fleet overview.
 *
 *   GET /api/sheaf?windowH=24
 *
 * Admin only. Returns a `SheafResponse` (see `src/shared/sheaf-types.ts`).
 *
 * Phase 6 folds the SOTU narrative + git-fabric INTO the response via
 * `enrichSheafWithSotu`. The fleet aggregate crosses projects, so the enrichment
 * is handed a per-project visibility predicate derived from the CALLER'S grants
 * (`httpHasPermission('chat:read', uri)`) -- NEVER hardcoded true. A project the
 * viewer cannot see gets no SOTU block (no chronicle bleed) and is excluded from
 * the fleet union. The structural grid keeps its admin gate below; the predicate
 * is wired + enforced so opening the grid to non-admins later cannot leak a
 * chronicle (OPEN ITEM #2, the permission covenant).
 *
 * See `.claude/docs/plan-sheaf.md` for the design.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { buildSheaf } from '../handlers/sheaf-build'
import { enrichSheafWithSotu, requestSotuScan } from '../sotu'
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
    // Per-project visibility filter (the permission covenant): derived from the
    // caller's own grants, applied BEFORE any SOTU data is attached.
    enrichSheafWithSotu(response, {
      canViewProject: uri => helpers.httpHasPermission(c.req.raw, 'chat:read', uri),
    })
    // Scan-on-read: this response was built from the LAST scan; schedule a fresh
    // one per visible project so the NEXT refresh reflects out-of-band fixes
    // (e.g. a manual terminal commit). Coalesced + floored in the scheduler, so
    // hammering refresh cannot hammer the sentinel.
    for (const p of response.projects) requestSotuScan(p.projectUri)
    return c.json(response)
  })

  return app
}

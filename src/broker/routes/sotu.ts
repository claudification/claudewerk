/**
 * SOTU route -- the per-project State of the Union read surface for the panel.
 *
 *   GET /api/sotu?project=<projectUri>
 *
 * Admin only (Phase 5). Returns a `SotuView` (chronicle narrative + active
 * claims/stakes with CONTENDED flags + git alerts). LAZY-REGEN-IF-STALE: a stale
 * chronicle triggers a server-side reconcile before the response ("wither on
 * return"); a floor-only (disabled) project serves the free floor without spending.
 *
 * Per-project visibility scoping for a CROSS-project fleet view is Phase 6 (the
 * permission covenant); this single-project read is admin-gated.
 */

import { Hono } from 'hono'
import type { SotuView } from '../../shared/protocol'
import { applyWrite, buildConfigView } from '../handlers/sotu-config'
import { buildSotuView, maybeDistillOnRead, projectSlug, readDistillEvals } from '../sotu'
import { defaultResolveSotuConfig } from '../sotu/config'
import type { RouteHelpers } from './shared'

export function createSotuRouter(helpers: RouteHelpers): Hono {
  const app = new Hono()

  app.get('/api/sotu', async c => {
    if (!helpers.httpIsAdmin(c.req.raw)) {
      return c.json({ error: 'Forbidden: admin only' }, 403)
    }
    const project = new URL(c.req.url).searchParams.get('project')?.trim()
    if (!project) {
      return c.json({ error: 'project query param required' }, 400)
    }
    // Lazy-regen-if-stale: a no-op for a fresh / disabled project; a real reconcile
    // only on staleness. Never fail the read if the regen throws -- serve the floor.
    try {
      await maybeDistillOnRead(project)
    } catch {
      // degrade to the current (possibly stale) view
    }
    const enabled = defaultResolveSotuConfig(project).enabled
    const view: SotuView = buildSotuView({ slug: projectSlug(project), project, enabled, now: Date.now() })
    return c.json(view)
  })

  // Phase 7 -- the recent distill evals (recipe + cost + grounding) for QC. Admin.
  app.get('/api/sotu/evals', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const params = new URL(c.req.url).searchParams
    const project = params.get('project')?.trim()
    if (!project) return c.json({ error: 'project query param required' }, 400)
    const limitRaw = Number(params.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 20
    return c.json({ evals: readDistillEvals(projectSlug(project), limit) })
  })

  // Phase 7 -- read (GET) / edit (POST) the per-project SOTU tuning config. Admin
  // (the agent-facing equivalent is the benevolent-gated sotu_configure MCP tool).
  app.get('/api/sotu/config', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const project = new URL(c.req.url).searchParams.get('project')?.trim()
    if (!project) return c.json({ error: 'project query param required' }, 400)
    return c.json(buildConfigView(project))
  })

  app.post('/api/sotu/config', async c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const project = typeof body?.project === 'string' ? body.project.trim() : ''
    if (!project) return c.json({ error: 'project field required' }, 400)
    applyWrite(project, body as Record<string, unknown>)
    return c.json(buildConfigView(project))
  })

  return app
}

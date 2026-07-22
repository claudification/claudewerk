/**
 * HTTP routes for project-scoped hosted canvases.
 *
 *   GET    /api/canvases?projectUri=     list a project's canvases (metadata)
 *   POST   /api/canvases                 create (optionally seed a scene)
 *   GET    /api/canvases/:id             metadata + scene JSON
 *   PUT    /api/canvases/:id/scene       overwrite scene (+ optional thumbnail)
 *   PATCH  /api/canvases/:id             rename / archive
 *   DELETE /api/canvases/:id             remove (row + scene files)
 *   GET    /api/canvases/:id/thumb       thumbnail PNG
 *
 * Permission model (authed path -- Phase A):
 *   read  -> files:read on the canvas's project_uri
 *   write -> files       on the canvas's project_uri
 * Public share tiers (Phase D) layer on top via the share-token route.
 *
 * Every scene write runs through sanitizeCanvasScene (drops embed/iframe +
 * unsafe links) before it touches disk -- defense in depth, mandatory for share.
 */

import { randomBytes } from 'node:crypto'
import { type Context, Hono } from 'hono'
import type { CanvasShareTier, CanvasSummary } from '../../shared/protocol'
import { getAuthenticatedUser } from '../auth-routes'
import { enforceCanvasTier, sanitizeCanvasScene } from '../canvas-sanitize'
import { BLANK_SCENE, readScene, readThumb } from '../canvas-scenes'
import {
  archiveCanvas,
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  renameCanvas,
  saveCanvasScene,
  setCanvasShare,
  validateCanvasShare,
} from '../canvas-store'
import type { ConversationStore } from '../conversation-store'
import type { RouteHelpers } from './shared'

/** Longest a canvas link may live, mirroring the 30-day cap on conversation shares. */
const MAX_SHARE_HOURS = 30 * 24

/**
 * Validate a share request body into the two values the store needs.
 *
 * Pure + total: every rejection is a message, never a throw, so the route stays a
 * two-branch handler instead of growing a validation ladder inline.
 * `expiresInHours` absent/null means "until revoked", matching pre-expiry shares.
 */
export function parseShareRequest(
  body: { tier?: unknown; expiresInHours?: unknown } | null | undefined,
): { tier: CanvasShareTier; expiresAt: number | null } | { error: string } {
  const tier = body?.tier
  if (tier !== 'edit' && tier !== 'comment' && tier !== 'read') {
    return { error: "tier must be 'edit' | 'comment' | 'read'" }
  }
  const hours = body?.expiresInHours
  if (hours == null) return { tier, expiresAt: null }
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    return { error: 'expiresInHours must be a positive number or null' }
  }
  if (hours > MAX_SHARE_HOURS) return { error: `Maximum share duration is ${MAX_SHARE_HOURS / 24} days` }
  return { tier, expiresAt: Date.now() + hours * 60 * 60 * 1000 }
}

/** Decode a thumbnail field (raw base64 or a data: URL) to bytes, or undefined. */
function decodeThumb(thumb: unknown): Uint8Array | undefined {
  if (typeof thumb !== 'string' || !thumb) return undefined
  const b64 = thumb.startsWith('data:') ? thumb.slice(thumb.indexOf(',') + 1) : thumb
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  } catch {
    return undefined
  }
}

export function createCanvasesRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const app = new Hono()

  /** Project URI for a request: explicit `projectUri`, else resolved from a
   *  `conversationId` (how agent MCP tools, which only know their conv, scope). */
  function resolveProject(explicit: unknown, conversationId: unknown): string | undefined {
    if (typeof explicit === 'string' && explicit) return explicit
    if (typeof conversationId === 'string' && conversationId)
      return conversationStore.getConversation(conversationId)?.project
    return undefined
  }

  /** Load the :id canvas and enforce a permission on its project, in one shot.
   *  Returns the canvas, or a 404/403 Response to return immediately. */
  function guard(c: Context, perm: 'files' | 'files:read'): { res: Response } | { canvas: CanvasSummary } {
    const canvas = getCanvas(c.req.param('id') ?? '')
    if (!canvas) return { res: c.json({ error: 'Not found' }, 404) }
    if (!helpers.httpHasPermission(c.req.raw, perm, canvas.projectUri))
      return { res: c.json({ error: 'Forbidden' }, 403) }
    return { canvas }
  }

  /** guard() + parse the JSON body in one step (the common authed-mutation
   *  preamble). Returns a Response to bail, or the canvas + parsed body. */
  async function guardWithBody(
    c: Context,
    perm: 'files' | 'files:read',
  ): Promise<{ res: Response } | { canvas: CanvasSummary; body: Record<string, unknown> | null }> {
    const g = guard(c, perm)
    if ('res' in g) return g
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    return { canvas: g.canvas, body }
  }

  /** Resolve a canvas from a public share token, or a 404 Response. A cleared
   *  or rotated token matches no row -> the canvas is invisible (revocation). */
  // Expired reads exactly like revoked (404, no detail) -- see validateCanvasShare.
  function guardPublic(c: Context): { res: Response } | { canvas: CanvasSummary } {
    const canvas = validateCanvasShare(c.req.param('token') ?? '')
    if (!canvas) return { res: c.json({ error: 'invalid or revoked share' }, 404) }
    return { canvas }
  }

  /** Run a guest scene write through tier enforcement + sanitize + persist,
   *  returning the route Response. Kept out of the route to hold its branch
   *  count (and the public PUT handler's) under the complexity bar. */
  function applyGuestWrite(c: Context, canvas: CanvasSummary, nextRaw: string): Response {
    const tier = (canvas.shareTier ?? 'read') as CanvasShareTier
    const verdict = enforceCanvasTier(readScene(canvas.id) ?? BLANK_SCENE, nextRaw, tier)
    if (!verdict.ok || !verdict.json) {
      console.log(`[canvas] guest write rejected id=${canvas.id} tier=${tier} reason=${verdict.reason}`)
      return c.json({ error: verdict.reason ?? 'rejected' }, 403)
    }
    saveCanvasScene(canvas.id, verdict.json)
    return c.json({ ok: true })
  }

  /** Parse + sanitize an optional scene field from a request body. Returns the
   *  clean JSON (absent when no scene supplied) or a 400 Response. Shared by the
   *  create + save routes so the sanitize contract lives in exactly one place. */
  function sceneFromBody(c: Context, body: Record<string, unknown> | null): { json?: string } | { res: Response } {
    const raw = body?.scene
    if (typeof raw !== 'string' || !raw.trim()) return {}
    const clean = sanitizeCanvasScene(raw)
    if (clean.json === null) return { res: c.json({ error: 'Invalid scene JSON' }, 400) }
    return { json: clean.json }
  }

  // ─── list ────────────────────────────────────────────────────────
  app.get('/api/canvases', c => {
    const projectUri = resolveProject(c.req.query('projectUri'), c.req.query('conversationId'))
    if (!projectUri) return c.json({ error: 'projectUri or conversationId required' }, 400)
    if (!helpers.httpHasPermission(c.req.raw, 'files:read', projectUri)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ canvases: listCanvases(projectUri) })
  })

  // ─── create ──────────────────────────────────────────────────────
  app.post('/api/canvases', async c => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const projectUri = resolveProject(body?.projectUri, body?.conversationId)
    if (!projectUri) return c.json({ error: 'projectUri or conversationId required' }, 400)
    if (!helpers.httpHasPermission(c.req.raw, 'files', projectUri)) return c.json({ error: 'Forbidden' }, 403)
    const s = sceneFromBody(c, body)
    if ('res' in s) return s.res
    const canvas = createCanvas(projectUri, {
      name: typeof body?.name === 'string' ? body.name : 'Untitled canvas',
      createdBy: getAuthenticatedUser(c.req.raw) ?? undefined,
      sceneJson: s.json,
    })
    return c.json({ canvas })
  })

  // ─── read (metadata + scene) ─────────────────────────────────────
  app.get('/api/canvases/:id', c => {
    const g = guard(c, 'files:read')
    if ('res' in g) return g.res
    return c.json({ canvas: g.canvas, scene: readScene(g.canvas.id) })
  })

  // ─── save scene (+ optional thumbnail) ───────────────────────────
  app.put('/api/canvases/:id/scene', async c => {
    const g = await guardWithBody(c, 'files')
    if ('res' in g) return g.res
    const s = sceneFromBody(c, g.body)
    if ('res' in s) return s.res
    if (!s.json) return c.json({ error: 'scene required' }, 400)
    // HTTP autosave path (owner + guest onSnapshot PUT). Pairs with the PERSIST
    // log in saveCanvasScene: PUT + PERSIST = an HTTP save landed; PERSIST alone
    // = the WS delta-debounce save. Lets us see which path is actually firing.
    console.log(`[canvas] http PUT scene ${g.canvas.id.slice(0, 12)} bytes=${s.json.length} user=${getAuthenticatedUser(c.req.raw) ?? 'guest'}`)
    saveCanvasScene(g.canvas.id, s.json, decodeThumb(g.body?.thumb))
    return c.json({ canvas: getCanvas(g.canvas.id) })
  })

  // ─── rename / archive ────────────────────────────────────────────
  app.patch('/api/canvases/:id', async c => {
    const g = guard(c, 'files')
    if ('res' in g) return g.res
    const body = await c.req.json().catch(() => null)
    if (typeof body?.name === 'string') renameCanvas(g.canvas.id, body.name)
    if (typeof body?.archived === 'boolean') archiveCanvas(g.canvas.id, body.archived)
    return c.json({ canvas: getCanvas(g.canvas.id) })
  })

  // ─── delete ──────────────────────────────────────────────────────
  app.delete('/api/canvases/:id', c => {
    const g = guard(c, 'files')
    if ('res' in g) return g.res
    deleteCanvas(g.canvas.id)
    return c.json({ ok: true })
  })

  // ─── thumbnail ───────────────────────────────────────────────────
  app.get('/api/canvases/:id/thumb', c => {
    const g = guard(c, 'files:read')
    if ('res' in g) return g.res
    const bytes = readThumb(g.canvas.id)
    if (!bytes) return c.json({ error: 'No thumbnail' }, 404)
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } })
  })

  // ─── create / update public share (owner-only) ───────────────────
  // Mints (or re-tiers) a public share token for the canvas. Re-sharing a
  // canvas that was previously revoked mints a NEW token, so the old link
  // stays dead forever. Requires `files` (owner) on the project.
  app.post('/api/canvases/:id/share', async c => {
    const g = await guardWithBody(c, 'files')
    if ('res' in g) return g.res
    const req = parseShareRequest(g.body)
    if ('error' in req) return c.json({ error: req.error }, 400)
    // Reuse the existing token when only the tier/expiry changes; otherwise mint one.
    const token = g.canvas.shareToken ?? randomBytes(32).toString('base64url')
    setCanvasShare(g.canvas.id, token, req.tier, req.expiresAt)
    console.log(
      `[canvas] share set id=${g.canvas.id} tier=${req.tier} token=${token.slice(0, 8)}... ` +
        `expires=${req.expiresAt ? new Date(req.expiresAt).toISOString() : 'never'}`,
    )
    return c.json({ canvas: getCanvas(g.canvas.id), shareToken: token })
  })

  // ─── revoke public share (owner-only) ────────────────────────────
  // Clears the token. validateCanvasShare(oldToken) then returns null, so the
  // public route 404s and nobody can see the canvas anymore (Jonas's rule).
  app.delete('/api/canvases/:id/share', c => {
    const g = guard(c, 'files')
    if ('res' in g) return g.res
    const had = g.canvas.shareToken
    setCanvasShare(g.canvas.id, null, null)
    console.log(`[canvas] share revoked id=${g.canvas.id} token=${had ? `${had.slice(0, 8)}...` : 'none'}`)
    return c.json({ canvas: getCanvas(g.canvas.id) })
  })

  // ─── public read by share token (NO AUTH -- token IS the capability) ──
  // Revocation is intrinsic: a cleared/rotated token matches no row -> 404.
  // Returns ONLY this canvas (never the project's other canvases) and never
  // leaks the project URI or the token list. Scene re-sanitized on serve.
  app.get('/shared/public/canvas/:token', c => {
    const g = guardPublic(c)
    if ('res' in g) return g.res
    const raw = readScene(g.canvas.id) ?? BLANK_SCENE
    const clean = sanitizeCanvasScene(raw)
    return c.json({
      canvas: { id: g.canvas.id, name: g.canvas.name, updatedAt: g.canvas.updatedAt },
      tier: g.canvas.shareTier ?? 'read',
      scene: clean.json ?? raw,
    })
  })

  // ─── public write by share token (tier-gated guest edit/comment) ─────
  // read  -> 403; comment -> annotations only; edit -> full (all sanitized).
  app.put('/shared/public/canvas/:token/scene', async c => {
    const g = guardPublic(c)
    if ('res' in g) return g.res
    const next = ((await c.req.json().catch(() => null)) as Record<string, unknown> | null)?.scene
    if (typeof next !== 'string' || !next.trim()) return c.json({ error: 'scene required' }, 400)
    return applyGuestWrite(c, g.canvas, next)
  })

  // Pretty shorthand: /c/:token -> the SPA in canvas share mode. The SPA mounts
  // PublicCanvasView, which fetches /shared/public/canvas/:token (JSON).
  app.get('/c/:token', c => c.redirect(`/?share=${encodeURIComponent(c.req.param('token') ?? '')}&kind=canvas`))

  return app
}

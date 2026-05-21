/**
 * Sentinel management routes -- /api/sentinels
 * Admin-only CRUD for sentinel hosts.
 */

import { Hono } from 'hono'
import type { SelectionMode, SentinelProfileInfo } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { isValidSentinelAlias, type SentinelRegistry } from '../sentinel-registry'
import type { RouteHelpers } from './shared'

export function createSentinelRouter(
  sentinelRegistry: SentinelRegistry,
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // ─── Create sentinel ──────────────────────────────────────────────────
  app.post('/api/sentinels/create', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const body = (await c.req.json()) as { alias?: string; color?: string }
    const alias = body.alias?.trim().toLowerCase()

    if (!alias) return c.json({ error: 'alias is required' }, 400)
    if (!isValidSentinelAlias(alias)) {
      return c.json({ error: 'Invalid alias: must be lowercase alphanumeric with hyphens, 1-63 chars' }, 400)
    }

    const existing = sentinelRegistry.findByAlias(alias)
    if (existing) return c.json({ error: `Alias "${alias}" already exists` }, 409)

    const record = sentinelRegistry.create({
      alias,
      color: body.color,
      generateSecret: true,
    })

    return c.json({
      sentinelId: record.sentinelId,
      sentinelSecret: record.rawSecret,
      alias: record.aliases[0],
      isDefault: record.isDefault,
      color: record.color,
    })
  })

  // ─── List sentinels ────────────────────────────────────────────────────
  // fallow-ignore-next-line complexity
  app.get('/api/sentinels', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const all = sentinelRegistry.getAll()
    const result: Array<{
      sentinelId: string
      alias: string
      aliases: string[]
      isDefault: boolean
      color?: string
      connected: boolean
      hostname?: string
      spawnRoot?: string
      createdAt: number
      /** Sentinel-reported profile NAMES + display only (Profile-Env Boundary).
       *  Present when the sentinel is connected AND reported a non-empty
       *  profiles list. Stale offline sentinels do NOT carry profiles. */
      profiles?: SentinelProfileInfo[]
      defaultSelection?: SelectionMode
      pools?: string[]
      defaultPool?: string
    }> = []

    for (const [sentinelId, record] of all) {
      const conn = conversationStore.getSentinelConnection(sentinelId)
      result.push({
        sentinelId,
        alias: record.aliases[0],
        aliases: record.aliases,
        isDefault: record.isDefault,
        color: record.color,
        connected: !!conn,
        hostname: conn?.hostname,
        spawnRoot: conn?.spawnRoot,
        createdAt: record.createdAt,
        profiles: conn?.profiles,
        defaultSelection: conn?.defaultSelection,
        pools: conn?.pools,
        defaultPool: conn?.defaultPool,
      })
    }

    return c.json(result)
  })

  // ─── Update sentinel ──────────────────────────────────────────────────
  app.post('/api/sentinels/:id', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const sentinelId = c.req.param('id')
    const body = (await c.req.json()) as { alias?: string; isDefault?: boolean; color?: string }

    if (body.alias !== undefined) {
      const alias = body.alias.trim().toLowerCase()
      if (!isValidSentinelAlias(alias)) {
        return c.json({ error: 'Invalid alias: must be lowercase alphanumeric with hyphens, 1-63 chars' }, 400)
      }
      const existing = sentinelRegistry.findByAlias(alias)
      if (existing && existing.sentinelId !== sentinelId) {
        return c.json({ error: `Alias "${alias}" already in use` }, 409)
      }
      body.alias = alias
    }

    const updated = sentinelRegistry.update(sentinelId, body)
    if (!updated) return c.json({ error: 'Sentinel not found' }, 404)

    return c.json({
      sentinelId: updated.sentinelId,
      alias: updated.aliases[0],
      aliases: updated.aliases,
      isDefault: updated.isDefault,
      color: updated.color,
    })
  })

  // ─── Read per-profile usage for one sentinel ──────────────────────────
  //
  // Returns the latest batched `sentinel_usage_report` snapshots the broker
  // has from this sentinel. 404 when the sentinel is unknown / offline /
  // hasn't reported yet. Used by the control panel for hydration on
  // reconnect (Phase 4) -- the live updates flow through the WS broadcast.
  //
  // Snapshots carry NAMES + utilisation numbers only -- Profile-Env Boundary
  // is preserved end-to-end (the sentinel sanitises at the wire, the broker
  // re-sanitises in the handler, this route just emits what's stored).
  app.get('/api/sentinels/:id/usage', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)
    const sentinelId = c.req.param('id')
    const usage = conversationStore.getSentinelProfileUsage(sentinelId)
    if (!usage) return c.json({ error: 'No usage data for sentinel' }, 404)
    return c.json(usage)
  })

  // ─── Delete sentinel ──────────────────────────────────────────────────
  app.delete('/api/sentinels/:id', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const sentinelId = c.req.param('id')
    const record = sentinelRegistry.get(sentinelId)
    if (!record) return c.json({ error: 'Sentinel not found' }, 404)

    // Disconnect sentinel if online
    const conn = conversationStore.getSentinelConnection(sentinelId)
    if (conn) {
      try {
        conn.ws.close(4403, 'Sentinel revoked')
      } catch {}
    }

    sentinelRegistry.remove(sentinelId)
    return c.json({ ok: true })
  })

  return app
}

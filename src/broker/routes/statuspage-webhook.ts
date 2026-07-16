/**
 * Statuspage webhook receiver.
 *
 * status.claude.com runs on Atlassian Statuspage, which fires an outgoing
 * JSON POST on incident create/update/resolve and on component status change.
 * Statuspage CANNOT send an auth header, so the endpoint is public; we guard it
 * with an unguessable secret in the path, derived deterministically from
 * RCLAUDE_SECRET (stable across restarts, no extra config to set).
 *
 * A single degradation arrives as a BURST of near-identical events. We keep
 * logging every raw payload to the kv ring (the data source for filters/UI),
 * but pushes now flow through the debouncing aggregator, which coalesces each
 * burst into ONE model-named push and swallows flaps. See
 * `statuspage-aggregator.ts` for the state machine.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { sendPushToAll } from '../push'
import type { StoreDriver } from '../store/types'
import { DEFAULT_WINDOW_MS, StatuspageAggregator } from './statuspage-aggregator'

/** kv key holding the rolling ring of received webhook events. */
const EVENTS_KEY = 'statuspage:events'
/** How many raw events we keep (for filter/UI work off real data). */
const RING_CAP = 500

/** One persisted webhook hit -- full raw payload kept on purpose. */
interface StatuspageEvent {
  receivedAt: number
  ip?: string
  /** The full parsed Statuspage payload, verbatim. */
  payload: unknown
}

/** Derive the stable, unguessable path token from the broker secret. */
function webhookToken(rclaudeSecret: string): string {
  return createHash('sha256').update(`${rclaudeSecret}:statuspage-webhook`).digest('hex').slice(0, 32)
}

/** Persist one event to the capped kv ring. Best-effort -- never throws. */
function persistEvent(store: StoreDriver, event: StatuspageEvent): void {
  try {
    const ring = store.kv.get<StatuspageEvent[]>(EVENTS_KEY) ?? []
    ring.push(event)
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
    store.kv.set(EVENTS_KEY, ring)
  } catch (err) {
    console.error('[statuspage] failed to persist event:', err instanceof Error ? err.message : err)
  }
}

/** Trailing debounce window, overridable via STATUSPAGE_WINDOW_MS. */
function resolveWindowMs(): number {
  const raw = process.env.STATUSPAGE_WINDOW_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WINDOW_MS
}

export function createStatuspageWebhookRouter(store: StoreDriver, rclaudeSecret: string | undefined): Hono {
  const app = new Hono()
  const expected = rclaudeSecret ? webhookToken(rclaudeSecret) : null
  const windowMs = resolveWindowMs()

  const aggregator = new StatuspageAggregator({
    store,
    windowMs,
    sendPush: ({ title, body, data }) => {
      console.log(`[statuspage] flush push title="${title}" body="${body}"`)
      sendPushToAll({ title, body, tag: 'claude-status', data: { source: 'statuspage', ...data } })
        .then(r => console.log(`[statuspage] pushed: sent=${r.sent} failed=${r.failed}`))
        .catch(err => console.error('[statuspage] push failed:', err instanceof Error ? err.message : err))
    },
  })

  if (expected)
    console.log(`[statuspage] webhook receiver ready at POST /webhooks/statuspage/${expected} (window=${windowMs}ms)`)
  else console.warn('[statuspage] RCLAUDE_SECRET unset -- webhook receiver disabled (503 on hit)')

  app.post('/webhooks/statuspage/:token', async c => {
    const token = c.req.param('token')
    if (!expected) return c.json({ error: 'Webhook not configured' }, 503)
    // Constant-time compare; lengths are fixed (32 hex chars) so a mismatch is a 404.
    const ok = token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    if (!ok) return c.json({ error: 'Not found' }, 404)

    const raw = await c.req.text()
    let payload: Record<string, unknown>
    try {
      payload = raw ? JSON.parse(raw) : {}
    } catch {
      console.warn('[statuspage] non-JSON webhook body, ignoring:', raw.slice(0, 200))
      return c.json({ ok: true }) // ack so Statuspage doesn't retry-storm
    }

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || undefined
    persistEvent(store, { receivedAt: Date.now(), ip, payload })

    const accepted = aggregator.ingest(payload)
    console.log(
      `[statuspage] webhook received ip=${ip ?? '?'} accepted=${accepted} payloadKeys=${Object.keys(payload).join(',')}`,
    )

    return c.json({ ok: true })
  })

  return app
}

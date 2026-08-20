/**
 * Web Push Notification support
 * Subscriptions stored per-user in auth.json.
 * Sending checks grants (canNotifications) before delivery.
 */

import webpush from 'web-push'
import { getAllUsers, getUser, type PushSubscriptionEntry, save as saveAuth } from './auth'
import { resolvePermissions } from './permissions'

export type { PushSubscriptionEntry }

export type PushSubscriptionData = PushSubscriptionEntry['subscription']

let vapidConfigured = false

export interface PushConfig {
  vapidPublicKey: string
  vapidPrivateKey: string
  vapidSubject?: string
}

export function initPush(config: PushConfig): void {
  webpush.setVapidDetails(
    config.vapidSubject || 'mailto:push@rclaude.local',
    config.vapidPublicKey,
    config.vapidPrivateKey,
  )
  vapidConfigured = true
}

/**
 * THE PUSH TEST SEAM.
 *
 * The two calls the attention/notify paths make -- "is push even on?" and "send
 * it to everyone" -- behind a swappable slot, so a test can substitute them
 * WITHOUT `mock.module('./push')`.
 *
 * Why this exists rather than a module mock: Bun's `mock.module` is
 * process-global, permanent, and REPLACES the module record, so a factory that
 * returns 2 of this module's 7 exports deletes the other 5 for every file linked
 * afterwards in the same `bun test` process. The importer then dies at LINK time
 * with `SyntaxError: Export named 'initPush' not found in module` -- in a file
 * that has nothing to do with push. `nightshift-orchestrator` lost four test
 * files to exactly that; `module-mock-completeness.test.ts` now guards the class.
 *
 * Same shape as `configureNightshiftIo` in `nightshift-orchestrator.ts`.
 * `sendPushToUser` is deliberately NOT in the seam yet -- nothing needs to stub
 * it; add it here (never a module mock) the day something does.
 */
export interface PushIo {
  isPushConfigured: () => boolean
  sendPushToAll: (payload: PushPayload) => Promise<{ sent: number; failed: number }>
}

// Both are hoisted function declarations further down this file.
const REAL_IO: PushIo = { isPushConfigured: isPushConfiguredReal, sendPushToAll: sendPushToAllReal }
let io: PushIo = REAL_IO

/** Swap the push seam (tests only). Call `resetPushIo()` when done. */
export function configurePushIo(next: Partial<PushIo>): void {
  io = { ...REAL_IO, ...next }
}

/** Restore the real VAPID check and the real sender. */
export function resetPushIo(): void {
  io = REAL_IO
}

export function isPushConfigured(): boolean {
  return io.isPushConfigured()
}

function isPushConfiguredReal(): boolean {
  return vapidConfigured
}

// ─── Per-user subscription management ─────────────────────────────

export function addSubscription(userName: string, sub: PushSubscriptionData, userAgent?: string): void {
  const user = getUser(userName)
  if (!user) return
  if (!user.pushSubscriptions) user.pushSubscriptions = []
  // Dedup by endpoint
  const existing = user.pushSubscriptions.findIndex(s => s.subscription.endpoint === sub.endpoint)
  if (existing >= 0) {
    user.pushSubscriptions[existing] = { subscription: sub, createdAt: Date.now(), userAgent }
  } else {
    user.pushSubscriptions.push({ subscription: sub, createdAt: Date.now(), userAgent })
  }
  saveAuth()
}

export function removeSubscription(userName: string, endpoint: string): void {
  const user = getUser(userName)
  if (!user?.pushSubscriptions) return
  user.pushSubscriptions = user.pushSubscriptions.filter(s => s.subscription.endpoint !== endpoint)
  saveAuth()
}

export function getSubscriptionCount(): number {
  let count = 0
  for (const user of getAllUsers()) {
    count += user.pushSubscriptions?.length || 0
  }
  return count
}

// ─── Sending ──────────────────────────────────────────────────────

export interface PushPayload {
  title: string
  body: string
  conversationId?: string
  project?: string
  tag?: string
  data?: Record<string, unknown>
}

/**
 * Send push to a single named user. Respects `notifications` permission for
 * the conversation's project (same rule as sendPushToAll). Used for @mention
 * synthesis so we don't leak content from a project the mentioned user can't
 * see. Returns { sent: 0 } silently if the user is unknown / revoked / lacks
 * permission -- not a hard error, mentions are best-effort.
 */
export async function sendPushToUser(
  userName: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  if (!vapidConfigured) return { sent: 0, failed: 0 }
  const user = getUser(userName)
  if (!user || user.revoked || !user.pushSubscriptions?.length) return { sent: 0, failed: 0 }

  if (payload.project) {
    const { permissions } = resolvePermissions(user.grants, payload.project)
    if (!permissions.has('notifications')) return { sent: 0, failed: 0 }
  }

  const jsonPayload = JSON.stringify(payload)
  let sent = 0
  let failed = 0
  const staleEndpoints: string[] = []

  for (const entry of user.pushSubscriptions) {
    try {
      await webpush.sendNotification(entry.subscription, jsonPayload, { TTL: 60, urgency: 'high' })
      sent++
    } catch (error: unknown) {
      const statusCode = (error as Record<string, unknown>)?.statusCode
      if (statusCode === 404 || statusCode === 410) staleEndpoints.push(entry.subscription.endpoint)
      failed++
    }
  }

  for (const endpoint of staleEndpoints) {
    console.log(`[push] Removing stale subscription for "${userName}" (endpoint gone: ${endpoint.slice(0, 60)}...)`)
    removeSubscription(userName, endpoint)
  }

  return { sent, failed }
}

/** Send push to all users who have notifications permission for the conversation's project */
export function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  return io.sendPushToAll(payload)
}

// Not introduced complexity: this is the body `sendPushToAll` has always had,
// renamed when the seam went in. fallow attributes by function name, so every
// seam extraction reports its own pre-existing code as new. Reducing it is a
// separate change against push semantics, not part of the test-seam fix.
// fallow-ignore-next-line complexity
async function sendPushToAllReal(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (!vapidConfigured) return { sent: 0, failed: 0 }

  const jsonPayload = JSON.stringify(payload)
  let sent = 0
  let failed = 0
  // Why a user got nothing. A push that silently reaches zero devices is
  // indistinguishable from a push that was never attempted, so count the
  // skip reasons and report them with the outcome.
  let skippedNoSubs = 0
  let skippedNoPermission = 0
  const staleEntries: Array<{ userName: string; endpoint: string }> = []

  for (const user of getAllUsers()) {
    if (user.revoked) continue
    if (!user.pushSubscriptions?.length) {
      skippedNoSubs++
      continue
    }

    // Check if user has notifications permission for this conversation's project
    if (payload.project) {
      const { permissions } = resolvePermissions(user.grants, payload.project)
      if (!permissions.has('notifications')) {
        skippedNoPermission++
        continue
      }
    }

    for (const entry of user.pushSubscriptions) {
      try {
        await webpush.sendNotification(entry.subscription, jsonPayload, {
          TTL: 60,
          urgency: 'high',
        })
        sent++
      } catch (error: unknown) {
        const statusCode = (error as Record<string, unknown>)?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          staleEntries.push({ userName: user.name, endpoint: entry.subscription.endpoint })
        }
        failed++
      }
    }
  }

  // Clean up stale subscriptions (404/410 = endpoint no longer valid)
  if (staleEntries.length > 0) {
    for (const { userName, endpoint } of staleEntries) {
      console.log(`[push] Removing stale subscription for "${userName}" (endpoint gone: ${endpoint.slice(0, 60)}...)`)
      removeSubscription(userName, endpoint)
    }
  }

  console.log(
    `[push] sendToAll "${payload.title}" conv=${payload.conversationId?.slice(0, 8) ?? '-'} sent=${sent} failed=${failed} skipped(no-subs)=${skippedNoSubs} skipped(no-permission)=${skippedNoPermission}`,
  )
  return { sent, failed }
}

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * THE KEEPALIVE CEILING.
 *
 * `dialog_keepalive` restarts the 4-minute push clock on the theory that the
 * user is looking at the dialog. A MINIMIZED dialog keepalives itself every 30
 * seconds with no human involved (`web/src/components/dialog/dialog-modal.tsx`),
 * so an uncapped restart means a dialog you parked and forgot never pushes --
 * precisely the case where the push is the last thing that could save it.
 *
 * These tests pin that the clock can be restarted but never beyond
 * MAX_NOTIFY_DEFERRAL_MS from the moment the dialog was shown.
 */

const sent: Array<{ title: string; conversationId?: string }> = []

mock.module('./push', () => ({
  isPushConfigured: () => true,
  sendPushToAll: async (p: { title: string; conversationId?: string }) => {
    sent.push(p)
    return { sent: 1, failed: 0 }
  },
}))

const { cancelDialogNotify, rearmAttentionNotify, resetDialogNotifyTimer, scheduleDialogNotify } = await import(
  './attention-notify'
)

const CONV = 'conv-ceiling-test'
const PARAMS = { conversationId: CONV, project: 'claude://default/tmp', dialogTitle: 'A/B test' }

const NOTIFY_DELAY_MS = 4 * 60 * 1000
const MAX_NOTIFY_DEFERRAL_MS = 15 * 60 * 1000

/** Drive the module's clock without waiting 15 real minutes. */
let now = 1_800_000_000_000
const realNow = Date.now

beforeEach(() => {
  sent.length = 0
  now = 1_800_000_000_000
  Date.now = () => now
  rearmAttentionNotify(CONV)
})

afterEach(() => {
  cancelDialogNotify(CONV)
  Date.now = realNow
})

/** Advance the fake clock and let bun's timers catch up to it. */
async function advance(ms: number): Promise<void> {
  now += ms
  await Bun.sleep(0)
}

describe('resetDialogNotifyTimer', () => {
  test('a keepalive after the ceiling schedules the push immediately, not another 4 minutes out', async () => {
    scheduleDialogNotify(PARAMS)

    // Thirteen minutes of minimized auto-keepalives, then one past the ceiling.
    await advance(MAX_NOTIFY_DEFERRAL_MS + 60_000)
    resetDialogNotifyTimer(PARAMS)

    await Bun.sleep(20)
    expect(sent.map(p => p.title)).toEqual(['Input needed'])
  })

  test('a keepalive inside the ceiling still defers the push', async () => {
    scheduleDialogNotify(PARAMS)

    await advance(60_000)
    resetDialogNotifyTimer(PARAMS)

    await Bun.sleep(20)
    expect(sent).toHaveLength(0)
  })

  test('a keepalive with no live timer does not resurrect a push', async () => {
    // The dialog was answered; its timer is gone. A late keepalive must not
    // arm a fresh clock for a dialog nobody is waiting on.
    scheduleDialogNotify(PARAMS)
    cancelDialogNotify(CONV)

    resetDialogNotifyTimer(PARAMS)
    await advance(NOTIFY_DELAY_MS + 1_000)

    await Bun.sleep(20)
    expect(sent).toHaveLength(0)
  })
})

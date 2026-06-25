/**
 * use-nightshift-queue: the manual Run-now trigger (`runNightshiftNow`).
 * Verifies it sends the `op:'run'` envelope and maps a rejected RPC (empty
 * queue / already running) to `ok:false` + the reason.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

const sendNightshiftRpc = vi.fn()

vi.mock('./nightshift-rpc', () => ({
  sendNightshiftRpc: (...args: unknown[]) => sendNightshiftRpc(...args),
  onNightshiftEvent: () => () => {},
  installNightshiftHandler: () => {},
}))

import { runNightshiftNow } from './use-nightshift-queue'

afterEach(() => vi.clearAllMocks())

describe('runNightshiftNow', () => {
  test('sends the op:run envelope and reports ok', async () => {
    sendNightshiftRpc.mockResolvedValue({ ok: true })
    const res = await runNightshiftNow('claude://default/p')
    expect(sendNightshiftRpc).toHaveBeenCalledWith({
      type: 'nightshift_request',
      project: 'claude://default/p',
      op: 'run',
    })
    expect(res).toEqual({ ok: true })
  })

  test('surfaces a rejected trigger as ok:false + reason', async () => {
    sendNightshiftRpc.mockRejectedValue(new Error('queue is empty'))
    const res = await runNightshiftNow('claude://default/p')
    expect(res).toEqual({ ok: false, reason: 'queue is empty' })
  })
})

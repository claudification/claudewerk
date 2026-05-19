/**
 * Tier 1 unit tests for `attachWithRetry` -- the ESTARTING/ENOJOB retry layer.
 * Drives a fake `attachFn` (the `attachFn` seam), so no socket / daemon needed.
 */
import { describe, expect, test } from 'bun:test'
import { type AttachCloseReason, type AttachHandle, DaemonAttachError } from '../shared/cc-daemon/attach'
import { ProtocolMismatchError } from '../shared/cc-daemon/client'
import { attachWithRetry } from './attach-retry'

/** A minimal live `AttachHandle` for the success paths. */
function fakeHandle(): AttachHandle {
  return {
    ack: { ok: true, op: 'attach', decModes: [], via: 'spare', tempo: 'idle', state: 'running' },
    attachId: 'att_test',
    writeInput: () => {},
    resize: async () => {},
    close: () => {},
    closed: false,
  }
}

describe('attachWithRetry', () => {
  test('returns the handle on a first-attempt success -- no retries', async () => {
    let calls = 0
    const retries: number[] = []
    const handle = await attachWithRetry(
      '/sock',
      'short123',
      { cols: 80, rows: 24, onData: () => {} },
      {
        delayMs: 1,
        onRetry: a => retries.push(a),
        attachFn: async () => {
          calls++
          return fakeHandle()
        },
      },
    )
    expect(handle.ack.state).toBe('running')
    expect(calls).toBe(1)
    expect(retries).toEqual([])
  })

  test('retries ESTARTING and succeeds mid-loop', async () => {
    let calls = 0
    const retries: Array<{ attempt: number; code: string | undefined }> = []
    const handle = await attachWithRetry(
      '/sock',
      'short123',
      { cols: 80, rows: 24, onData: () => {} },
      {
        delayMs: 1,
        onRetry: (attempt, _max, code) => retries.push({ attempt, code }),
        attachFn: async () => {
          calls++
          if (calls < 3) throw new DaemonAttachError('worker booting (ESTARTING)', 'ESTARTING')
          return fakeHandle()
        },
      },
    )
    expect(handle).toBeDefined()
    expect(calls).toBe(3)
    expect(retries).toEqual([
      { attempt: 1, code: 'ESTARTING' },
      { attempt: 2, code: 'ESTARTING' },
    ])
  })

  test('retries ENOJOB (daemon has not registered the job yet)', async () => {
    let calls = 0
    const handle = await attachWithRetry(
      '/sock',
      'short123',
      { cols: 80, rows: 24, onData: () => {} },
      {
        delayMs: 1,
        attachFn: async () => {
          calls++
          if (calls < 2) throw new DaemonAttachError('no such job (ENOJOB)', 'ENOJOB')
          return fakeHandle()
        },
      },
    )
    expect(handle).toBeDefined()
    expect(calls).toBe(2)
  })

  /** Run `attachWithRetry`, expecting a rejection -- returns the thrown error. */
  async function expectReject(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise
    } catch (err) {
      return err
    }
    throw new Error('attachWithRetry should have rejected')
  }

  test('never retries EPROTO -- throws ProtocolMismatchError immediately', async () => {
    let calls = 0
    const retries: number[] = []
    const err = await expectReject(
      attachWithRetry(
        '/sock',
        'short123',
        { cols: 80, rows: 24, onData: () => {} },
        {
          delayMs: 1,
          onRetry: a => retries.push(a),
          attachFn: async () => {
            calls++
            throw new ProtocolMismatchError('daemon bumped the protocol')
          },
        },
      ),
    )
    expect(err).toBeInstanceOf(ProtocolMismatchError)
    expect(calls).toBe(1)
    expect(retries).toEqual([])
  })

  test('does not retry a non-transient daemon code (EKICKED)', async () => {
    let calls = 0
    const err = await expectReject(
      attachWithRetry(
        '/sock',
        'short123',
        { cols: 80, rows: 24, onData: () => {} },
        {
          delayMs: 1,
          attachFn: async () => {
            calls++
            throw new DaemonAttachError('evicted (EKICKED)', 'EKICKED')
          },
        },
      ),
    )
    expect((err as Error).message).toMatch(/EKICKED/)
    expect(calls).toBe(1)
  })

  test('does not retry a plain socket error', async () => {
    let calls = 0
    const err = await expectReject(
      attachWithRetry(
        '/sock',
        'short123',
        { cols: 80, rows: 24, onData: () => {} },
        {
          delayMs: 1,
          attachFn: async () => {
            calls++
            throw new Error('cc-daemon: attach short123 socket error: ENOENT')
          },
        },
      ),
    )
    expect((err as Error).message).toMatch(/socket error/)
    expect(calls).toBe(1)
  })

  test('gives up after maxAttempts and throws the last error', async () => {
    let calls = 0
    const retries: number[] = []
    const err = await expectReject(
      attachWithRetry(
        '/sock',
        'short123',
        { cols: 80, rows: 24, onData: () => {} },
        {
          delayMs: 1,
          maxAttempts: 4,
          onRetry: a => retries.push(a),
          attachFn: async () => {
            calls++
            throw new DaemonAttachError('still booting (ESTARTING)', 'ESTARTING')
          },
        },
      ),
    )
    expect((err as Error).message).toMatch(/ESTARTING/)
    expect(calls).toBe(4)
    // onRetry fires between attempts -- not after the final, failed one.
    expect(retries).toEqual([1, 2, 3])
  })

  test('onClose: suppressed for a failed attempt, forwarded for the live handle', async () => {
    const closes: AttachCloseReason[] = []
    let capturedOnClose: ((reason: AttachCloseReason) => void) | undefined
    let attempt = 0
    const handle = await attachWithRetry(
      '/sock',
      'short123',
      {
        cols: 80,
        rows: 24,
        onData: () => {},
        onClose: reason => closes.push(reason),
      },
      {
        delayMs: 1,
        attachFn: async (_sock, _short, opts) => {
          attempt++
          if (attempt === 1) {
            // A pre-ack failure: attach.ts fires onClose, then the promise rejects.
            opts.onClose?.('socket-error')
            throw new DaemonAttachError('booting (ESTARTING)', 'ESTARTING')
          }
          capturedOnClose = opts.onClose
          return fakeHandle()
        },
      },
    )
    expect(handle).toBeDefined()
    // The failed attempt's close event was swallowed.
    expect(closes).toEqual([])
    // The live handle's later drop IS forwarded to the caller.
    capturedOnClose?.('socket-closed')
    expect(closes).toEqual(['socket-closed'])
  })
})

import { describe, expect, it } from 'bun:test'
import { resolveControlSocket, resolveSockDir, sockDirFromRosterData } from './socket-path'

describe('sockDirFromRosterData', () => {
  it('derives the sock dir two segments up from a worker rendezvous socket', () => {
    const dir = sockDirFromRosterData({
      workers: { aeb185f9: { rendezvousSock: '/tmp/cc-daemon-501/ab12cd34/rv/aeb185f9.sock' } },
    })
    expect(dir).toBe('/tmp/cc-daemon-501/ab12cd34')
  })

  it('returns null when the roster has no workers', () => {
    expect(sockDirFromRosterData({ workers: {} })).toBeNull()
    expect(sockDirFromRosterData({})).toBeNull()
  })

  it('skips workers that carry no rendezvousSock', () => {
    const dir = sockDirFromRosterData({
      workers: {
        a: undefined,
        b: {},
        c: { rendezvousSock: '/tmp/cc-daemon-501/ffffeeee/rv/c.sock' },
      },
    })
    expect(dir).toBe('/tmp/cc-daemon-501/ffffeeee')
  })
})

describe('resolveControlSocket / resolveSockDir', () => {
  // The daemon is transient: depending on the host it may or may not be up.
  // Both contracts hold either way -- a path or a clean null, never a throw.
  it('resolves to a control.sock path or null, without throwing', () => {
    const sock = resolveControlSocket()
    expect(sock === null || sock.endsWith('control.sock')).toBe(true)
  })

  it('resolves a sock dir or null, without throwing', () => {
    const dir = resolveSockDir()
    expect(dir === null || typeof dir === 'string').toBe(true)
  })
})

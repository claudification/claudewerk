import { describe, expect, it } from 'vitest'
import { canRespawnStaleDaemon, daemonControlToast } from './daemon-control'

describe('canRespawnStaleDaemon', () => {
  it('is true for a claude-daemon transport conversation', () => {
    expect(canRespawnStaleDaemon({ transport: 'claude-daemon' })).toBe(true)
  })

  it('is false for non-daemon transports and missing input', () => {
    expect(canRespawnStaleDaemon({ transport: 'claude-pty' })).toBe(false)
    expect(canRespawnStaleDaemon({ transport: 'claude-headless' })).toBe(false)
    expect(canRespawnStaleDaemon({})).toBe(false)
    expect(canRespawnStaleDaemon(undefined)).toBe(false)
    expect(canRespawnStaleDaemon(null)).toBe(false)
  })
})

describe('daemonControlToast -- failures', () => {
  it('builds a warning toast carrying the daemon error code + detail', () => {
    const t = daemonControlToast({ op: 'reply', ok: false, code: 'ENOREPLY', detail: 'mid-turn', conversationId: 'c1' })
    expect(t).toEqual({ title: 'Reply failed', body: 'ENOREPLY: mid-turn', variant: 'warning', conversationId: 'c1' })
  })

  it('falls back gracefully when code / detail are absent', () => {
    const t = daemonControlToast({ op: 'kill', ok: false })
    expect(t?.variant).toBe('warning')
    expect(t?.body).toBe('error: unknown error')
  })

  it('labels an unknown op generically', () => {
    const t = daemonControlToast({ op: 'mystery', ok: false, code: 'EX' })
    expect(t?.title).toBe('Daemon control failed')
  })
})

describe('daemonControlToast -- successes', () => {
  it('toasts a successful kill / respawn-stale / permission-response', () => {
    expect(daemonControlToast({ op: 'kill', ok: true })?.variant).toBe('success')
    expect(daemonControlToast({ op: 'respawn_stale', ok: true })?.title).toBe('Respawn stale worker ok')
    expect(daemonControlToast({ op: 'permission_response', ok: true })?.variant).toBe('success')
  })

  it('stays quiet for a successful reply (the transcript already shows it)', () => {
    expect(daemonControlToast({ op: 'reply', ok: true })).toBeNull()
  })

  it('carries the conversationId through for toast deep-linking', () => {
    expect(daemonControlToast({ op: 'kill', ok: true, conversationId: 'c9' })?.conversationId).toBe('c9')
  })
})

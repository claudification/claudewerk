import { describe, expect, test } from 'bun:test'
import { createAttentionPolicy, describeSignal } from './attention-policy'

const MIN = 60_000

describe('observeStatus', () => {
  test('fires only on the TRANSITION into needs_you/blocked', () => {
    const p = createAttentionPolicy()
    expect(p.observeStatus('c1', 'claude:///p', 'working', 0)).toBeNull()
    const sig = p.observeStatus('c1', 'claude:///p', 'needs_you', MIN)
    expect(sig).toMatchObject({ kind: 'needs_you', conversationId: 'c1', state: 'needs_you' })
    // Repeat report of the same state (seq bump) -> no re-fire.
    expect(p.observeStatus('c1', 'claude:///p', 'needs_you', 2 * MIN)).toBeNull()
    // needs_you -> blocked is NOT a fresh flip (still "wants attention").
    expect(p.observeStatus('c1', 'claude:///p', 'blocked', 3 * MIN)).toBeNull()
  })

  test('re-fires after resolving + cooldown', () => {
    const p = createAttentionPolicy({ needsYouCooldownMs: 10 * MIN })
    expect(p.observeStatus('c1', null, 'needs_you', 0)).not.toBeNull() // first sight counts
    expect(p.observeStatus('c1', null, 'working', MIN)).toBeNull() // resolved
    // Flips again but still inside the cooldown -> suppressed.
    expect(p.observeStatus('c1', null, 'needs_you', 5 * MIN)).toBeNull()
    expect(p.observeStatus('c1', null, 'working', 6 * MIN)).toBeNull()
    // Past the cooldown -> fires again.
    expect(p.observeStatus('c1', null, 'needs_you', 16 * MIN)).not.toBeNull()
  })

  test('done/working never fire', () => {
    const p = createAttentionPolicy()
    expect(p.observeStatus('c2', null, 'done', 0)).toBeNull()
    expect(p.observeStatus('c2', null, 'working', MIN)).toBeNull()
  })
})

describe('observeGitAlerts / observeContended', () => {
  test('git alerts dedupe per (project, alert) with cooldown', () => {
    const p = createAttentionPolicy({ gitAlertCooldownMs: 60 * MIN })
    expect(p.observeGitAlerts('claude:///a', ['at-risk', 'unpushed'], 0)).toHaveLength(2)
    expect(p.observeGitAlerts('claude:///a', ['at-risk'], 30 * MIN)).toHaveLength(0)
    expect(p.observeGitAlerts('claude:///b', ['at-risk'], 30 * MIN)).toHaveLength(1) // other project
    expect(p.observeGitAlerts('claude:///a', ['at-risk'], 61 * MIN)).toHaveLength(1)
  })

  test('contended targets dedupe per (project, target)', () => {
    const p = createAttentionPolicy()
    const first = p.observeContended('claude:///a', [{ target: 'src/x.ts', holders: 2 }], 0)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'contended', target: 'src/x.ts', holders: 2 })
    expect(p.observeContended('claude:///a', [{ target: 'src/x.ts', holders: 3 }], MIN)).toHaveLength(0)
  })
})

describe('allowTurn (global sliding-window cap)', () => {
  test('caps turns per hour, window slides', () => {
    const p = createAttentionPolicy({ maxTurnsPerHour: 2 })
    expect(p.allowTurn(0)).toBe(true)
    expect(p.allowTurn(MIN)).toBe(true)
    expect(p.allowTurn(2 * MIN)).toBe(false)
    // First grant ages out of the 1h window -> a slot frees up.
    expect(p.allowTurn(61 * MIN)).toBe(true)
  })
})

describe('describeSignal', () => {
  test('human one-liners', () => {
    expect(
      describeSignal({ kind: 'needs_you', conversationId: 'c1234567890', project: 'claude:///p', state: 'blocked' }),
    ).toContain('flipped to blocked')
    expect(describeSignal({ kind: 'git_alert', project: 'claude:///p', alert: 'unpushed' })).toContain('unpushed')
    expect(describeSignal({ kind: 'contended', project: 'claude:///p', target: 'src/x.ts', holders: 2 })).toContain(
      'CONTENDED: 2 conversations',
    )
  })
})

/**
 * Tests for the broker's daemon roster forward (Phase E).
 *
 * The broker forwards the sentinel's daemon roster to dashboards so the spawn
 * dialog's ATTACH mode can browse live workers -- but with `sessionId` (a
 * ccSessionId) stripped per the boundary rule. This file lives under
 * `__tests__/` so it may name `sessionId` freely; `lint-boundary.ts` skips it.
 */

import { describe, expect, it } from 'bun:test'
import type { DaemonJobInfo } from '../../../shared/protocol'
import { buildRosterForward, toRosterJob } from '../daemon'

/** A fully-populated roster job, including the ccSessionId the broker must drop. */
function fullJob(overrides: Partial<DaemonJobInfo> = {}): DaemonJobInfo {
  return {
    conversationId: 'conv_abc123',
    short: 'aeb185f9',
    sessionId: 'ccs_should_never_leave_the_broker',
    cwd: '/Users/jonas/projects/x',
    state: 'working',
    name: 'fix the bug',
    cliVersion: '2.1.144',
    backend: 'claude',
    tempo: 'normal',
    detail: 'editing files',
    intent: 'bugfix',
    pid: 4242,
    attempt: 1,
    startedAt: 1_700_000_000_000,
    nonce: 'n0nce',
    source: 'cli',
    needs: undefined,
    ...overrides,
  }
}

describe('toRosterJob', () => {
  it('strips sessionId (a ccSessionId) from the forwarded job', () => {
    const view = toRosterJob(fullJob())
    expect('sessionId' in view).toBe(false)
    expect(JSON.stringify(view)).not.toContain('ccs_should_never_leave_the_broker')
  })

  it('copies every non-ccSessionId field through verbatim', () => {
    const job = fullJob()
    const view = toRosterJob(job)
    expect(view.conversationId).toBe(job.conversationId)
    expect(view.short).toBe(job.short)
    expect(view.cwd).toBe(job.cwd)
    expect(view.state).toBe(job.state)
    expect(view.name).toBe(job.name)
    expect(view.cliVersion).toBe(job.cliVersion)
    expect(view.backend).toBe(job.backend)
    expect(view.pid).toBe(job.pid)
    expect(view.startedAt).toBe(job.startedAt)
  })

  it('tolerates missing optional fields', () => {
    const view = toRosterJob(fullJob({ name: undefined, cliVersion: undefined }))
    expect(view.name).toBeUndefined()
    expect(view.cliVersion).toBeUndefined()
    expect(view.short).toBe('aeb185f9')
  })

  it('forwards the sentinel-profile NAME the job was polled under', () => {
    const view = toRosterJob(fullJob({ profile: 'work' }))
    expect(view.profile).toBe('work')
  })

  it('leaves profile undefined when the sentinel did not tag it (back-compat)', () => {
    const view = toRosterJob(fullJob({ profile: undefined }))
    expect(view.profile).toBeUndefined()
  })
})

describe('buildRosterForward', () => {
  it('shapes a daemon_roster forward with sanitized jobs', () => {
    const fwd = buildRosterForward([fullJob()], 'snt_one', 'workstation', {
      daemonPresent: true,
      daemonProto: 1,
      observedAt: 1_700_000_000_999,
    })
    expect(fwd.type).toBe('daemon_roster')
    expect(fwd.sentinelId).toBe('snt_one')
    expect(fwd.sentinelAlias).toBe('workstation')
    expect(fwd.daemonPresent).toBe(true)
    expect(fwd.daemonProto).toBe(1)
    expect(fwd.observedAt).toBe(1_700_000_000_999)
    expect(fwd.jobs).toHaveLength(1)
    expect('sessionId' in fwd.jobs[0]!).toBe(false)
  })

  it('defaults daemonPresent to false and stamps observedAt when absent', () => {
    const before = Date.now()
    const fwd = buildRosterForward([], undefined, undefined, {})
    expect(fwd.daemonPresent).toBe(false)
    expect(fwd.daemonProto).toBeUndefined()
    expect(fwd.jobs).toEqual([])
    expect(fwd.observedAt).toBeGreaterThanOrEqual(before)
  })

  it('never leaks a ccSessionId into the serialized forward', () => {
    const fwd = buildRosterForward([fullJob(), fullJob({ short: 'beefcafe' })], 'snt_x', 'host', {
      daemonPresent: true,
      observedAt: 1,
    })
    expect(JSON.stringify(fwd)).not.toContain('ccs_should_never_leave_the_broker')
    expect(fwd.jobs).toHaveLength(2)
  })
})

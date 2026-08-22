import { describe, expect, test } from 'bun:test'
import type { EpicRequest, EpicResult, EpicRunSnapshot } from '../../shared/protocol'
import { __testing } from './epic'

const { beatFor, WRITE_OPS } = __testing

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 6,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

function req(over: Partial<EpicRequest> = {}): EpicRequest {
  return { type: 'epic_request', requestId: 'r1', project: 'claude://s/p', op: 'start', epicId: 'e1', ...over }
}
function res(over: Partial<EpicResult> = {}): EpicResult {
  return { type: 'epic_result', requestId: 'r1', op: 'start', ok: true, ...over }
}

describe('which ops write', () => {
  test.each(['start', 'patch', 'log_append', 'lease', 'release', 'pause', 'abort'] as const)(
    '%s needs write permission',
    op => {
      expect(WRITE_OPS.has(op)).toBe(true)
    },
  )

  test('get is the only pure read', () => {
    expect(WRITE_OPS.has('get')).toBe(false)
  })

  test('lease counts as a WRITE -- it stamps the epic card', () => {
    expect(WRITE_OPS.has('lease')).toBe(true)
  })
})

describe('beatFor', () => {
  test('a failed op fans nothing', () => {
    expect(beatFor(req(), res({ ok: false, error: 'boom' }))).toBeNull()
  })

  test('a granted lease fans a generation beat carrying the generation', () => {
    const beat = beatFor(
      req({ op: 'lease' }),
      res({ op: 'lease', run: RUN, lease: { granted: true, convId: 'conv_a', gen: 6, at: '' } }),
    )
    expect(beat?.event).toBe('generation')
    expect(beat?.gen).toBe(6)
    expect(beat?.detail).toContain('gen 6')
  })

  test('a REFUSED lease fans NOTHING -- it is a normal double-settle, not a generation', () => {
    const beat = beatFor(
      req({ op: 'lease' }),
      res({ op: 'lease', ok: true, lease: { granted: false, convId: 'conv_a', gen: 6, at: '', reason: 'stale wake' } }),
    )
    expect(beat).toBeNull()
  })

  test('patch fans nothing -- the werk-master rewrites its digest several times a beat', () => {
    expect(beatFor(req({ op: 'patch' }), res({ op: 'patch', run: RUN }))).toBeNull()
  })

  test('start fans a started beat with the run status', () => {
    const beat = beatFor(req({ op: 'start' }), res({ run: { ...RUN, status: 'armed' } }))
    expect(beat?.event).toBe('started')
    expect(beat?.status).toBe('armed')
  })

  test('abort carries the reason into the beat detail', () => {
    const beat = beatFor(req({ op: 'abort', reason: 'scope changed' }), res({ op: 'abort', run: RUN }))
    expect(beat?.event).toBe('aborted')
    expect(beat?.detail).toContain('scope changed')
  })

  test('a baton append names the entry kind and its card', () => {
    const beat = beatFor(
      req({ op: 'log_append', logAppend: { kind: 'verdict', convId: 'c', body: 'x', cardId: 't3' } }),
      res({ op: 'log_append' }),
    )
    expect(beat?.event).toBe('logged')
    expect(beat?.detail).toContain('verdict')
    expect(beat?.detail).toContain('t3')
  })

  test('every beat is scoped to the project it came from', () => {
    expect(beatFor(req(), res({ run: RUN }))?.project).toBe('claude://s/p')
  })
})

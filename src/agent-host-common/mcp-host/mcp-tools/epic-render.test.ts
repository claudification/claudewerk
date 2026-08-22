/**
 * `renderEpic` is the only export, so every section is asserted through it --
 * which is also the honest test, since a section is only ever read as part of
 * the whole document.
 */

import { describe, expect, test } from 'bun:test'
import type { EpicInspectResult, EpicRunSnapshot } from '../../../shared/protocol'
import { type EpicRunPayload, renderEpic } from './epic-render'

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 7,
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
  digest: 'two cards landed, one bounced',
}

function inspect(over: Partial<EpicInspectResult> = {}): EpicRunPayload {
  return {
    ok: true,
    inspect: {
      epicId: 'e1',
      project: 'claude://s/p',
      run: RUN,
      lease: null,
      plan: {
        children: 4,
        dispatch: [],
        verify: [],
        questions: [],
        heldBack: [],
        waitingOnDeps: [],
        complete: false,
      },
      live: {
        armed: true,
        inFlight: [],
        settled: [],
        unacknowledged: [],
        werkMasterAlive: false,
        maxGenSeen: 7,
        conversations: [],
      },
      beats: [],
      baton: [],
      ...over,
    },
  }
}

describe('the run read', () => {
  test('an epic with no run says how to arm one, rather than printing an empty report', () => {
    expect(renderEpic({ ok: true, run: null })).toContain('action=start')
  })

  test('the header carries the generation ceiling, so a thrashing run is visible', () => {
    expect(renderEpic({ ok: true, run: RUN })).toContain('generation 7/40')
  })

  test('a free lease and a never-run lease read differently -- they are different facts', () => {
    expect(renderEpic({ ok: true, run: RUN, lease: null })).toContain('never run')
    expect(renderEpic({ ok: true, run: RUN, lease: { convId: '', gen: 4, at: '' } })).toContain('last gen 4')
  })

  test('a held lease names the holder', () => {
    const out = renderEpic({ ok: true, run: RUN, lease: { convId: 'conv_abc', gen: 7, at: 'T' } })
    expect(out).toContain('held by conv_abc')
  })

  test('a get carries the digest -- that is what the read is for', () => {
    expect(renderEpic({ ok: true, run: RUN }, 'get')).toContain('two cards landed, one bounced')
  })

  test('a start answers with the status block ALONE -- no digest, at any run status', () => {
    for (const status of ['armed', 'paused', 'running'] as const) {
      const out = renderEpic({ ok: true, run: { ...RUN, status } }, 'start')
      expect(out).not.toContain('two cards landed, one bounced')
      expect(out).not.toContain('## Digest')
    }
  })

  test('a start still reports the state, the caps and the lease -- it is a status block, not silence', () => {
    const out = renderEpic({ ok: true, run: RUN, lease: { convId: 'conv_abc', gen: 7, at: 'T' } }, 'start')
    expect(out).toContain('generation 7/40')
    expect(out).toContain('caps:')
    expect(out).toContain('held by conv_abc')
  })

  test('a start says WHERE the digest went, so the omission is not read as an empty plan', () => {
    expect(renderEpic({ ok: true, run: RUN }, 'start')).toContain('action=get')
  })

  test('the whole start reply stays an order of magnitude under a digest read', () => {
    const long = { ...RUN, digest: 'x'.repeat(6000) }
    expect(renderEpic({ ok: true, run: long }, 'start').length).toBeLessThan(
      renderEpic({ ok: true, run: long }, 'get').length / 10,
    )
  })

  test('an unnamed op renders in full -- verbose is the safe default for a caller that did not say', () => {
    expect(renderEpic({ ok: true, run: RUN })).toContain('## Digest')
  })

  test('an aborted run shows its reason', () => {
    expect(renderEpic({ ok: true, run: { ...RUN, status: 'aborted', abortReason: 'scope changed' } })).toContain(
      'scope changed',
    )
  })
})

describe('inspect', () => {
  test('idleReason LEADS -- it is the answer, the lanes below are only the evidence', () => {
    const out = renderEpic(inspect({ plan: { ...inspect().inspect!.plan!, idleReason: '2 open question(s)' } }))
    const why = out.indexOf('2 open question(s)')
    expect(why).toBeGreaterThan(-1)
    expect(why).toBeLessThan(out.indexOf('## Plan'))
  })

  test('with work ready it says so instead of leaving the section blank', () => {
    const p = inspect().inspect!.plan!
    const out = renderEpic(inspect({ plan: { ...p, dispatch: [{ id: 't1', title: 'do it', status: 'open' }] } }))
    expect(out).toContain('1 card(s) ready to dispatch now')
  })

  test('a waiting card names the dependencies holding it', () => {
    const p = inspect().inspect!.plan!
    const out = renderEpic(
      inspect({
        plan: { ...p, waitingOnDeps: [{ id: 't7', title: 'later', status: 'open', waitingOn: ['t5', 't6'] }] },
      }),
    )
    expect(out).toContain('t7 [open] later <- waiting on t5, t6')
  })

  test('an empty lane says (none) rather than vanishing -- absence must be legible', () => {
    expect(renderEpic(inspect())).toContain('dispatch (0): (none)')
  })

  test('armed NO is SHOUTED, because it means the broker forgot an armed run', () => {
    const l = inspect().inspect!.live
    expect(renderEpic(inspect({ live: { ...l, armed: false } }))).toContain('armed NO')
  })

  test('a generation mismatch is rendered as a WARNING, not buried in a field', () => {
    const l = inspect().inspect!.live
    const out = renderEpic(inspect({ live: { ...l, generationMismatch: 'tagged gen 9 but run.md says 5' } }))
    expect(out).toContain('WARNING: tagged gen 9')
  })

  test('unacknowledged settles are always shown, including when there are none', () => {
    expect(renderEpic(inspect())).toContain('settled but NOT acknowledged by the baton: (none)')
  })

  test('a live conversation is marked LIVE so a dead retry-predecessor is not mistaken for one', () => {
    const l = inspect().inspect!.live
    const out = renderEpic(
      inspect({
        live: {
          ...l,
          conversations: [
            { id: 'conv_a', role: 'werk-worker', cardId: 't1', gen: 7, status: 'active', live: true },
            { id: 'conv_b', role: 'werk-worker', cardId: 't1', gen: 6, status: 'ended', live: false },
          ],
        },
      }),
    )
    expect(out).toContain('conv_a werk-worker t1 gen 7 [active] LIVE')
    expect(out).toContain('conv_b werk-worker t1 gen 6 [ended]')
    expect(out).not.toContain('[ended] LIVE')
  })

  test('no beats says WHY there are none, rather than showing an empty heading', () => {
    expect(renderEpic(inspect())).toContain('has not beaten this epic since it started')
  })

  test('an errored beat surfaces its error', () => {
    const out = renderEpic(
      inspect({
        beats: [{ at: 'T', gen: 3, epicId: 'e1', project: 'p', note: 'tried', actions: 0, spawned: [], error: 'boom' }],
      }),
    )
    expect(out).toContain('ERROR boom')
  })

  test('a missing run artifact is called out explicitly, not rendered as a blank header', () => {
    expect(renderEpic(inspect({ run: null }))).toContain('NO RUN ARTIFACT')
  })
})

/**
 * 2026-08-21, werk-master gen 6 of `epic-project-runner`: a single sentinel timeout
 * rendered a healthy, running, gen-6 epic as `NO RUN ARTIFACT -- never armed`,
 * `lease: free (never run)` and a gen-0 mismatch WARNING. Every one of those
 * three lines is derived from a file the code never managed to read.
 *
 * `NO_RUN` is a DIAGNOSIS ("never armed, or armed on a broker that has since
 * restarted"), and the fix an agent draws from it -- arm the run -- is the exact
 * write that corrupts a live run's caps.
 */
describe('inspect after a FAILED read', () => {
  const failed = (over: Partial<EpicInspectResult> = {}) =>
    inspect({ run: null, lease: null, error: 'sentinel timed out', ...over })

  test('the headline names the READ FAILURE -- a timed-out read has not earned the never-armed diagnosis', () => {
    expect(renderEpic(failed())).not.toContain('NO RUN ARTIFACT')
  })

  test('the error is quoted in the headline, not left as an aside three lines down', () => {
    const out = renderEpic(failed())
    const headline = out.split('\n')[0]
    expect(headline).toContain('sentinel timed out')
  })

  test('the lease is UNKNOWN, not free -- `free (never run)` is a fact about a file nobody read', () => {
    expect(renderEpic(failed())).not.toContain('never run')
  })

  test('the gen-0 WARNING is suppressed -- gen 0 is the parser default for an absent file', () => {
    const l = inspect().inspect!.live
    const out = renderEpic(
      failed({ live: { ...l, generationMismatch: 'conversations tagged gen 6 but run.md says 0' } }),
    )
    expect(out).not.toContain('WARNING')
  })

  test('a CLEAN read with no run keeps today diagnosis -- the never-armed case is real and must survive', () => {
    expect(renderEpic(inspect({ run: null }))).toContain('NO RUN ARTIFACT')
  })

  test('an error alongside a run that DID read is still an aside -- the run header is the true headline', () => {
    const out = renderEpic(inspect({ error: 'baton read partial' }))
    expect(out.split('\n')[0]).toContain('generation 7/40')
    expect(out).toContain('baton read partial')
  })
})

describe('the other shapes', () => {
  test('an empty list says nothing is visible rather than printing a bare count', () => {
    expect(renderEpic({ ok: true, runs: [] })).toContain('No epic runs visible')
  })

  test('a list row carries status, generation and what is in flight', () => {
    const out = renderEpic({
      ok: true,
      runs: [
        {
          epicId: 'e1',
          project: 'p',
          status: 'running',
          gen: 4,
          armed: true,
          inFlight: 2,
          werkMasterAlive: true,
          cleared: null,
          clearedAt: null,
        },
      ],
    })
    expect(out).toContain('e1: running gen 4 . armed yes . 2 in flight . werk-master alive')
  })

  test('a run with no artifact still lists, saying so', () => {
    const out = renderEpic({
      ok: true,
      runs: [
        {
          epicId: 'e1',
          project: 'p',
          status: null,
          gen: 0,
          armed: false,
          inFlight: 0,
          werkMasterAlive: false,
          cleared: null,
          clearedAt: null,
        },
      ],
    })
    expect(out).toContain('no run artifact')
  })

  test('a CLEARED row is still printed, and says when and who buried it', () => {
    const out = renderEpic({
      ok: true,
      runs: [
        {
          epicId: 'e1',
          project: 'p',
          status: 'aborted',
          gen: 4,
          armed: false,
          inFlight: 0,
          werkMasterAlive: false,
          cleared: 'acknowledged',
          clearedAt: '2026-08-19T10:00:00.000Z',
        },
      ],
    })
    // NOT hidden: `list` is how an agent finds a run, and a run nothing can name
    // is a run nothing can resume or abort.
    expect(out).toContain('e1: aborted')
    expect(out).toContain('CLEARED 2026-08-19 (acknowledged')
    expect(out).toContain('(1 cleared, listed last)')
  })

  test('an AGED-OUT row says nobody acknowledged it, which is a different fact', () => {
    const out = renderEpic({
      ok: true,
      runs: [
        {
          epicId: 'e1',
          project: 'p',
          status: 'paused',
          gen: 1,
          armed: false,
          inFlight: 0,
          werkMasterAlive: false,
          cleared: 'aged-out',
          clearedAt: '2026-07-01T10:00:00.000Z',
        },
      ],
    })
    expect(out).toContain('CLEARED 2026-07-01 (aged out')
  })

  test('a list with nothing buried does not print a cleared count at all', () => {
    const out = renderEpic({
      ok: true,
      runs: [
        {
          epicId: 'e1',
          project: 'p',
          status: 'running',
          gen: 1,
          armed: true,
          inFlight: 1,
          werkMasterAlive: true,
          cleared: null,
          clearedAt: null,
        },
      ],
    })
    expect(out).toContain('1 epic run(s):')
    expect(out).not.toContain('CLEARED')
  })

  test('a beat reports what it spawned', () => {
    const out = renderEpic({ ok: true, beat: { note: 'dispatched 1', actions: 1, spawned: ['conv_x'] } })
    expect(out).toContain('spawned: conv_x')
  })

  test('a beat that spawned nothing does not print an empty spawned line', () => {
    expect(renderEpic({ ok: true, beat: { note: 'idle', actions: 0, spawned: [] } })).not.toContain('spawned:')
  })

  test('a bare note (break_lease) is passed straight through', () => {
    expect(renderEpic({ ok: true, note: 'released the lease held by conv_a' })).toBe(
      'released the lease held by conv_a',
    )
  })
})

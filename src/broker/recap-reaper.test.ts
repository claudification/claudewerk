import { describe, expect, it } from 'bun:test'
import { startRecapReaper } from './recap-reaper'

function fakeOrchestrator() {
  const calls = { reap: 0, prune: 0 }
  return {
    calls,
    reapStale() {
      calls.reap++
      return [{ id: 'recap_x', prevStatus: 'rendering' as const, ageMs: 999_999 }]
    },
    pruneBundles() {
      calls.prune++
      return ['recap_old']
    },
  }
}

describe('startRecapReaper', () => {
  it('sweeps immediately on start (reap + first prune)', () => {
    const orch = fakeOrchestrator()
    const t = 0
    const { stop } = startRecapReaper({ orchestrator: orch, now: () => t })
    expect(orch.calls.reap).toBe(1)
    expect(orch.calls.prune).toBe(1) // lastPruneAt starts at -Inf -> first sweep always prunes
    stop()
  })

  it('reaps every sweep but prunes at most once per hour', () => {
    const orch = fakeOrchestrator()
    let t = 0
    const { stop, sweep } = startRecapReaper({ orchestrator: orch, now: () => t })
    // boot sweep already ran once (t=0): prune fired (0 - 0 >= 3.6M is false actually)
    const bootReap = orch.calls.reap
    const bootPrune = orch.calls.prune
    // Advance 10 min, sweep again -> reap fires, prune does NOT (under 1h).
    t = 10 * 60_000
    sweep()
    expect(orch.calls.reap).toBe(bootReap + 1)
    expect(orch.calls.prune).toBe(bootPrune)
    // Advance past 1h from the last prune -> prune fires again.
    t = 61 * 60_000
    sweep()
    expect(orch.calls.reap).toBe(bootReap + 2)
    expect(orch.calls.prune).toBe(bootPrune + 1)
    stop()
  })

  it('swallows a sweep crash so the interval survives', () => {
    const t = 0
    const throwing = {
      reapStale(): never {
        throw new Error('boom')
      },
      pruneBundles() {
        return []
      },
    }
    // Boot sweep runs synchronously inside start; it must not throw out.
    expect(() => startRecapReaper({ orchestrator: throwing, now: () => t }).stop()).not.toThrow()
  })
})

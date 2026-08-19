/**
 * The tick both WERK triggers run on. The epic sweep had a reentrancy guard and
 * the nightshift guardians had none; making the loop a primitive is what stops
 * that being a matter of whether someone remembered.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { markEngineBoot, RESTART_QUARANTINE_MS, resetEngineBoot } from './werk-engine-boot'
import { startWerkTick, type WerkTickOptions } from './werk-tick'

let log: string[]
let ran: number
let always: number
let release: (() => void) | null

function opts(over: Partial<WerkTickOptions> = {}): WerkTickOptions {
  return {
    tag: '[test]',
    // Far longer than any test takes: every case drives `once` by hand, so the
    // timer never fires and cannot make a case flaky.
    intervalMs: 3_600_000,
    run: async () => {
      ran++
      if (release) await new Promise<void>(r => (release = r))
    },
    log: line => log.push(line),
    now: () => 0,
    always: async () => {
      always++
    },
    ...over,
  }
}

beforeEach(() => {
  log = []
  ran = 0
  always = 0
  release = null
  resetEngineBoot()
})

afterEach(() => resetEngineBoot())

describe('startWerkTick', () => {
  test('runs the work and reports that it ran', async () => {
    const tick = startWerkTick(opts())
    expect(await tick.once()).toBe('ran')
    expect(ran).toBe(1)
    tick.stop()
  })

  test('REFUSES to overlap -- the second tick is skipped while the first is in flight', async () => {
    release = () => {}
    const tick = startWerkTick(opts())
    const first = tick.once()
    await Promise.resolve()

    expect(await tick.once()).toBe('busy')
    expect(log.join('\n')).toContain('previous tick still running')

    release?.()
    await first
    expect(ran).toBe(1)
    tick.stop()
  })

  test('releases the guard afterwards', async () => {
    const tick = startWerkTick(opts())
    await tick.once()
    await tick.once()
    expect(ran).toBe(2)
    tick.stop()
  })

  test('releases the guard even when the work THROWS -- a crash must not wedge the loop', async () => {
    const tick = startWerkTick(
      opts({
        run: async () => {
          ran++
          throw new Error('sentinel exploded')
        },
      }),
    )
    expect(await tick.once()).toBe('ran')
    expect(log.join('\n')).toContain('sentinel exploded')
    await tick.once()
    expect(ran).toBe(2)
    tick.stop()
  })

  test('holds inside the restart quarantine and does no work', async () => {
    markEngineBoot(0)
    const tick = startWerkTick(opts({ now: () => 60_000 }))
    expect(await tick.once()).toBe('quarantined')
    expect(ran).toBe(0)
    expect(log.join('\n')).toContain('restart quarantine')
    tick.stop()
  })

  test('runs the moment the quarantine closes', async () => {
    markEngineBoot(0)
    const tick = startWerkTick(opts({ now: () => RESTART_QUARANTINE_MS }))
    expect(await tick.once()).toBe('ran')
    tick.stop()
  })

  /** A held engine must still reach the panel, or WAITING looks like DEAD. */
  test('the always-hook fires on a quarantined tick too', async () => {
    markEngineBoot(0)
    const tick = startWerkTick(opts({ now: () => 1_000 }))
    await tick.once()
    expect(always).toBe(1)
    tick.stop()
  })

  test('the always-hook fires after a normal tick', async () => {
    const tick = startWerkTick(opts())
    await tick.once()
    expect(always).toBe(1)
    tick.stop()
  })

  test('stop() ends the loop and says so', () => {
    startWerkTick(opts()).stop()
    expect(log.join('\n')).toContain('[test] stopped')
  })
})

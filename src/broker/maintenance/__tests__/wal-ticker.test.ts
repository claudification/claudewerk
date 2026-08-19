import { expect, test } from 'bun:test'
import { startWalTicker, WAL_THRESHOLD_BYTES, WAL_TICK_MS } from '../wal-ticker'

const MB = 1024 * 1024

interface Harness {
  logs: string[]
  calls: string[]
  ticker: ReturnType<typeof startWalTicker>
}

/** Drives the ticker with a scripted sequence of WAL sizes so a tick is a pure
 *  function of the fixture -- no timers, no real database. */
function harness(sizes: number[], checkpoint?: (cacheDir: string) => string): Harness {
  const logs: string[] = []
  const calls: string[] = []
  let i = 0
  const ticker = startWalTicker({
    cacheDir: '/nowhere',
    // Far enough out that the interval never fires during a test; every test
    // drives tick() by hand.
    intervalMs: 60 * 60_000,
    log: m => logs.push(m),
    walSize: () => sizes[Math.min(i++, sizes.length - 1)],
    checkpoint:
      checkpoint ??
      (dir => {
        calls.push(dir)
        return 'checkpointed 42 frames, 0 in log, WAL truncated -- WAL 900.0 MB -> 0.0 MB (reclaimed 900.0 MB)'
      }),
  })
  return { logs, calls, ticker }
}

test('does nothing while the WAL is below the threshold', () => {
  const h = harness([4 * MB])
  h.ticker.tick()

  expect(h.calls).toHaveLength(0)
  expect(h.logs.some(l => l.includes('below threshold, skipping'))).toBe(true)
  h.ticker.stop()
})

test('truncates once the WAL crosses the threshold', () => {
  // First read is the pre-check (over), second is the post-checkpoint size.
  const h = harness([900 * MB, 0])
  h.ticker.tick()

  expect(h.calls).toEqual(['/nowhere'])
  expect(h.logs.some(l => l.includes('OVER, checkpointing'))).toBe(true)
  expect(h.logs.some(l => l.includes('reclaimed 900.0 MB'))).toBe(true)
  h.ticker.stop()
})

test('logs the size it saw on EVERY tick, acting or not', () => {
  const h = harness([4 * MB])
  h.ticker.tick()

  // A ticker that only logs when it acts cannot be told apart from one that
  // never ran -- which is exactly the state the nightly job was in.
  const tickLine = h.logs.find(l => l.includes('tick=1'))
  expect(tickLine).toContain('wal=4.0 MB')
  expect(tickLine).toContain('threshold=256.0 MB')
  h.ticker.stop()
})

test('survives a failing checkpoint and says so, leaving the next tick to retry', () => {
  const h = harness([900 * MB, 900 * MB], () => {
    throw new Error('database is locked')
  })
  expect(() => h.ticker.tick()).not.toThrow()

  const failure = h.logs.find(l => l.includes('FAILED'))
  expect(failure).toContain('database is locked')
  expect(failure).toContain('retrying next tick')
  h.ticker.stop()
})

test('a busy checkpoint is reported, not treated as an error', () => {
  // SQLite reports busy and changes nothing; there is no failure to recover
  // from, so the detail is carried through verbatim.
  const h = harness([900 * MB, 900 * MB], () => 'busy=1 -- readers held the WAL open, checkpoint incomplete')
  h.ticker.tick()

  expect(h.logs.some(l => l.includes('busy=1'))).toBe(true)
  expect(h.logs.some(l => l.includes('FAILED'))).toBe(false)
  h.ticker.stop()
})

test('counts ticks so the log can be read as a timeline', () => {
  const h = harness([1 * MB, 2 * MB, 3 * MB])
  h.ticker.tick()
  h.ticker.tick()
  h.ticker.tick()

  expect(h.logs.some(l => l.includes('tick=3'))).toBe(true)
  h.ticker.stop()
  expect(h.logs.some(l => l.includes('stopped after 3 ticks'))).toBe(true)
})

test('stop() halts the interval', () => {
  const h = harness([1 * MB])
  h.ticker.stop()
  expect(h.logs.some(l => l.includes('stopped'))).toBe(true)
})

test('ships with the agreed defaults', () => {
  expect(WAL_TICK_MS).toBe(15 * 60_000)
  expect(WAL_THRESHOLD_BYTES).toBe(256 * MB)
})

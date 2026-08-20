#!/usr/bin/env bun
/**
 * Repro harness for case A of `src/shared/bun-contract/fs-watch.contract.test.ts`:
 * watch fileA, close that watcher, watch a DIFFERENT file in the SAME directory,
 * and see whether the new watcher ever fires.
 *
 * Built for card `werk-fs-watch-contract-test-timeout-guillotine`. Its sibling
 * `werk-fs-watch-contract-flake-under-load` characterised case B (bun reports a
 * STALE FILENAME for the second file in a watched directory) and explicitly left
 * case A uncharacterised, even though A is the MORE frequent flake -- 2 of 13
 * full-suite runs vs B's 1 of 13. A's failures had only ever been seen as the
 * runner's 5s guillotine, which fires before the assertion's own budget is spent,
 * so the output could not say whether bun dropped the event or stage 1 was slow.
 * This harness answers that by observation. See the paired
 * `fswatch-rewatch-same-dir-repro.results.md` for the measured numbers.
 *
 * A cannot be the stale-filename defect: A counts callback invocations and never
 * reads the reported name, so a wrong name still passes. If A fails, the callback
 * genuinely did not fire.
 *
 * Per iteration: fresh temp dir, `a.jsonl` + `b.jsonl`, watch a, append to a,
 * wait for the hit, close, watch b, append to b, wait for THAT hit. Every
 * callback is logged with its arrival time, watcher, event type and filename.
 *
 *   bun scripts/fswatch-rewatch-same-dir-repro.ts [iterations]     # default 100
 *
 * `LATE_BUDGET_MS` separates "late" from "never": once the normal 5000ms budget
 * is gone the harness keeps waiting to 25000ms, because "the budget was too
 * tight" and "the watcher is dead" need different fixes and only one of them is
 * fixable by a number.
 *
 * Use >=600 iterations before concluding anything: on a quiet box case A fails
 * around 0.3%, so 100 iterations regularly returns a clean zero by luck. The
 * loaded arm is what the full suite actually looks like:
 *
 *   seq 1 10 | xargs -P 10 -I{} bun scripts/fswatch-rewatch-same-dir-repro.ts 100
 *
 * To test another bun without re-runtiming the fleet -- ~48 agent hosts and the
 * sentinel launch via `#!/usr/bin/env bun`, so do NOT upgrade the global one:
 *
 *   /path/to/bun-1.4 scripts/fswatch-rewatch-same-dir-repro.ts 600
 */
import { watch } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What the contract test declares. A hit after this is a test failure. */
const BUDGET_MS = 5_000

/** How much longer to keep listening once the budget is blown, to tell late from never. */
const LATE_BUDGET_MS = 25_000

/**
 * Milliseconds to let the FIRST watcher settle before writing to the file it
 * watches. The contract test writes immediately, with no settle -- which is the
 * arm this defaults to, so the harness reproduces the test rather than a
 * friendlier version of it.
 *
 * The second arm exists because the first observed failures were all `w1` never
 * firing at all, never the re-watch. That points at an ARMING RACE rather than a
 * dropped event, and the only way to tell those apart is to vary the settle and
 * watch the rate move:
 *
 *   SETTLE_MS=50 bun scripts/fswatch-rewatch-same-dir-repro.ts 600
 */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 0)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return false
}

type Outcome =
  | 'ok'
  /** Stage 1 never fired -- the FIRST watcher is the broken one, not the re-watch. */
  | 'first-never'
  /** The re-watch fired, but only after the contract's 5000ms budget. */
  | 'second-late'
  /** The re-watch never fired, verified out to LATE_BUDGET_MS. */
  | 'second-never'

interface Iteration {
  outcome: Outcome
  /** ms from the append to a.jsonl until the first watcher fired, or -1. */
  firstLatencyMs: number
  /** ms from the append to b.jsonl until the re-watch fired, or -1 if it never did. */
  secondLatencyMs: number
  events: string[]
}

async function runIteration(): Promise<Iteration> {
  const dir = await mkdtemp(join(tmpdir(), 'bun-fswatch-rewatch-'))
  const started = performance.now()
  const at = (): number => Number((performance.now() - started).toFixed(1))

  const events: string[] = []
  const a = join(dir, 'a.jsonl')
  const b = join(dir, 'b.jsonl')
  const watchers: Array<{ close: () => void }> = []

  try {
    await writeFile(a, '')
    await writeFile(b, '')

    let aHits = 0
    const w1 = watch(a, (event, filename) => {
      events.push(`${at()}ms w1 ${event}:${filename}`)
      aHits++
    })
    watchers.push(w1)
    if (SETTLE_MS > 0) await sleep(SETTLE_MS)

    const wroteFirstAt = at()
    events.push(`${wroteFirstAt}ms append a.jsonl`)
    await appendFile(a, 'one\n')
    const sawFirst = await waitFor(() => aHits > 0, BUDGET_MS)
    const firstLatencyMs = sawFirst ? Number((at() - wroteFirstAt).toFixed(1)) : -1
    if (!sawFirst) {
      return { outcome: 'first-never', firstLatencyMs: -1, secondLatencyMs: -1, events }
    }

    // The contract: close the first FILE watcher, then watch a DIFFERENT file in
    // the SAME directory. This is /clear + compaction minting a new transcript.
    w1.close()
    events.push(`${at()}ms w1.close()`)

    let bHits = 0
    const w2 = watch(b, (event, filename) => {
      events.push(`${at()}ms w2 ${event}:${filename}`)
      bHits++
    })
    watchers.push(w2)
    await sleep(50)

    const wroteSecondAt = at()
    events.push(`${wroteSecondAt}ms append b.jsonl`)
    await appendFile(b, 'two\n')

    if (await waitFor(() => bHits > 0, BUDGET_MS)) {
      return {
        outcome: 'ok',
        firstLatencyMs,
        secondLatencyMs: Number((at() - wroteSecondAt).toFixed(1)),
        events,
      }
    }

    // Blown the contract's budget. Keep listening: late and never are different bugs.
    const eventuallySaw = await waitFor(() => bHits > 0, LATE_BUDGET_MS)
    return {
      outcome: eventuallySaw ? 'second-late' : 'second-never',
      firstLatencyMs,
      secondLatencyMs: eventuallySaw ? Number((at() - wroteSecondAt).toFixed(1)) : -1,
      events,
    }
  } finally {
    for (const w of watchers) {
      try {
        w.close()
      } catch {}
    }
    await rm(dir, { recursive: true, force: true })
  }
}

const iterations = Number(process.argv[2] ?? 100)
if (!Number.isFinite(iterations) || iterations < 1) {
  console.error(`usage: bun scripts/fswatch-rewatch-same-dir-repro.ts [iterations]  (got ${process.argv[2]})`)
  process.exit(2)
}

const firstLatencies: number[] = []
const secondLatencies: number[] = []
const tally: Record<Outcome, number> = { ok: 0, 'first-never': 0, 'second-late': 0, 'second-never': 0 }

for (let i = 0; i < iterations; i++) {
  const result = await runIteration()
  tally[result.outcome]++
  if (result.outcome === 'ok') {
    firstLatencies.push(result.firstLatencyMs)
    secondLatencies.push(result.secondLatencyMs)
    continue
  }
  const how = result.secondLatencyMs >= 0 ? `arrived at ${result.secondLatencyMs}ms` : 'never arrived'
  console.log(`iter ${i}: FAIL ${result.outcome}  ${how}  events=[${result.events.join(' | ')}]`)
}

const range = (xs: number[]): string =>
  xs.length > 0 ? `${Math.min(...xs)}-${Math.max(...xs)}ms over ${xs.length}` : 'no samples'

const failures = iterations - tally.ok
console.log(
  `\n${failures}/${iterations} failed (${((failures / iterations) * 100).toFixed(1)}%) on bun ${Bun.version} (${Bun.revision.slice(0, 8)}), SETTLE_MS=${SETTLE_MS}`,
)
console.log(
  `  first-never ${tally['first-never']}  second-late ${tally['second-late']}  second-never ${tally['second-never']}`,
)
console.log(`healthy a.jsonl latency ${range(firstLatencies)}`)
console.log(`healthy b.jsonl latency ${range(secondLatencies)}`)

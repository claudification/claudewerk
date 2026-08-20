#!/usr/bin/env bun
/**
 * Repro harness for the bun macOS `fs.watch` STALE FILENAME defect.
 *
 * Built for card `werk-fs-watch-contract-flake-under-load`, which asked which of
 * two hypotheses explained `src/shared/bun-contract/fs-watch.contract.test.ts`
 * case B failing in the full suite and passing alone:
 *
 *   H1 -- the 5000ms latency budget is too tight under suite contention.
 *   H2 -- bun's `fs.watch` genuinely mishandles the second file.
 *
 * This harness settled it as H2 by OBSERVATION rather than by a green run, which
 * is why it is committed rather than thrown away: the finding is a rate, and a
 * rate cannot be re-derived from a single pass/fail. See the paired
 * `fswatch-stale-filename-repro.results.md` for the measured numbers.
 *
 * What it does, per iteration: watch a fresh temp dir, create `first.jsonl`, wait
 * for its filename to arrive, create `second.jsonl`, wait for ITS filename. Then
 * record whether the second name ever arrived and what arrived instead.
 *
 * The defect: ~3% of iterations the second creation DOES fire a callback, on time
 * (~30-50ms, same as the healthy path), carrying the PREVIOUS file's name.
 * `second.jsonl` is never reported -- not late, never. Event count stays exactly
 * right, so this is name resolution and not a dropped event.
 *
 *   bun scripts/fswatch-stale-filename-repro.ts [iterations]     # default 100
 *
 * Use >=300 iterations before concluding a bun version is fixed: at a ~3% rate a
 * 100-iteration run shows zero by luck often enough to mislead, which is exactly
 * how the original card acquired its (wrong) "passes alone" premise.
 *
 * To test another bun without re-runtiming the fleet -- ~48 agent hosts and the
 * sentinel launch via `#!/usr/bin/env bun`, so do NOT upgrade the global one:
 *
 *   /path/to/bun-1.4 scripts/fswatch-stale-filename-repro.ts 300
 */
import { watch } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long to wait for a filename before calling it never. 100x the healthy ~40ms. */
const ARRIVAL_BUDGET_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return false
}

interface Iteration {
  ok: boolean
  /** ms from the write of second.jsonl to its filename arriving, or -1 if it never did. */
  secondLatencyMs: number
  events: string[]
}

async function runIteration(): Promise<Iteration> {
  const dir = await mkdtemp(join(tmpdir(), 'bun-fswatch-repro-'))
  const t0 = performance.now()
  const at = (): number => Number((performance.now() - t0).toFixed(1))

  const events: string[] = []
  const seen = new Set<string>()
  const watcher = watch(dir, (event, filename) => {
    events.push(`${at()}ms ${event}:${filename}`)
    if (filename) seen.add(String(filename))
  })

  try {
    // Let the watcher arm before generating anything for it to miss.
    await sleep(50)

    await writeFile(join(dir, 'first.jsonl'), '')
    await appendFile(join(dir, 'first.jsonl'), 'x\n')
    const sawFirst = await waitFor(() => seen.has('first.jsonl'), ARRIVAL_BUDGET_MS)

    // The /clear scenario: a second transcript minted in the SAME directory.
    const wroteSecondAt = at()
    await writeFile(join(dir, 'second.jsonl'), '')
    await appendFile(join(dir, 'second.jsonl'), 'y\n')
    const sawSecond = await waitFor(() => seen.has('second.jsonl'), ARRIVAL_BUDGET_MS)

    return {
      ok: sawFirst && sawSecond,
      secondLatencyMs: sawSecond ? Number((at() - wroteSecondAt).toFixed(1)) : -1,
      events,
    }
  } finally {
    try {
      watcher.close()
    } catch {}
    await rm(dir, { recursive: true, force: true })
  }
}

const iterations = Number(process.argv[2] ?? 100)
if (!Number.isFinite(iterations) || iterations < 1) {
  console.error(`usage: bun scripts/fswatch-stale-filename-repro.ts [iterations]  (got ${process.argv[2]})`)
  process.exit(2)
}

const latencies: number[] = []
let failures = 0

for (let i = 0; i < iterations; i++) {
  const result = await runIteration()
  if (result.ok) {
    latencies.push(result.secondLatencyMs)
    continue
  }
  failures++
  console.log(`iter ${i}: FAIL  second never named  events=[${result.events.join(' | ')}]`)
}

const rate = ((failures / iterations) * 100).toFixed(1)
const healthy =
  latencies.length > 0
    ? `healthy second.jsonl latency ${Math.min(...latencies)}-${Math.max(...latencies)}ms over ${latencies.length} ok iterations`
    : 'no successful iterations'

console.log(`\n${failures}/${iterations} failed (${rate}%) on bun ${Bun.version} (${Bun.revision.slice(0, 8)})`)
console.log(healthy)

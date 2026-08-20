/**
 * CONTRACT: fs.watch behavior -- the decider for dropping chokidar.
 *
 * transcript-watcher.ts uses chokidar + a 500ms poll to dodge a Bun macOS
 * fs.watch bug: "closing a file watcher and starting a new one on a different
 * file in the same directory causes events to silently stop" (triggered by
 * /clear + compaction minting new transcript JSONLs). Bun 1.3.14 rewrote the
 * fs.watch backend. These tests pin the behavior we'd need before swapping
 * chokidar for native fs.watch.
 *
 *  A) THE BUG: watch fileA, close, watch fileB in same dir -> does B still fire?
 *  B) MIGRATION TARGET: directory watch sees create + change for two files
 *     (the /clear scenario) -- the native replacement for chokidar dir-watch.
 *  C) BURSTY WRITES (informational): the watcher survives a write burst and
 *     still fires afterward -- informs whether the 500ms poll net can go.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { watch } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep, waitFor } from './_helpers'

/**
 * Per-test timeout, in place of bun's 5000ms default.
 *
 * That default is the SAME number as `waitFor()`'s default budget in
 * `_helpers.ts`, and every test below chains TWO `waitFor` calls plus `sleep()`s.
 * So the second `waitFor` in each test could never spend what it declares -- its
 * real budget was `5000ms - (whatever stage 1 took) - sleeps`, undeclared and
 * different every run. When it blew, the runner guillotined the test at ~5002ms
 * and the orphaned `waitFor` promise then rejected with nobody listening, which
 * is why one failing test reported as `1 fail` AND `1 error` at `_helpers.ts:21`.
 * Worse, the wall fired BEFORE the assertion's own budget was spent, so the
 * output could not distinguish "bun dropped the event" from "stage 1 was slow".
 *
 * 12s covers the worst declared path (5000 + 5000 + 150ms of sleeps) with room
 * for teardown. This does not weaken any contract: the `waitFor` budgets stay at
 * 5000ms, they just become reachable, so a failure now means the assertion
 * failed rather than the runner ran out of patience.
 */
const TEST_TIMEOUT_MS = 12_000

let dir = ''
const watchers: Array<{ close: () => void }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bun-fswatch-'))
})
afterEach(async () => {
  for (const w of watchers.splice(0)) {
    try {
      w.close()
    } catch {}
  }
  await rm(dir, { recursive: true, force: true })
})

describe('fs.watch contract', () => {
  test(
    'A) file watcher: close one, open another in same dir -- new one still fires',
    async () => {
      const a = join(dir, 'a.jsonl')
      const b = join(dir, 'b.jsonl')
      await writeFile(a, '')
      await writeFile(b, '')

      // Instrumentation. A) fails ~0.3-2% of the time, and a bare "bHits was 0"
      // says nothing about WHY -- so record every event's arrival time, watcher,
      // type and reported filename, and attach the log to whichever `waitFor`
      // blows. The signature that tells the two candidate defects apart:
      // events present but late = latency, no w2 event at all = a dead watcher.
      // (Case B's defect is a STALE FILENAME, which A cannot see: A counts hits
      // and never reads the name. So a log with a w2 event in it means A is not
      // that bug.)
      const started = performance.now()
      const events: string[] = []
      const at = (): string => (performance.now() - started).toFixed(1)
      const note = (what: string): void => {
        events.push(`${at()}ms ${what}`)
      }
      const withLog = async (body: Promise<void>): Promise<void> => {
        try {
          await body
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`${message}\n  fs.watch log: [${events.join(' | ')}]`)
        }
      }

      let aHits = 0
      const w1 = watch(a, (event, filename) => {
        note(`w1 ${event}:${filename}`)
        aHits++
      })
      watchers.push(w1)
      // Let w1 arm before writing to the file it watches. `fs.watch` arms
      // asynchronously, and without this the append landed ~0.3ms later and was
      // simply never reported ~3% of the time (7.5% under 10-way load), blowing
      // stage 1 before the close-and-re-watch this test exists to pin was
      // reached at all. Measured over 2600 iterations with
      // `scripts/fswatch-rewatch-same-dir-repro.ts`: 95 of 95 failures produced
      // ZERO events, and SETTLE_MS=50 took both arms to 0. The re-watch below
      // and cases B and C already settle; A alone did not, which is what made it
      // the file's most frequent flake.
      await sleep(50)
      note('append a.jsonl')
      await appendFile(a, 'one\n')
      await withLog(waitFor(() => aHits > 0, { label: 'fileA change' }))

      // Close the first file watcher, then watch a DIFFERENT file in the SAME dir.
      w1.close()
      note('w1.close()')

      let bHits = 0
      const w2 = watch(b, (event, filename) => {
        note(`w2 ${event}:${filename}`)
        bHits++
      })
      watchers.push(w2)
      await sleep(50)
      note('append b.jsonl')
      await appendFile(b, 'two\n')

      // The bug: bHits stays 0. The fix: it fires.
      await withLog(waitFor(() => bHits > 0, { label: 'fileB change after re-watch in same dir' }))
      expect(bHits).toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'B) directory watch: create + change for two files (the /clear scenario)',
    async () => {
      const seen = new Set<string>()
      const w = watch(dir, (_event, filename) => {
        if (filename) seen.add(String(filename))
      })
      watchers.push(w)
      await sleep(50)

      // First transcript.
      await writeFile(join(dir, 'first.jsonl'), '')
      await appendFile(join(dir, 'first.jsonl'), 'x\n')
      await waitFor(() => seen.has('first.jsonl'), { label: 'first.jsonl seen' })

      // /clear mints a second transcript in the SAME dir -- the dir watcher must
      // keep firing for it.
      await writeFile(join(dir, 'second.jsonl'), '')
      await appendFile(join(dir, 'second.jsonl'), 'y\n')
      await waitFor(() => seen.has('second.jsonl'), { label: 'second.jsonl seen after rotation' })

      expect(seen.has('first.jsonl')).toBe(true)
      expect(seen.has('second.jsonl')).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'C) bursty writes: watcher survives a burst and still fires afterward (informational)',
    async () => {
      const f = join(dir, 'burst.jsonl')
      await writeFile(f, '')
      let hits = 0
      const w = watch(dir, (_e, filename) => {
        if (String(filename) === 'burst.jsonl') hits++
      })
      watchers.push(w)
      await sleep(50)

      for (let i = 0; i < 25; i++) await appendFile(f, `line ${i}\n`)
      // fs.watch coalesces -- we do NOT assert one-event-per-append (that is why
      // transcript-watcher.ts re-stats after each read). We assert the watcher is
      // alive: at least one event fired, and a later write still triggers one.
      await waitFor(() => hits > 0, { label: 'burst produced >=1 event' })
      const afterBurst = hits

      await sleep(100)
      await appendFile(f, 'final\n')
      await waitFor(() => hits > afterBurst, { label: 'post-burst write still fires' })
      expect(hits).toBeGreaterThan(afterBurst)
    },
    TEST_TIMEOUT_MS,
  )
})

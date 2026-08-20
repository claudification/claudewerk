# bun macOS `fs.watch` stale-filename defect -- measured results

Harness: `scripts/fswatch-stale-filename-repro.ts`\
Runtime: bun **1.3.14**, revision `0d9b296a`, macOS (Darwin 25.5.0), 10 cores\
Measured: 2026-08-21, from card `werk-fs-watch-contract-flake-under-load` at main `be099cac`

## Verdict

The card offered two hypotheses for why `src/shared/bun-contract/fs-watch.contract.test.ts`
case B fails in the full suite and passes alone:

- **H1** -- the 5000ms latency budget is too tight under suite contention.
- **H2** -- bun's `fs.watch` genuinely mishandles the second file.

**H2, decisively.** H1 is ruled out by three orders of magnitude, see below.

## The defect

Watch a directory, create `first.jsonl`, wait for its filename, create `second.jsonl`.
On failure the watcher fires for the second creation **on time**, carrying the
**previous file's name**:

```
 55.5ms rename:first.jsonl     <- first.jsonl created      (correct)
105.6ms rename:first.jsonl     <- second.jsonl created     (STALE NAME)
```

`second.jsonl` is never reported. Not late -- never, verified out to 25 000 ms.

Signature stability across every arm below: **46 of 46** failures produced exactly two
events, both named `first.jsonl`. Never a dropped event, never a different wrong name.
The event count is always correct, so this is **name resolution**, not lost events.

## Why H1 is dead

Instrumented case B across 10 consecutive full-suite runs, recording the arrival time of
every filename event:

| runs | `second.jsonl` arrival |
|---|---|
| 9 of 10 | 29.0 – 40.7 ms after the write |
| 1 of 10 | never, at 25 000 ms |

The healthy path is ~40 ms against a 5 000 ms budget -- the budget was never tight, it is
120x the worst healthy observation. The failure is binary, not a long tail, so no timeout
value fixes it. Raising the budget would not have rescued the failing run.

## Rate, and the role of load

Controlled back-to-back on the same box:

| arm | iterations | failures | rate |
|---|---|---|---|
| A -- 1 process, sequential | 600 | 2 | **0.33 %** |
| B -- 10 concurrent processes | 1000 | 28 | **2.8 %** |

Contention raises the rate roughly 8x but is **not required** -- it fires on an
otherwise-quiet box too. A single quiet 300-iteration run returned 0/300, so treat any
one clean run as meaningless: budget >=300 iterations, ideally under arm B, before
believing a bun version is fixed.

Full-suite incidence at the observed rate: case B failed 1 of 10 runs.

## Consequences

- **"Watch the parent dir and filter by filename" is unsound on this bun.** Filtering by
  filename is exactly what breaks. That was the previously documented mitigation and it
  has been corrected.
- **Do not swap chokidar for native `fs.watch`.** That is the decision
  `fs-watch.contract.test.ts` gates, and the gate is red. `transcript-watcher.ts` is safe
  only because chokidar re-stats instead of trusting the reported name, plus its 500ms
  poll net.
- Any `fs.watch(dir, cb)` consumer must treat `filename` as a hint and re-stat or re-list,
  never as an identity.

## Incidental finding, not fixed here

`bun test`'s default per-test timeout is **5000ms** -- the same number as `waitFor`'s
default in `src/shared/bun-contract/_helpers.ts`. Any test chaining two `waitFor` calls
therefore gets guillotined by the runner at ~5002 ms before the second call can spend its
declared budget, and the orphaned `waitFor` then rejects unowned. That is why one failing
test reports as `1 fail` **and** `1 error` at `_helpers.ts:21` -- the error is an echo of
the same failure, not a second defect.

Case A of the same file also failed 1 of 10 runs, at 5005.58 ms, i.e. on that guillotine.
It was **not** characterised: the wall fires before the assertion's own budget is spent,
so the output cannot distinguish a real dropped event from a slow first stage. Tracked
separately in card `werk-fs-watch-contract-test-timeout-guillotine`.

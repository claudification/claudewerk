# fs.watch contract case A -- what its flake actually is

Harness: `scripts/fswatch-rewatch-same-dir-repro.ts`\
Runtime: bun **1.3.14**, revision `0d9b296a`, macOS (Darwin 25.5.0), 10 cores\
Measured: 2026-08-21, from card `werk-fs-watch-contract-test-timeout-guillotine` at main `1fed88bb`

## Verdict

Case A of `src/shared/bun-contract/fs-watch.contract.test.ts` is **not** the
stale-filename defect that case B catches, and it is **not** a latency problem. It is an
**arming race in the test's own setup**: the test writes to `a.jsonl` within ~0.3 ms of
`watch(a, ...)` returning, and roughly 3 % of the time the watcher is not live yet, so
that write is never reported. The failure happens in stage 1, **before** the re-watch the
test exists to pin is ever exercised.

Case A could never have been the stale-filename bug: it counts callback invocations and
never reads the reported name, so a wrong name still passes it.

## The signature

Every observed failure is identical. The event log contains the write and **nothing
else** -- no callback ever fired, from either watcher:

```
iter 100: FAIL first-never  never arrived  events=[0.2ms append a.jsonl]
```

**95 of 95** failures across every arm below produced zero events. Not one produced a
late event, a wrong-named event, or a failure in the second stage. `second-late` and
`second-never` are 0 everywhere.

## The controlled experiment

The only variable is `SETTLE_MS`: how long the first watcher gets to arm before the file
it watches is written. Both sequential arms ran concurrently with each other, so they
carried identical load.

| arm | `SETTLE_MS` | iterations | failures | rate |
|---|---|---|---|---|
| 1 process, sequential | **0** (what the test does) | 600 | 20 | **3.3 %** |
| 1 process, sequential | 50 | 600 | 0 | **0 %** |
| 10 concurrent processes | **0** | 1000 | 75 | **7.5 %** |
| 10 concurrent processes | 50 | 1000 | 0 | **0 %** |

2600 iterations, 95 failures, every one of them in the no-settle arms. The loaded no-settle
arm's ten processes individually ranged 4 % – 11 %. Contention roughly doubles the rate; it
does not create the defect, and 50 ms of settle removes it under both loads. (Each pair of
arms ran at the same time as each other, so the box carried 2 and 20 concurrent processes
respectively -- the loaded arm is therefore harsher than the real suite, which is 10x
parallel.)

Healthy latencies, for whoever needs to tell a regression from contention:

| | `a.jsonl` (stage 1) | `b.jsonl` (the re-watch) |
|---|---|---|
| settled | 0.1 – 21.8 ms | 5.1 – 51.4 ms |
| unsettled | 5.1 – 282 ms | 5.2 – 39.5 ms |

The re-watch -- the thing case A is actually about -- is healthy in all 2600 iterations.
The `282 ms` outlier is the arming delay showing up as latency in a run that got away with
it.

## Why this was invisible until now

`bun test`'s default per-test timeout is 5000 ms, the same number as `waitFor()`'s default
budget in `_helpers.ts`. Case A's stage-1 `waitFor` therefore blew at the same instant the
runner guillotined the test, so the only evidence was `died at 5005.58ms` -- which cannot
distinguish "bun dropped the event" from "stage 1 was slow and ate the budget". Both
failures the sibling card observed presented that way and were left uncharacterised.

With the explicit 12 s per-test timeout and the event log now in the test, the same failure
reports as:

```
error: waitFor timed out after 5000ms waiting for: fileA change
  fs.watch log: [0.3ms append a.jsonl]
```

An empty log means the watcher never armed. A log with a `w2` event in it would mean
something else entirely.

## What to do about it -- DONE, on a separate card

The fix is one line: `await sleep(50)` after `watch(a, ...)` and before the first
`appendFile`, which is exactly what cases B and C already do and case A alone omitted.

Deliberately **not** applied on the branch that produced this document. That card's scope
was the time budgeting and the characterisation; changing the test's setup was a separate
change a werk-verifier should be able to review on its own, following the precedent set by the
sibling card, which characterised case B and did not touch the test either. It was filed
as `werk-fs-watch-contract-a-arming-race` and has since **landed** -- case A now settles
50 ms before its first append. See the re-measurement below.

Note this is a defect in the TEST, not in bun. `fs.watch` arming asynchronously is
ordinary behaviour -- which is why the fix does not weaken the contract: the assertion
case A makes (`bHits > 0` after re-watching a different file in the same directory) is
untouched and was never the thing failing.

## Re-measured 2026-08-21, on the branch that applied the fix

Same box, same bun 1.3.14 (`0d9b296a`), same harness, the two arms back to back and
sequential rather than concurrent -- so this run carried **less** load than the table
above, which is why the broken arm reads lower than 3.3 %:

| arm | `SETTLE_MS` | iterations | failures | rate |
|---|---|---|---|---|
| what the test used to do | **0** | 600 | 7 | **1.2 %** |
| what the test now does | 50 | 600 | 0 | **0 %** |

`first-never 7, second-late 0, second-never 0` -- the same signature as all 95 earlier
failures, and the same conclusion: every failure is the arming race in stage 1, never the
re-watch the test exists to pin. The unsettled arm's `a.jsonl` latency again topped out at
**290 ms** against the settled arm's **67 ms**; that tail IS the arming delay, showing up
as latency in the runs that got away with it.

The contract test itself then ran **12/12 green** (`3 pass 0 fail` each). Case B did not
flake in those 12, which is expected -- its stale-filename bun bug is ~0.33 % sequential,
and it is untouched by this change.

## How to verify

```bash
bun scripts/fswatch-rewatch-same-dir-repro.ts 600               # expect ~1-3% FAIL, all first-never
SETTLE_MS=50 bun scripts/fswatch-rewatch-same-dir-repro.ts 600  # expect 0
seq 1 10 | xargs -P 10 -I{} bun scripts/fswatch-rewatch-same-dir-repro.ts 100   # ~7-8%
```

The harness default is still `SETTLE_MS=0` on purpose: that is the BROKEN arm, and an
instrument that can only reproduce the fixed shape cannot re-prove the diagnosis. The
settled arm is what the shipped test now does.

Budget >=600 iterations before believing any arm is clean: at a few percent a
100-iteration run returns zero by luck often enough to mislead, which is the same trap
that produced the sibling card's (wrong) "passes alone" premise.

# bun 1.4.0 retest: the macOS `fs.watch` stale-filename defect is FIXED

Measured 2026-08-21 on `studio` (darwin arm64, macOS 26.5.2), at `1fed88bb` and
re-confirmed at `e239f32f` after the sibling card's contract-test fix merged.
Card: `bun-fs-watch-stale-filename-retest-on-bun-14`.

| | version | revision |
|---|---|---|
| defective baseline | bun **1.3.14** | `0d9b296af` |
| retest | bun **1.4.0** | `34cbb9a40` |

1.4.0 was downloaded, not installed: `bun-darwin-aarch64.zip` unpacked under
`.claude/temp/bun14/` and driven through `BUN_TEST_BIN`. The global `bun` on
`PATH` is still 1.3.14. This is deliberate -- ~48 agent hosts and the sentinel
launch via `#!/usr/bin/env bun`, so a global upgrade re-runtimes the whole fleet
on next spawn, which is a fleet decision and not a side effect of a measurement.

## Headline

**Case B, the stale-filename defect, is gone on 1.4.0: 0 failures in 3300
iterations, against 190 in 3300 on 1.3.14 run back to back on the same box.**

Every arm was run as a matched pair, alternating versions, same machine, same
session. Nothing here is compared against a number someone else measured on
another day.

## Case B -- `scripts/fswatch-stale-filename-repro.ts`

Watch a directory, create `first.jsonl`, wait for its name, create
`second.jsonl`, wait for ITS name. The defect is that the second creation fires
a callback on time carrying the *previous* file's name.

| arm | iterations | bun 1.3.14 | bun 1.4.0 |
|---|---|---|---|
| 1 process, sequential | 300 | 5 (**1.7 %**) | **0** |
| 10 concurrent processes x 100 | 1000 | 54 (**5.4 %**) | **0** |
| 20 concurrent processes x 100 | 2000 | 131 (**6.6 %**) | **0** |
| **total** | **3300** | **190 (5.8 %)** | **0 (0 %)** |

If 1.4.0 still carried the 1.3.14 rate, the chance of seeing zero failures in
3300 iterations is about `e^-191`. By the rule of three, the 95 % upper bound on
1.4.0's true rate is **0.09 %** -- i.e. at least 60x better, and consistent with
zero. This is a fix, not a lucky run.

The card warned that a 100-iteration run at ~3 % shows zero by luck often enough
to mislead, which is how the original "passes alone" premise was manufactured.
3300 iterations across three contention levels is the answer to that. Note the
1.3.14 rate *rises* with contention (1.7 % -> 5.4 % -> 6.6 %), so the heaviest
arm is also the most sensitive one, and it is the one that returned 0/2000.

### Signature on 1.3.14, confirming this is the same defect

All 59 failures in the sequential and 10-way arms produced **exactly two events,
both named `first.jsonl`** -- never a dropped event, never a third name. That is
the signature the parent card recorded over 46 failures, reproduced over 59 more.

One refinement to that signature: 58 of 59 were `rename:first.jsonl` twice, but
one was `change:first.jsonl` then `rename:first.jsonl`. The event *type* of the
first callback can vary. The invariant that holds is the count and the name, not
the type -- worth knowing for anyone writing a matcher against this.

## Case A -- `scripts/fswatch-rewatch-same-dir-repro.ts`

Case A is the *other* test in the contract file and it is NOT this card's defect,
but it had to be measured because the card's step 1 is to retest the whole
`src/shared/bun-contract/` directory, and on 1.4.0 that directory's only red runs
were case A.

The sibling card `werk-fs-watch-contract-test-timeout-guillotine` already proved
case A is an arming race in the test's own setup: it appends to `a.jsonl` within
~0.3 ms of `watch(a, ...)` returning, before the watcher is live. Its harness
separates `first-never` (stage 1, the race) from `second-late` / `second-never`
(stage 2, the re-watch that case A actually exists to pin), so it can attribute
the failure instead of just counting it.

| arm | iterations | bun 1.3.14 | bun 1.4.0 |
|---|---|---|---|
| 10 concurrent x 100, `SETTLE_MS=0` | 1000 | 50 (5.0 %) | 45 (4.5 %) |
| 20 concurrent x 50, `SETTLE_MS=0` | 1000 | 98 (9.8 %) | 113 (11.3 %) |
| 20 concurrent x 50, `SETTLE_MS=50` | 1000 | **0** | **0** |

Two things this settles:

1. **Case A is version-neutral.** Pooled over the 2000 `SETTLE_MS=0` iterations
   per version: 148/2000 vs 158/2000, `z = 1.09`, `p = 0.27`. Not a difference.
   1.4.0 neither fixes nor regresses it.
2. **`second-late` = 0 and `second-never` = 0 across all 4000 iterations, on both
   versions.** Every single failure was `first-never`. The re-watch -- the actual
   contract -- was healthy in every iteration on both runtimes. Case A's red runs
   are the test's arming race and nothing else.

`SETTLE_MS=50` takes both versions to 0/1000, which is the one-line fix carded as
`werk-fs-watch-contract-a-arming-race`.

### A wrong reading I published mid-measurement, and why

My first pass used a hand-rolled case-A harness that returned a single
`sawA && sawB` boolean and gave the second watcher a 12 s budget. It reported
case A failing 21.0 % on 1.4.0 against 14.8 % on 1.3.14 (n=600 each, 20-way),
which reads as a 1.4 regression. It is not one. That harness could not say
*which stage* failed, so it was attributing a stage-1 arming race to the stage-2
re-watch, and the two versions were measured at a contention level I had not
matched to anything. Re-run with the sibling card's instrument, which does
attribute the stage, the gap is not significant and the failures are 100 %
stage 1. The bad harness was deleted rather than committed. Recorded here because
"1.4 makes case A worse" would have been a load-bearing wrong claim on the
upgrade decision.

## Full suite, 16 consecutive runs per version, across two bases

`bun run test`, alternating versions run for run. Both binaries support
`--parallel` and `--no-orphans`, so both arms ran with the same flags.

Measured at two bases because the sibling card's contract-test fix (explicit 12 s
per-test timeouts + case-A instrumentation) merged to main midway through this
card's work, and that changes how case A *presents*. It changed nothing about the
result.

| base | runs each | bun 1.3.14 | bun 1.4.0 |
|---|---|---|---|
| `1fed88bb` (before the sibling fix) | 10 | 1 red -- case **B** | 2 red -- case **A** x2 |
| `e239f32f` (after it) | 6 | 1 red -- case **B** | 1 red -- case **A** |
| **pooled** | **16** | **2 red, both case B** | **3 red, all case A, case B zero times** |

| | bun 1.3.14 | bun 1.4.0 |
|---|---|---|
| anything else red in 7711 tests | none | none |
| typical result | 7652 pass / 59 skip / 0 fail | 7652 pass / 59 skip / 0 fail |
| wall clock | 20.22 s | 21.26 s |
| `# Unhandled error between tests` at the new base | 0 | 0 |

Nothing outside `fs-watch.contract.test.ts` behaved differently on 1.4.0 across 16
full runs of 7711 tests. Case B did not go red once on 1.4.0 in any of them; case A
stayed exactly as flaky as it is on 1.3.14. The zero unhandled-error count at the
new base is the sibling card's guillotine fix doing its job -- the phantom second
report that used to accompany every one of these failures is gone on both runtimes.

Contract directory alone, 5 consecutive runs on 1.4.0:
`13 pass / 0 fail` every time.

Two notes on `scripts/bun-test.sh` while we were in there, neither actioned
because both are outside this card:

- Its comment says `--parallel` is "bun >= 1.4". Not true: 1.3.14 has it, which
  is why the timing table below is a fair comparison.
- Its "sequential 74s, `--parallel` 20s" measurement is `--parallel` on vs off on
  the *same* 1.4 binary. It is not a 1.3.14 -> 1.4.0 speedup, and should not be
  quoted as a reason to upgrade: with `--parallel` on, the two versions are
  within a second of each other on this suite.

## How to verify

```bash
# get 1.4.0 without touching the global bun
mkdir -p .claude/temp/bun14 && cd .claude/temp/bun14
curl -sL -o b.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip
unzip -oq b.zip && chmod +x bun-darwin-aarch64/bun && cd -
B14="$PWD/.claude/temp/bun14/bun-darwin-aarch64/bun"

# case B: the defect this card is about
bun          scripts/fswatch-stale-filename-repro.ts 300   # ~1.7% FAIL
"$B14"       scripts/fswatch-stale-filename-repro.ts 300   # 0

# the sensitive arm -- 1.3.14's rate rises with contention, 1.4.0's stays at 0
seq 1 20 | xargs -P 20 -I{} bun    scripts/fswatch-stale-filename-repro.ts 100
seq 1 20 | xargs -P 20 -I{} "$B14" scripts/fswatch-stale-filename-repro.ts 100

# case A: version-neutral, and the race is the whole story
seq 1 20 | xargs -P 20 -I{} "$B14" scripts/fswatch-rewatch-same-dir-repro.ts 50
seq 1 20 | SETTLE_MS=50 xargs -P 20 -I{} "$B14" scripts/fswatch-rewatch-same-dir-repro.ts 50   # 0

# the suite, on 1.4.0, without installing it
BUN_TEST_BIN="$B14" bun run test
```

Budget >=300 iterations for case B and >=600 for case A before believing any arm
is clean.

## What follows

Per the card's step 4, 1.4 passing makes this a bun-upgrade question:
[bun-upgrade-fleet-to-1.4](../.rclaude/project/cards/bun-upgrade-fleet-to-1.4.md).
No upstream report to oven-sh/bun is needed for case B -- it is already fixed in
the current release.

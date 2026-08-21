# What `fallow audit` is actually looking at

`bun run lint:fallow` does not measure the repo. It measures **the diff**, and
its three analyzers do not even agree on what that means. A complexity finding
that vanishes between two runs has two indistinguishable explanations -- it was
fixed, or nobody touched its file -- and the audit output is byte-identical
either way.

Two generations of `board-integration-fallow-debt`'s finding table were partly
wrong for this reason. This doc is the durable copy of the measurement, and
`bun run fallow:census` is the command that answers the other question.

## The scopes, measured

Run at `7ab107d3`, base `32b13956` (merge-base with `origin/main`), 55 changed
files:

| analyzer | what it ANALYZES | what it REPORTS |
|---|---|---|
| dead code | whole repo -- entry-point reachability over every file | only findings whose file is in the changed set |
| complexity | **the changed set only** (`files_analyzed: 53` of 55 changed) | the same 53 files |
| duplication | whole repo (`stats.total_files: 2188`) | clone groups with at least one instance in the changed set -- the twin can be anywhere |

The changed set is the accumulated diff against `origin/main` **plus** the
working tree. Note what that means on this repo specifically: `main` sits ~55
commits ahead of `origin/main`, so every worktree's audit reports work from
other branches as `introduced: true`.

Same tree, same binary, the two numbers that matter:

| | `fallow audit` | `fallow health` |
|---|---|---|
| files analyzed | 53 | 3589 |
| functions analyzed | 1240 | 44769 |
| above threshold | 40 | 638 |
| severity critical | 15 | 154 |
| dead-code issues (baselined) | 2 | 55 |

`sweepBoard` in `src/shared/board-sweep.ts` -- cyclomatic 24, cognitive 43, 139
lines, severity **critical** -- is in the right-hand column and not the left,
purely because that file had not been touched since the merge-base. The moment
an implementer edited it for an unrelated one-line reason, it came straight
back. It never improved; it was never looked at.

## Rule 1: a disappeared complexity finding is not a fix

Before writing "this finding is gone" anywhere, confirm fallow opened the file:

```bash
bun run fallow:census --file src/shared/board-sweep.ts
```

```
src/shared/board-sweep.ts
  NOT in the gate scope -- the audit never opens this file. A missing finding means UNMEASURED, not fixed.
  whole-repo findings above threshold: 1
    critical cy=24 cog=43 loc=139       src/shared/board-sweep.ts:305 sweepBoard
```

`IN the gate scope` means a missing finding really is a fix. `NOT in the gate
scope` means the audit is silent, not clean. The cheap manual equivalent is
`git diff --stat <base> HEAD -- <file>`; an empty diffstat is the same verdict.

The distinction is not academic in both directions. `fireSchedule` in
`src/broker/scheduled-tasks/fire.ts` genuinely did improve, and its file WAS in
the changed set, so that reading was correct. "The metric went away because a
refactor happened" is a fine call **once you have checked the file was in
scope** -- and worthless before that.

## Rule 2: the whole-repo number is a different command

It is `fallow health`, not `fallow audit` with any flag.

**`fallow audit -r .` does not do it.** `-r/--root` sets the project root; it
does not widen the base. Verified 2026-08-21: with and without `-r .` the audit
returns the identical `changed_files_count: 55`, `files_analyzed: 53`. If a card
or a report claims a whole-tree audit was run that way, the number in it is the
changed-set number wearing a different hat.

## `bun run fallow:census`

Joins one `fallow health` (whole repo) with one `fallow audit --brief` (the
gate's own file list, so base resolution stays fallow's job and is never
re-derived from `git diff` here), and marks every finding with whether the
commit gate can currently see it.

```bash
bun run fallow:census                        # census + how much the gate cannot see
bun run fallow:census --top 40
bun run fallow:census --json
bun run fallow:census --file <path>          # rule 1, one file
bun run fallow:census --save .fallow/census.json
bun run fallow:census --check .fallow/census.json
```

```
fallow whole-repo complexity census
  repo      : 3594 files, 44866 functions analyzed
  gate scope: 58 files (base 32b13956, 61 changed)
  findings  : 640 above threshold, 154 critical
  INVISIBLE : 598 of 640 (139 critical) are in files the commit gate is not looking at

  top 25 by severity then cyclomatic ('!' = invisible to `bun run lint:fallow`):
   critical cy=153 cog=288 loc=1335    src/sentinel/index.ts:3001 <arrow>
 ! critical cy=128 cog=85 loc=269      src/claude-agent-host/ws-client.ts:362 routeBrokerMessage
 ...
```

Takes ~5s. It reports; it never blocks. The only non-zero exit is `--check`,
which exits 1 when a function appeared above threshold or got worse since the
saved snapshot.

## The decision: census on demand, gate stays new-only

The gate stays `new-only`. Failing a commit on all 638 whole-repo findings would
make the repo unlandable, and inheriting somebody else's 154 critical functions
is exactly the un-fixable block that
[the merge audit](fallow-merge-audit.md) already refused to build.

What was missing was not a gate but a **number**: nobody could state what the
repo was sitting on, and "the audit is green" quietly read as "the repo is
clean" when it only ever meant "this diff is clean". `.fallow/census.json` is
the committed snapshot of the 638, and `--check` diffs against it.

Nothing runs it on a timer. Run it once per epic (before the finding table gets
written), and re-save the snapshot when the movement is real:

```bash
bun run fallow:census --check .fallow/census.json   # exits 1 on new/worse
bun run fallow:census --save .fallow/census.json    # accept the new floor
```

Snapshot identity is `path::name` (plus `#2`, `#3` for repeated names in one
file), and line numbers are deliberately dropped, so an edit above a function is
not drift. A rename or a file move therefore reads as one `resolved` plus one
`NEW` -- fallow exposes no stable function id to do better, and pretending
otherwise would hide real regressions behind renames.

## Writing new code under `scripts/`

Every `scripts/**` file scores `coverage_tier: none` in fallow's estimator --
including one with a colocated `.test.ts`, because `bun test` is rooted at `src`
and those tests are not in the default suite. CRAP at zero coverage is
`cy + cy^2`, so **cyclomatic 5 hits the CRAP-30 threshold on its own** and fails
the gate, regardless of how well tested the function actually is.

That is why every function in `scripts/lib/fallow-census*.ts` is under
cyclomatic 5. It is an artifact of the coverage model rather than a real
complexity ceiling, but the gate is the gate and suppressions are not an option
here -- split the function.

`bun run test:census` runs this tool's tests, which the default `bun run test`
does not pick up.

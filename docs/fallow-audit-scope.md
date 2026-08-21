# What `fallow audit` is actually looking at

`bun run lint:fallow` does not measure the repo. It measures **the diff**, and
its three analyzers do not even agree on what that means. A complexity finding
that vanishes between two runs has two indistinguishable explanations -- it was
fixed, or nobody touched its file -- and the audit output is byte-identical
either way.

Two generations of `board-integration-fallow-debt`'s finding table were partly
wrong for this reason. This doc is the durable copy of the measurement, and
`bun run fallow:census` is the command that answers the other question.

The gap in one line, measured at `c54a5eac` with fallow 2.104.0:

| | `bun run lint:fallow` | `bun run fallow:census` |
|---|---|---|
| verdict | **pass** | -- |
| files analyzed | 5 | 3597 |
| functions analyzed | 105 | 45076 |
| above threshold | 0 | 638 |
| severity critical | 0 | 153 |

Both are true. The gate answers "did this diff add anything", and it was right
to pass. It has never answered "what is in this repo", and reading it as though
it had is the mistake.

## The scopes, measured

Run at `7ab107d3` (55 changed files against the then-merge-base `32b13956`),
because a big changeset shows the difference between the three analyzers that a
small one hides:

| analyzer | what it ANALYZES | what it REPORTS |
|---|---|---|
| dead code | whole repo -- entry-point reachability over every file, which is the only way an unused export is decidable at all | only findings whose file is in the changed set: 2 reported, against 55 that `fallow dead-code` finds on the same tree |
| complexity | **the changed set only** -- `files_analyzed: 53` of 55 changed, 1240 functions of 44769 | the same 53 files |
| duplication | a NEIGHBOURHOOD around the changed set, not the whole repo: 2188 files at 55 changed, 1013 at 9 changed, against 2412 for `fallow dupes` | clone groups with at least one instance in the changed set -- the twin can be a file nobody touched (4 of 8 were, here) |

Two consequences that are easy to miss:

- **`vital_signs` in an audit describes the diff, not the repo.** At `7ab107d3`
  the audit reported `maintainability_avg: 88.2` over `total_files: 53`. The
  same field on the whole tree was 90.1 over 3589 files. Quoting an audit vital
  sign as a repo health number is quoting a property of somebody's changeset.
- **The changed set is the diff against `origin/main` PLUS the working tree.**
  On this repo `main` routinely runs 20-60 commits ahead of `origin/main`, so a
  bare audit attributes other agents' landed work to your branch. The commit
  gate in `.claude/hooks/fallow-gate.sh` was locally patched to pin
  `FALLOW_AUDIT_BASE=main` for exactly that reason -- so the gate and a bare
  `bun run lint:fallow` can legitimately disagree about what "changed" means.
  Set the same variable to reproduce what the gate saw:
  `FALLOW_AUDIT_BASE=main bun run fallow:census`.

## Rule 1: a disappeared complexity finding is not a fix

Before writing "this finding is gone" anywhere, confirm fallow opened the file:

```bash
bun run fallow:census --file src/shared/board-sweep.ts
```

`NOT in the gate scope` means the audit is silent about that file, not clean --
and the `whole-repo findings above threshold` count underneath is the answer the
audit could not give you. `IN the gate scope` means a missing finding really is
a fix. The cheap manual equivalent of the first line is
`git diff --stat <base> HEAD -- <file>`; an empty diffstat is the same verdict.

`sweepBoard` is the case that proves both halves. At `7ab107d3` it was
cyclomatic 24 / cognitive 43 / 139 lines / **critical**, and completely absent
from the audit, because `src/shared/board-sweep.ts` had not been touched since
the merge-base. It had not improved -- nobody had looked. At `c54a5eac`, after
`324c58f8` split it per proposal kind, the same command reports
`whole-repo findings above threshold: 0` for that file while it is STILL out of
the gate's scope. That is a real fix, stated by a run that opens the file
regardless of the diff. The audit alone cannot tell those two states apart; this
is the whole reason the census exists.

`fireSchedule` in `src/broker/scheduled-tasks/fire.ts` is the other side:
it genuinely improved AND its file was in the changed set, so reading its
disappearance as a fix was correct. "The metric went away because a refactor
happened" is a fine call **once you have checked the file was in scope**, and
worthless before that.

## Rule 2: the whole-repo number is a different command

It is `fallow health`, not `fallow audit` with any flag.

**`fallow audit -r .` does not do it.** `-r/--root` sets the project root; it
does not widen the base. Verified 2026-08-21: with and without `-r .` the audit
returned an identical `changed_files_count: 55`, `files_analyzed: 53`. If a card
or a report claims a whole-tree audit was run that way, the number in it is the
changed-set number wearing a different hat.

## `bun run fallow:census`

Joins one `fallow health` (whole repo) with one `fallow audit --brief` (the
gate's own file list, from `partition.units[].files[]`, so base resolution stays
fallow's job and is never re-derived from `git diff` here), and marks every
finding with whether the commit gate can currently see it.

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
  repo      : 3597 files, 45076 functions analyzed
  gate scope: 5 files (base 6f8f7dc2, 9 changed)
  findings  : 638 above threshold, 153 critical
  INVISIBLE : 638 of 638 (153 critical) are in files the commit gate is not looking at

  top 25 by severity then cyclomatic ('!' = invisible to `bun run lint:fallow`):
 ! critical cy=153 cog=288 loc=1335    src/sentinel/index.ts:3001 <arrow>
 ! critical cy=128 cog=85 loc=269      src/claude-agent-host/ws-client.ts:362 routeBrokerMessage
 ! critical cy=94 cog=122 loc=351      src/broker/handlers/channel.ts:821 deliverToOne
 ...
```

Takes ~5s. It reports; it never blocks. The only non-zero exit is `--check`,
which exits 1 when a function appeared above threshold or got worse since the
saved snapshot.

## The decision: census on demand, gate stays new-only

The gate stays `new-only`. Failing a commit on all 638 whole-repo findings would
make the repo unlandable, and inheriting somebody else's 153 critical functions
is exactly the un-fixable block that [the merge audit](fallow-merge-audit.md)
already refused to build.

What was missing was not a gate but a **number**: nobody could state what the
repo was sitting on, and "the audit is green" quietly read as "the repo is
clean" when it only ever meant "this diff is clean". `.fallow/census.json` is
the committed snapshot of the 638, and `--check` diffs against it.

Nothing runs it on a timer, and nothing wires it into `bun run lint`. Run it
once per epic, before the finding table gets written, and re-save the snapshot
when the movement is real:

```bash
bun run fallow:census --check .fallow/census.json   # exits 1 on new/worse
bun run fallow:census --save .fallow/census.json    # accept the new floor
```

Snapshot identity is `path::name` (plus `#2`, `#3` for repeated names in one
file), and line numbers are deliberately dropped, so an edit above a function is
not drift. A rename or a file move therefore reads as one `resolved` plus one
`NEW` -- fallow exposes no stable function id to do better, and pretending
otherwise would hide real regressions behind renames. A function whose
cyclomatic rose while its cognitive fell counts as **worsened**: a regression
hiding behind an improvement in the other metric is still a regression.

## Writing new code under `scripts/`

Every `scripts/**` file scores `coverage_tier: none` in fallow's estimator --
including one with a colocated `.test.ts`, because `bun test` is rooted at `src`
(see `bunfig.toml`) and those tests are not in the default suite. CRAP at zero
coverage is `cy + cy^2`, so **cyclomatic 5 hits the CRAP-30 threshold on its
own** and fails the gate, regardless of how well tested the function actually
is.

That is why every function in `scripts/lib/fallow-census*.ts` is under
cyclomatic 5. It is an artifact of the coverage model rather than a real
complexity ceiling, but the gate is the gate and suppressions are not an option
here -- split the function.

`bun run test:census` runs this tool's tests, which the default `bun run test`
does not pick up.

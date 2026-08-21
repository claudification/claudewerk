# Worktree sparse-checkout residue sweep -- 2026-08-21

**Date:** 2026-08-21\
**Card:** `board-sparse-residue-269-worktrees` (epic `epic-morning-report`)\
**Scope:** every git worktree of this repo on host `studio` -- 269 of them carried a
dead `--no-cone` sparse-checkout for an exclusion that matched nothing.\
**Result:** 269/269 cleared. Zero working-tree delta, zero files added or removed,
12 worktrees with uncommitted work preserved byte-identically.

This file exists because the state it describes lived only in `.git/`, which is not
tracked. Without it, a future reader of `d1954c25` has no way to learn that the
machine was still carrying the state after the tool that wrote it was deleted.

---

## What the residue was

`board-in-worktrees-policy` (`ec903d3c`) added a `SPARSE_BOARD` block to
`scripts/worktree-init.sh` so every new worktree excluded the project board from
checkout, and swept the existing worktrees to apply the same exclusion.

Jonas then reverted the premise in `7ee496a4` (the board is never tracked, so there
is nothing to exclude) and deleted the machinery in `d1954c25` --
`scripts/worktree-sparse-board.sh`, the `SPARSE_BOARD` block, the tests and the
fixtures all went.

Deleting the tool did not undo the state it had already written. Measured at
`32b13956`, every one of the 269 worktrees that existed during the sweep still had:

```
.git/worktrees/<name>/info/sparse-checkout
  /*
  !/.rclaude/project/

.git/worktrees/<name>/config.worktree
  [core]
      sparseCheckout = true
      sparseCheckoutCone = false
```

`--no-cone` is git's deprecated sparse mode, so any future `git sparse-checkout`
call in one of those trees would have run in legacy mode and warned, for an
exclusion that matched nothing.

## Proof that clearing it was a no-op

Two checks ran before anything was written.

1. **Nothing tracked has ever been under the excluded path, at any of those HEADs.**
   `.rclaude/project/done/plan-mode-full-implementation.md` was tracked once (added
   `79f86c0f`, removed `f95d6fbf`, 2026-04-24, on main). All 269 worktree HEADs were
   resolved and `git ls-tree -r <sha> -- .rclaude` was run against each: 0 hits, 0
   unresolvable revs. So no index entry could carry `SKIP_WORKTREE`, and
   `sparse-checkout disable` had nothing to restore.

2. **Pilot on one tree first.** `order-seat-union-is-closed`:
   `git status --porcelain` captured before and after was byte-identical, `.rclaude/`
   was absent from disk both times, and the tree ended up reporting
   `fatal: this worktree is not sparse`.

Only then did the rest run, in batches with a per-batch count.

## What was done to each tree

Inside the worktree itself, never with `git -C` from outside:

```sh
git sparse-checkout disable          # the only git command the card authorised
rm -f "$(git rev-parse --git-dir)/info/sparse-checkout"
```

The `rm` is required because `git sparse-checkout disable` does **not** delete
`$GIT_DIR/info/sparse-checkout` (git 2.54 keeps the patterns so a later `init` can
re-enable them). It only flips the config:

```
[core]
    sparseCheckout = false
    sparseCheckoutCone = false
[index]
    sparse = false
```

Leaving the patterns file behind would have left exactly the unexplained residue
this sweep was paying off, so it goes.

`git status --porcelain` was captured before and after in **every** tree, not just a
sample, and the sweep was wired to halt on the first difference. It never halted:
269 SAME, 0 DIFFERENT, 0 errors, 0 skips.

## Trees that had uncommitted work

Twelve trees were dirty at sweep time and came out with the identical status output:

| worktree | dirty lines |
| --- | --- |
| `epic-mcp-verbs` | 1 |
| `epic-planner-stage` | 1 |
| `epic-run-ceiling-copy` | 1 |
| `epic-run-dialog-briefing` | 1 |
| `epic-seat-tag` | 1 |
| `guard-nshi` | 3 |
| `guard-nshi-g12` | 1 |
| `guard-wfb-merge` | 7 |
| `lint-delegation-split` | 1 |
| `meta-message-render` | 1 |
| `node-stats-reporter` | 1 |
| `voice-refine-rollout` | 1 |

No `git checkout`, `git stash`, `git reset` or `git clean` was run in any tree.

## The one tree outside `.claude/worktrees/`

268 of the 269 live under `.claude/worktrees/`. The odd one out was
`fallow-audit-base-cache-279cd23124568d26-8bd9ea79a0bdd5eb`, a throwaway base-commit
cache `fallow` had left in `$TMPDIR`. It carried the same pattern and was swept the
same way. It will disappear with the next temp wipe.

## How to re-verify

From anywhere, against the shared `.git`:

```sh
R=/Users/jonas/projects/remote-claude
find "$R/.git/worktrees" -name sparse-checkout | wc -l          # expect 0
grep -rl 'sparseCheckout = true' "$R/.git/worktrees" | wc -l    # expect 0
grep -rl '!/.rclaude/project/' "$R/.git/worktrees" | wc -l      # expect 0
```

In any individual worktree:

```sh
git sparse-checkout list        # expect: fatal: this worktree is not sparse
git ls-files -v | grep -c '^[a-z]'   # expect 0 -- no SKIP_WORKTREE entries
```

Worktrees created after `d1954c25` were never affected: `worktree-init.sh` no longer
writes sparse state, and 339 gitdirs already had none.

## What was deliberately not done

- **No mechanism was added.** No script new worktrees run, nothing re-added to
  `worktree-init.sh`. The `SPARSE_BOARD` block stays deleted.
- **No worktree lifecycle cleanup.** Several of the swept trees are on merged or
  deleted branches. Pruning them is a different card.

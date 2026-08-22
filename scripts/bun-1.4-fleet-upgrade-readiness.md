# bun 1.4.0 fleet upgrade: readiness, blast radius, and what the decision actually is

Measured 2026-08-21 on `studio` (darwin arm64, 10 cores) at `9f885bb4`.
Card: [bun-upgrade-fleet-to-1.4](../.rclaude/project/cards/bun-upgrade-fleet-to-1.4.md).
Prior art: `scripts/fswatch-bun-1.4-retest.results.md` (the defect measurement).

That sibling card proved the fs.watch stale-filename defect is fixed on 1.4.0.
It deliberately did not decide whether the fleet moves. This document is the
readiness work for that decision: what actually re-runtimes, what the upgrade
costs to undo, and what is still untested. The trigger-pull itself is not taken
here either -- see "The decision that is left" at the bottom.

Everything below was measured on this box, not recalled.

## The premise, checked

The card says ~48 agent hosts and the sentinel launch via `#!/usr/bin/env bun`,
so a global upgrade re-runtimes the fleet. **Confirmed, with one trap worth
naming.**

The repo contains two completely different sets of host binaries:

| path | how built | what it is | does the fleet use it? |
|---|---|---|---|
| `bin/rclaude`, `bin/sentinel`, ... | `bun build --compile` | Mach-O executable, bun runtime **embedded** | **no** |
| `packages/*/bin/*` | `bun build --target=bun` | `#!/usr/bin/env bun` JS bundle | **yes** |

`/Users/jonas/.bun/bin/rclaude` and `.../sentinel` -- the two things on `PATH` --
are symlinks into `packages/`, i.e. into the shebang bundles. So the runtime is
whatever `bun` resolves to on `PATH`, and the `--compile` artifacts in `bin/` are
a red herring: they would NOT be affected by a global upgrade, and reasoning from
them would produce the wrong answer.

Live right now: **54** processes matching `bin/rclaude` or `bin/sentinel`, each
running as `bun /Users/jonas/.bun/bin/rclaude ...`.

## "All at once" is not what happens

The card describes the upgrade as "every host, all at once, with no staged
rollout". The first half is not right, and it changes the shape of the decision.

`lsof` on a live host shows its executable text file is
`/opt/homebrew/Cellar/bun/1.3.14/bin/bun` (inode `734044588`) -- the **Cellar
path**, not the `/opt/homebrew/bin/bun` symlink. `brew upgrade` installs 1.4.0
into a new `Cellar/bun/1.4.0/` and repoints the symlink; it does not touch or
delete the 1.3.14 file.

So the 54 running hosts keep running on 1.3.14, untouched, for as long as they
live. Only the **next spawn** picks up 1.4.0. The fleet drifts onto the new
runtime host by host as conversations are created -- which is already a rolling
upgrade, just an unattended one.

What is genuinely missing is not staging. It is the ability to **pin a specific
host back** to 1.3.14 once the global has moved.

## The upgrade command does not currently work

```
$ brew upgrade bun
Error: Refusing to load formula oven-sh/bun/bun from untrusted tap oven-sh/bun.
Run `brew trust --formula oven-sh/bun/bun` or `brew trust oven-sh/bun` to trust it.
```

bun on this box comes from the third-party tap `oven-sh/bun`, and Homebrew's
untrusted-tap gate now blocks it. `brew outdated bun` and `brew upgrade --dry-run
bun` fail the same way. **`brew trust` is a prerequisite, and it is a separate
decision from the bun version** -- trust persists and applies to whatever that
tap's formula becomes later, not just to the revision audited today.

What the formula does today, audited in full
(`/opt/homebrew/Library/Taps/oven-sh/homebrew-bun/Formula/bun.rb`):

- pins `version "1.4.0"` **literally** -- it is not a "latest" formula, so
  `brew upgrade` installs exactly the version that was measured, not whatever
  oven-sh has released since
- downloads `bun-darwin-aarch64.zip` from the official
  `github.com/oven-sh/bun/releases/download/bun-v1.4.0/` URL
- pins `sha256 c669e97f...de381`
- `install` is `bin.install "bun"` plus shell completions. No build, no scripts.

Verified independently: downloading that exact URL here gives
`sha256 c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381`, a
byte-for-byte match with the formula, and the binary self-reports
`1.4.0+34cbb9a40` -- the same revision the defect measurement used.

## Rollback costs about a second

`brew upgrade` retains `Cellar/bun/1.3.14/` (only `brew cleanup` removes it), and
`/opt/homebrew/bin/bun` is a plain symlink:

```
/opt/homebrew/bin/bun -> ../Cellar/bun/1.3.14/bin/bun
```

So rollback is relinking it, and new spawns are back on 1.3.14 immediately.
Running hosts never moved, so nothing has to be restarted either way.

**Do not run `brew cleanup` after upgrading.** That is the one action that turns
a one-second rollback into a re-download-and-reinstall.

## Compatibility matrix

The scenario `brew upgrade bun` alone produces is "old bundle, new runtime" --
nobody rebuilds `packages/*/bin/*` as part of a brew upgrade. That cell is the
one that actually matters, and it is green.

All four package bundles were built on **both** bun versions
(`bun build --target=bun --minify --sourcemap=external`, the exact flags
`scripts/build-packages.ts` uses) into a scratch dir, then run 2x2:

| sentinel bundle built by | run on 1.3.14 | run on 1.4.0 |
|---|---|---|
| bun 1.3.14 | exit 0, 22 lines | **exit 0, 22 lines** |
| bun 1.4.0 | exit 0, 22 lines | exit 0, 22 lines |

The **live installed** bundle (`packages/sentinel/bin/sentinel`, the literal
artifact the fleet launches) also exits 0 on 1.4.0 unrebuilt.

All four packages build cleanly on 1.4.0. The output is not byte-identical
across versions -- minifier drift, 0.03-0.06 % smaller:

| bundle | built by 1.3.14 | built by 1.4.0 |
|---|---|---|
| `rclaude` | 1 070 399 B | 1 070 110 B |
| `opencode-host` | 21 939 B | 21 941 B |
| `daemon-host` | 920 960 B | 920 722 B |
| `sentinel` | 532 620 B | 532 285 B |

Consequence: the first `bun run build:packages` after an upgrade ships different
bytes than the last one, independent of any source change. Expected, but it means
a bundle diff after the upgrade is not evidence of a source regression.

## Suite, at this base

`bun run test`, same flags (`--parallel --no-orphans`) on both, 614 files:

| | bun 1.3.14 | bun 1.4.0 |
|---|---|---|
| result | 7684 pass / 59 skip / 0 fail | 7684 pass / 59 skip / 0 fail |
| `expect()` calls | 23 714 | 23 714 |
| wall clock | 20.05 s | 21.06 s |

Identical, and no speedup -- consistent with the sibling card's 16-run-per-version
result. This base is also green, so the two flaky fs-watch cases did not fire in
either of these runs.

## What is still untested, honestly

**No agent host has been booted end-to-end on 1.4.0.** Booting one means starting
a real Claude Code session against the live broker, which is not something to do
as a side effect of a measurement. What has been shown is: the bundles load, parse
args and exit clean on 1.4.0, and 7743 tests pass on it. A full host lifecycle --
broker handshake, transcript watching, MCP, PTY, spawn/detach -- has not run on
1.4.0 even once.

That gap is the entire remaining risk, and it is the one argument for staging.
It is also cheap to close *without* building anything: upgrade, spawn one
throwaway conversation, watch it complete a turn, relink if it smells.

## The per-host pin, if it is wanted anyway

The card asks whether a pin mechanism should exist. It does not today, but the
seam is small and already in the right place.

`src/sentinel/index.ts` spawns hosts as `Bun.spawn([opts.bin], { env })`, where
`env` comes from `cleanSentinelEnv()` -- a copy of `process.env`, `PATH` included.
Because the bundle's shebang is `#!/usr/bin/env bun`, the child's `PATH` fully
determines its runtime. Prefixing a chosen bun's directory onto that child's
`PATH` (or spawning `[bunPath, opts.bin]` instead of `[opts.bin]`) pins that one
host, with no change to the bundles and no change to anything already running.

Rough cost: a config field, ~10 lines at the three `Bun.spawn` call sites, and
tests. It is not hard. It is just being proposed to de-risk a change whose undo
is already a symlink relink, in one of the highest-blast-radius files in the repo.

## Recommendation

**Upgrade all at once, canary by observation, do not build the pin.**

1. `brew trust oven-sh/bun` (the actual gate, and the part that needs a human)
2. `brew upgrade bun` -- installs exactly 1.4.0, sha256 as audited above
3. spawn one throwaway conversation and watch it complete a turn -- this is the
   end-to-end evidence that no amount of unit testing supplies
4. do **not** `brew cleanup`
5. if anything is wrong:
   `ln -sfn ../Cellar/bun/1.3.14/bin/bun /opt/homebrew/bin/bun`

Reasoning:

- The evidence base is already stronger than a staged rollout would collect. 18
  matched full-suite runs across two bases and 7743 tests beats a few canary
  hosts observed for a day.
- Rollback speed, not blast radius, is what bounds the damage here, and rollback
  is already ~1 second without any new mechanism.
- Running hosts are untouched, so there is no all-at-once moment to stage away.
  The rolling upgrade already exists.
- Building the pin means editing the sentinel spawn path -- a shared, high-blast-
  radius file -- to protect against something with a one-second undo. That adds
  more risk than it removes.

Against this recommendation, fairly: the untested host lifecycle (above) is real,
and step 3 is a sample of one. If the answer is "no unattended runtime change on
this box, full stop", that is a coherent position and the pin mechanism becomes
the work item.

## WHAT ACTUALLY HAPPENED -- 2026-08-21, the move was made

Jonas took the recommendation and upgraded. Global bun on `studio` is now **1.4.0**. What
follows is the post-move verification, measured after the fact, not predicted.

**The rolling upgrade is real, exactly as described above.** At the moment of the first new
spawn: **50 hosts on 1.3.14, 1 on 1.4.0**. Running hosts kept the inode they booted with.
A mixed fleet is therefore the steady state until the old hosts drain -- not a transient.

**Step 3 was done, and it is the first time it has ever been done.** A throwaway canary
conversation was spawned, booted on 1.4.0, ran a Bash tool, reached the MCP channel and wrote
its transcript to disk:

```
CANARY bun=1.4.0 mcp=ok conv=714454ac-139d-4293-b87b-447eb847b372
```

That closes the "no agent host has been booted end-to-end on 1.4.0" gap this document opened.
Suite at the same base, on the real global bun with no override: **7705 pass / 59 skip /
0 fail**, 617 files, 24.43s.

### The one thing that went wrong: step 4 was not honoured

This document says, in bold, *"Do not run `brew cleanup` after upgrading."* It ran anyway --
`/opt/homebrew/Cellar/` contains **only 1.4.0**. The one-second rollback this document's
entire risk argument rests on **did not exist** by the time anyone looked.

The 50 running hosts were never in danger: their executable is an unlinked-but-open inode, so
they keep working. But those bytes are unrecoverable once each process exits, and there was no
1.3.14 on disk to relink to.

Restored by re-fetching the official 1.3.14 darwin-aarch64 release:

```
~/.cache/bun-rollback/bun-1.3.14/bun          # reports 1.3.14
ln -sfn ~/.cache/bun-rollback/bun-1.3.14/bun /opt/homebrew/bin/bun    # the undo, now
```

Note the undo is no longer a *relative* symlink into the Cellar, so `brew` will happily
overwrite it on the next `bun` operation. Anyone relying on it should check it still points
where they think.

**Lesson for the next runtime move:** the rollback path is a precondition to verify AFTER the
upgrade, not a property to assume from before it. Check `ls /opt/homebrew/Cellar/bun/` first,
before spawning anything on the new runtime.

## The decision that is left

`brew trust` + `brew upgrade` mutate a shared box outside git, with 54 live bun
processes on it, and the trust half is a standing security decision about a
third-party tap rather than a one-off. That is a fleet call, and the card says as
much. It is raised to the werk-master rather than taken here.

## After the fleet is actually on 1.4.0

Not done yet, and deliberately -- both are gated on the move actually happening
(card step 3):

- `.claude/topics/gotchas-runtime.md`: the `Bun fs.watch macOS` entry still reads
  "obey this, the fleet is on 1.3.14". It becomes historical.
- `src/shared/bun-contract/fs-watch.contract.test.ts`: the chokidar-removal
  question in its header reopens. Reopening is not doing it -- case A
  (`werk-fs-watch-contract-a-arming-race`) still has to land first, and the
  500 ms poll net has its own reasons to exist.

## How to reproduce any of this

```bash
# the 1.4.0 binary, without installing it
mkdir -p .claude/temp/bun14 && cd .claude/temp/bun14
curl -sL -o b.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-aarch64.zip
shasum -a 256 b.zip     # must equal the formula's sha256
unzip -oq b.zip && chmod +x bun-darwin-aarch64/bun && cd -
B14="$PWD/.claude/temp/bun14/bun-darwin-aarch64/bun"

# the premise: what the fleet actually launches, and on which bun
file -L "$(which rclaude)"                      # env bun script text, not Mach-O
lsof -p "$(pgrep -f 'bin/rclaude' | head -1)" | awk '$4=="txt" && /bun/'

# the brew gate
brew upgrade --dry-run bun                      # untrusted tap error

# old bundle on the new runtime -- the cell brew upgrade alone produces
"$B14" packages/sentinel/bin/sentinel --help; echo "exit=$?"

# build every package on 1.4.0 into a scratch dir
for p in claude-agent-host:rclaude opencode-agent-host:opencode-host \
         daemon-agent-host:daemon-host sentinel:sentinel; do
  "$B14" build "src/${p%%:*}/index.ts" --target=bun --minify --sourcemap=external \
    --outdir .claude/temp/pkgbuild/v140 --entry-naming "${p##*:}"
done

# the suite, both runtimes
bun run test
BUN_TEST_BIN="$B14" bun run test
```

# Epic Baton

Append-only. Every overseer generation reads this and nothing else about the past.

### 2026-08-19T11:05:40.508Z intent [5dda251f-df1f-4b9d-b4a8-0b9e18615355]

Planning generation dispatched. Nothing else runs until it exits. It reads the epic intent and every card, closes what is already done, files what is missing, and writes the `depends_on` edges that were never declared -- so dispatch arithmetic has a complete graph to work from.

### 2026-08-19T11:15:39.453Z intent [5dda251f-df1f-4b9d-b4a8-0b9e18615355]

Planning pass complete. Board went 17 cards -> 20 active + 1 archived. Graph is
acyclic, every edge resolves, ~10 beats at ceiling 3. Nothing dispatched.

**CLOSED AS DONE: none.** Checked the tree, not the board. `find` for `*wall*`
under `src/` and `web/src/` returns nothing; branch `worktree-node-stats-reporter`
sits at `fe293c4b` with zero commits and a clean worktree. Not one line of this
epic exists. Every card is genuinely open.

**STATUS CORRECTED (1)**
- `node-stats-contract` in-progress -> open. Its worktree was cut and never
  written in. Left as in-progress it would have been a permanent hole in the
  graph: two leaf cards wait on it and no agent was working it.

**FILED (4)**
- `wall-now-bar` -- **A5 was uncovered.** It is in the epic's own pane table and
  in the approved mockup (`the-wall.html:334`, styles :78, render :665) and no
  card owned it. Every other pane code in the mockup had one. This would have
  shipped as a hole across the top edge of the surface.
- `wall-openrouter-spend-store` -- **the burn pane's second split had no feed.**
  The old card said OpenRouter spend "is already tracked through one sink with a
  REQUIRED feature tag". True, and incomplete in the way that matters:
  `recordOpenRouterSpend()` is one `console.log`
  (`openrouter-client.ts:165`). No table, no rollup, no route. Under the epic's
  own measured-numbers rule that split could only ever have rendered a dash.
  The file's comment already designed for this ("wiring a DB is a one-line change
  inside `recordOpenRouterSpend`"), so the card is small.
- `wall-pane-fleet` + `wall-pane-burn` -- the split of `wall-pane-fleet-burn`.

**ARCHIVED (1)**
- `wall-pane-fleet-burn` -> split. It bundled P4 and A2: two panes, two grid
  slots, two data paths, and the A2 half alone is a full sitting (rate maths,
  cap state, two split bars, plus the missing OpenRouter feed above). Body kept
  for provenance and points at all three replacements. No scope dropped.

**THREE FACTUAL ERRORS CORRECTED IN CARD BODIES** -- each would have cost an
implementer a rediscovery round, and two would have shipped duplicated code:
- `node-stats-contract` put "profile NAMES with plan utilization" on the new
  payload. That path is already built and richer: `ProfileUsageSnapshot`
  (`protocol.ts:5379`) carries the 5h/7d windows, reset, `error` kind and a
  `stale` carry-forward flag, written by `setSentinelProfileUsage()` /
  `recordInferenceUsage()` and read via `getSentinelProfileUsage()`
  (`conversation-store.ts:316-330`). A second utilization path is exactly what
  `feedback_no_duplication` exists to stop. Node stats now carry machine facts +
  conversation count only.
- `wall-plan-usage-series` therefore does NOT depend on `node-stats-contract`.
  Dropped that edge and wrote the real source table onto the card. It gains a
  done-criterion for `stale` -- drawing a carried-forward reading as a live chart
  point is the specific lie that shape's flag exists to prevent.
- `wall-pane-sheaf-sotu` said A4 "needs a read route". It does not.
  `GET /api/sheaf?windowH=` is live and Phase 6 already folds the SOTU narrative
  AND the git fabric in via `enrichSheafWithSotu`. One route feeds both panes --
  which is also why I did NOT split this card despite it being two panes. Noted
  its admin gate and the per-caller visibility predicate so nobody widens them,
  and left one explicit decision on the card (where `summarizeSheaf()` lives).

Also confirmed `POST /api/epic` (inspect/list/beat/break_lease as broker actions,
pause/abort as forwarded sentinel ops) and `routes/nightshift.ts` already exist,
and wrote that onto `wall-pane-unattended-runs` so it builds no third route.

**THE EDGES.** The board had 17 cards and almost no true collision edges. What
changed:

1. **`wall-live-channel` was a root that nothing depended on** -- the single
   worst thing on the board. It owns the `BrokerMessage` union tail
   (`protocol.ts:2339`, a flat appended list), `message-router.ts` and the
   subscribe path in `use-websocket.ts`. Every pane consumes its frame. Left as
   a peer, twelve panes would have each grown their own hook and then been
   rewritten. Now every pane depends on it, and it must ship the frame with all
   six slots present from day one so downstream cards fill exactly one field.
2. ~~**`board-card-change-events` -> depends on `wall-live-channel`.**~~
   **WITHDRAWN -- see the 11:20 amendment. This edge was wrong.**
3. **`node-stats-contract` stays a root.** It lands in `SentinelMessage`
   (:5902), ~3500 lines from the other two. No collision, so no edge -- this is
   the one place the protocol cards genuinely parallelise.
4. **`wall-filter-bus` 3 pane edges -> all 11.** Its contract is "every pane
   obeys" and "each pane header shows its own matched/total": it edits every pane
   and cannot be verified against a half-built grid.
5. **`wall-time-cursor` and `wall-navigation-and-hover` -> `wall-filter-bus`**
   (which carries all panes transitively). Filter first because it decides WHICH
   rows exist; the cursor then narrows by time on a settled selector shape. The
   two run in parallel with an explicit seam written into both: **cursor owns
   DATA SELECTION, navigation owns ROW INTERACTION.**
6. **Resolved a duplicate claim.** `wall-filter-bus` and
   `wall-navigation-and-hover` BOTH claimed "clicking a project dot anywhere
   filters" -- two implementations of one click. The bus owns the action; the
   nav card consumes it. Stated on both.
7. **`wall-copy-affordance` -> terminal.** It had one edge to the shell, which
   would have had it writing report builders for panes that did not exist. Its
   report is stamped with the cursor offset and active filter, and its row copy
   shares the hover surface with the nav card's previews.

**THE ONE EDIT THAT DECIDES WHETHER THIS EPIC PARALLELISES AT ALL** is on
`wall-surface-shell`: it must ship **twelve pane stub files already wired and
lazily imported**, one per pane code. Without that, every pane card adds itself
to the grid and twelve agents in twelve worktrees edit one file -- eleven
conflicting merges. With it, a pane card rewrites exactly ONE file and touches
nothing shared. The header ships the same way (inert filter box, inert scrubber)
for the two mechanics cards to fill.

**LEFT ALONE, DELIBERATELY**
- `node-stats-reporter-credential` sits in `cards/` with no `epic:` key. It is
  the `rpt_` minimal-privilege credential + standalone reporter. THE WALL ships
  host vitals from the sentinel alone, so adopting it would widen the epic with
  work the intent does not need. Left outside, and `node-stats-contract` now says
  in as many words: define the shape so a reporter is possible, do not build one.
- `wall-pane-unattended-runs` is the biggest remaining card (epic DAG + overseer
  lease + baton tail + nightshift + three confirmed actions). Not split: both
  halves read from the two routes above and splitting puts two agents in one pane
  file. Flagged here as the likeliest bounce.
- The `LAYOUT` button. Mockup marks it FUTURE, the epic forbids a layout engine
  in v1; told the shell card to render it disabled rather than leave it ambiguous.

Added the missing A7 row to the epic card's pane table -- a card already covered
it, the table just never listed it.

### 2026-08-19T11:20:03.267Z intent [5dda251f-df1f-4b9d-b4a8-0b9e18615355]

Amendment: **I got one edge wrong and an implementer caught it.** Recording it
here because the correction is now part of the plan.

The engine dispatched `wall-filter-bus` while this planning pass was still
running. Its implementer wrote no code, checked the ground, and parked
[wall-filter-bus-q1](.rclaude/project/cards/wall-filter-bus-q1.md): my ordering
made the whole filter card wait for all eleven panes, on the reasoning that
otherwise late panes would each re-invent the filter subscription. That reasoning
assumed panes land first and the bus catches up. With **zero** panes built, every
pane is a late pane -- so the fork I was guarding against would have happened
anyway, by the other road, and this card would then have rewritten eleven panes.

They also read something I had assumed: the pulse grammar is ALREADY
pane-agnostic. I verified both claims before acting rather than taking them at
face value -- `parsePulseQuery` is a pure `string -> PulseQuery`
(`query-parse.ts:157`), and `PulseSearchable` is a structural row shape carrying
the comment they quoted verbatim, *"Kept structural so tests don't need a
Conversation"* (`query-types.ts:69`). Their finding holds.

**Filed `wall-filter-store` (5th new card).** A root with no dependencies: the
store, the reused parser, `useWallFilter(axes)`, and the chip action. All eleven
pane cards now depend on it, so each pane declares its axes as it is built.
`wall-filter-bus` keeps its eleven pane edges and shrinks to the wiring half --
header box, per-pane axis declaration, matched/total in the count slot, the
cross-pane proof. Question card answered and moved to done.

The gain is not scheduling, it is a guarantee: "a pane that cannot interpret an
axis stays full rather than going blank" becomes an API contract instead of
eleven separate good intentions.

The gen-2 overseer rewrote `wall-filter-store` concurrently with me, leaving the
`lib/pulse/` -> `lib/wall/` file move as the implementer's call under a
one-parser-one-matcher constraint. I had decided against the move on collision
grounds and **withdrew that**: the store is a root that every pane depends on, so
a move lands before any pane card starts and nothing concurrent in beats 1-2
touches `lib/pulse/`. The collision I was guarding against cannot occur under the
ordering this split creates. Left the overseer's card as the record and
reconciled my two notes to match, so the board carries no contradiction.

Board now: 22 active, 1 archived, 1 done. Graph re-verified acyclic, every edge
resolves, still 10 beats at ceiling 3 -- the split cost no wall-clock.

**SECOND CORRECTION, same amendment: I withdrew the
`board-card-change-events -> wall-live-channel` edge.** Its implementer built the
card green and showed the conflict basis was false: `CardChanged` belongs in
`SentinelMessage` (a sentinel-originated frame), `BrokerMessage` was never
touched, `message-router.ts` was never touched, and there is no wall fan-in to
collide over because the channel does not exist yet.

They are right, and the mistake is worse than a wrong guess -- it was
**inconsistent with my own reasoning three paragraphs earlier**. I argued
`node-stats-contract` needs no edge precisely because a sentinel-originated
message lands in `SentinelMessage`, ~3500 lines from the other union. A card move
is sentinel-originated too. I applied the test to one card and not the other. The
edge is gone; the card can merge without waiting.

Worth carrying forward as a rule for the next generation: **ask which UNION a
message belongs to, not which subsystem the card is filed under.** Sentinel ->
broker frames and broker -> panel frames do not collide, and two cards on
opposite sides of that line parallelise safely.

Their branch also flags one thing for main, unrelated to this epic:
`web/src/components/project-list/conversation-item-helpers.tsx:418` is
biome-dirty on a clean checkout, so every branch picks up a stray modified file.
They reverted it rather than smuggling it into their commits. One-line fix, needs
its own card.

**FOR JONAS, NOT FOR THE ENGINE:** the implementer's second observation is the
one I cannot fix from here. It was dispatched to a card with eleven unmet
`depends_on`, concurrently with the planning generation that was still writing
those edges. Two roots (`wall-surface-shell`, `wall-live-channel`) went out
correctly at the same time. If the sequencing gate does not hold, the eight pane
cards that depend on those two gates will burn dispatches the same way -- an
implementer boots, reads, finds nothing to build against, and parks. That cost
one full dispatch here and it was only cheap because the implementer stopped
instead of guessing.

### 2026-08-19T11:06:33.208Z dispatch [6b6ee0ec-99b8-42a7-b9d8-30c2bfd1e29a] wall-surface-shell

Implementer dispatched for `wall-surface-shell` at generation 1.

### 2026-08-19T11:06:33.261Z dispatch [8e3b26e5-ca5a-4919-bfb7-8b8191545fa2] board-card-change-events

Implementer dispatched for `board-card-change-events` at generation 1.

### 2026-08-19T11:11:50.394Z dispatch [4d0a517b-c9f8-4db0-918d-0ab8a2d1bf64] node-stats-contract

Implementer dispatched for `node-stats-contract` at generation 1.

### 2026-08-19T11:14:05.397Z dispatch [5dc978ca-fc71-4880-8497-c8ccf737ddd6] wall-filter-bus

Implementer dispatched for `wall-filter-bus` at generation 1.

### 2026-08-19T11:20:05.499Z dispatch [70b64661-cb1d-4eec-811d-84b031b8dd3b] wall-filter-bus

Implementer dispatched for `wall-filter-bus` at generation 5.

### 2026-08-19T11:20:05.543Z dispatch [be3dc07b-74d2-4839-beae-5cbc45aebef9] wall-filter-store

Implementer dispatched for `wall-filter-store` at generation 5.

### 2026-08-19T11:20:50.524Z dispatch [f217565a-638b-458a-a1bd-aecba4f7f814] board-card-change-events

Verifier dispatched for `board-card-change-events` at generation 5.

### 2026-08-19T11:22:20.521Z dispatch [a53d4883-9bec-4d3d-9490-18f53cfddd71] wall-surface-shell

Verifier dispatched for `wall-surface-shell` at generation 5.

### 2026-08-19T11:22:20.618Z dispatch [976e61ec-f036-4c97-89ad-52c50e767e54] node-stats-contract

Verifier dispatched for `node-stats-contract` at generation 5.


### 2026-08-19T18:35:00.000Z intent [a5625f45-2439-4d2b-9ea0-aa22e44bb6e5]

Overseer gen 3, reporting late. **Gen 5 was already spawning when I woke and is
live now.** We reached the same verdict on the open question independently (O2),
and gen 5 found a better root cause for the dispatch bug than I did -- see below.
I did NOT rewrite `run.md`: gen 5 owns the current digest and clobbering it would
destroy a newer generation's work. This entry is append-only and safe. Everything
below is either a fact gen 5 has not recorded, or a correction to something I
overwrote.

**THE FINDING THAT MATTERS -- the board was lying about two cards, and one still
was.** Two branches carried real, committed work while their cards read `open`
and the board reported `0/21, 0 in progress`:

| card | branch | work |
|---|---|---|
| `wall-surface-shell` | `worktree-epic/.../wall-surface-shell` | 467124ca -- 878 insertions, 13 wall files |
| `board-card-change-events` | `worktree-epic/.../board-card-change-events` | 35265fff + 7c57a18a -- 779 insertions, protocol + broker + sentinel + web |

Both implementers had exited without moving their card; no live conversation
remains for either. Gen 5 had already reconciled `board-card-change-events` to
in-review. **`wall-surface-shell` was still `open` -- I moved it to in-review.**
Left as it was, the next beat re-dispatches it and puts a second writer on a
branch with 878 lines already on it.

**Two deviations written onto `wall-surface-shell` for the verifier, not
pre-judged by me:** (1) the twelve pane stub files became one `wall-pane-registry.ts`
array -- cleaner code, but it puts twelve concurrent pane implementers back into
ONE file on adjacent lines, which is exactly the merge collision the stub-file
requirement existed to prevent. That single property decides whether the rest of
this epic can run in parallel. (2) A5, the NOW bar, does not exist on the branch;
the registry has 11 panes, and `wall-now-bar` has nothing to mount into.

**`board-card-change-events` shipped its own WS feed, and `wall-live-channel`
must be told.** It added `card_changed` / `card_ledger_result` to the protocol
and subscribes directly in `use-websocket.ts:384` -- because the `wall` channel
did not exist to fan in through. The planner's edge (ledger depends_on
live-channel) is now inverted in fact: the ledger landed first. `wall-live-channel`
should ADOPT that feed as its first fan-in source rather than leave a second
permanent subscription, or the epic ends with two channels and the intent said
one. **I did not flip the edge** -- gen 5 is live and owns the graph; flipping a
dependency underneath a running generation is how this run got into trouble in
the first place.

**Root cause of the dispatch bug: gen 5's is better than mine, take gen 5's.**
`wall-filter-bus` was the only card writing `depends_on` as a multi-line YAML
flow sequence; the engine's dependency reader did not see that form and scored it
as zero unmet edges. Mechanical, found, fixed by gen 5. My contribution is the
*second* half, which is still open and is filed as
`epic-engine-dispatch-races-planning` (no `epic:` key -- engine machinery, not
THE WALL, so it does not inflate this denominator): four implementers were
dispatched at 11:06-11:14 *while the planning generation was still running*,
which the baton says explicitly must not happen. The planner then rewrote the
graph underneath them and reset `node-stats-contract` from in-progress to open
while an implementer was 4 minutes into it. The YAML fix stops one card being
mis-scored; it does not stop dispatch racing planning, and it does not stop a
finished implementer's status going unrecorded.

**One thing I clobbered and repaired.** I wrote `wall-filter-store` not knowing
gen 5 had just created it, and my version refused the `lib/pulse/` file move
outright. Gen 5's ruling -- the move is the implementer's call, under two hard
constraints (exactly ONE parser and ONE matcher in the tree; pulse's existing
consumers and pinned suites still green with no edit beyond an import path) --
is the correct one and is now restored on the card, marked as superseding my
line. My collision argument was wrong: the store is a root, so it lands before
any pane card starts and nothing concurrent touches `lib/pulse/`.

Gen 5 has the run. Nothing here needs a further gen-3 beat.
### 2026-08-19T11:23:05.487Z dispatch [450b4b02-c1b8-467e-811f-cb2d4d04b8be] wall-openrouter-spend-store

Implementer dispatched for `wall-openrouter-spend-store` at generation 5.


### 2026-08-19T18:35:00.000Z intent [overseer gen 2]

Gen 2 woke LATE, after gens 3 and 5 had already answered `wall-filter-bus-q1`.
I did not re-litigate: I reached the same verdict independently (O2, substrate
first) before reading theirs, and gen 5's ruling stands as the record. Two things
this beat contributed that were not already in the tree.

**1. `wall-filter-bus` was missing the `wall-surface-shell` edge.** It had eleven
pane edges and none to the shell -- yet its remaining scope is the header query
box and the matched/total readout in each `WallPane` count slot, both of which
are the shell's deliverables. Added. It is a wiring card that waits for the frame
it wires into.

**2. THE DISPATCH BUG IS NOT FIXED, AND THE FIX APPLIED WILL NOT HOLD.** Gen 5's
diagnosis was directionally right and the remedy is wrong. I read the parser
rather than inferring it:

`parseFrontmatter` (`src/shared/frontmatter.ts:24`) is line-oriented BY DESIGN --
its own docblock says "a tiny line-oriented subset, NOT a full YAML
implementation ... only flat `key: value` scalars and inline `[a, b, c]` arrays".
On a wrapped list, line `depends_on:` yields `raw = ''` (:32-33) so the key is
set to the empty string, and the continuation lines have no colon so they hit
`continue` (:31) and are DISCARDED. `readLinkage` then skips `''`
(`card-linkage-read.ts:39`) and the key reads as ABSENT. Not mis-scored -- gone.
Round-tripping writes it back as `refs: ""`, which is the exact byte sequence
already filed on `epic-runner-clobbers-refs`. Same defect, two symptoms, and
nobody had connected them.

**Hand-flattening the card does not fix it.** The wrap came from a formatter
reacting to line length (13 entries), so the next edit that pushes any list past
the width deletes it again, silently. Today's board: 21 wrapped lists across 448
cards -- 20 `refs:` and the one `depends_on:` that got mis-dispatched. Every one
of those 20 cards is currently pointing its implementer at nothing.

Filed onto [epic-runner-clobbers-refs](.rclaude/project/cards/epic-runner-clobbers-refs.md)
rather than as a new card -- it is the same root cause, and a duplicate would
split the fix. Retitled, root cause written with line numbers, `refs:` repointed
at `frontmatter.ts` / `card-linkage-read.ts` / `project-card-file.ts`, and given
a RED-first fix plan (teach the parser the wrapped form, keep serializing inline,
then sweep the 20). Kept OUTSIDE `epic-the-wall`, consistent with how gen 3 filed
`epic-engine-dispatch-races-planning`: engine machinery, not THE WALL, and it must
not inflate this epic's denominator. **It is escalated to Jonas, because it
corrupts board data outside this run and no card in this epic will fix it.**

**I did NOT rewrite run.md.** Gen 5 is live and owns the run; rewriting the digest
underneath a running generation is the failure mode this run has already produced
three times over (dispatch racing planning, two overseers writing one card, one
overseer clobbering another's file). The plan of record is still accurate. Gen 2
is done and needs no further beat.

### 2026-08-19T11:24:26.293Z intent [overseer gen 5]

Answered the one question, then found and removed the mechanical reason the
engine kept mis-dispatching. No merges: nothing is terminal yet.

**Q1 ANSWERED -- O2, substrate first, confirmed.** `wall-filter-store` exists
with no dependencies and all ELEVEN pane cards carry an edge to it, so the split
is real on the board and not just in prose. `wall-filter-bus` keeps its pane
edges and shrinks to the wiring half. Question card moved to `done`.

**THE REAL FINDING: a wrapped `depends_on` parses as NO dependencies.** The
implementer's "the dispatcher sent me to a card with eleven unmet deps" was
blamed on the planning race. That explains gen 1. It does not explain gen 5,
which dispatched `wall-filter-bus` again, hours after planning finished, with all
eleven edges written on the card. So I read `src/shared/frontmatter.ts` instead of
theorising. It is a deliberate line-oriented subset (its own docstring says so):
it splits on the first colon and only sees an array if the value starts with `[`
**on that same line**. `wall-filter-bus` was the only card on the board written in
prettier's wrapped flow style (`depends_on:` then `[` indented below), which is
valid YAML and parses to the empty string. Zero dependencies. Cleared the gate
every beat, forever.

Same bug, wider blast radius: **19 cards had a wrapped `refs:`** reading as empty,
so their file pointers never reached the panel. Collapsed every wrapped array in
`.rclaude/project/cards/` to the inline form (backup at
`.claude/claude-archive/2026-08-19-182210-cards/`, diff verified to touch
frontmatter lines only). The serializer only ever emits inline, so machine writes
stay fixed; hand-written cards can drift back, which is why the parser itself
needs the fix. Written up as a second root cause on
[epic-engine-dispatch-races-planning](.rclaude/project/cards/epic-engine-dispatch-races-planning.md)
with a RED-test-first done-criterion. That card stays OUT of this epic -- engine
machinery, not THE WALL.

**One false statement removed from a card about to be built.**
`wall-live-channel` still told its implementer that `board-card-change-events`
depends on it and would collide in the `BrokerMessage` union. Both halves are
false as of now: the edge was withdrawn, and that card is BUILT and `in-review`
with its `CardChanged` in `SentinelMessage` -- I checked the branch, not the note.
Replaced with what its implementer actually needs: do not build a second
card-move fan-in, read `readCardLedger()` from the existing 300-entry ring, expect
a neighbouring-lines conflict in `use-websocket.ts` and nothing semantic, merge
board-card first.

**Filed 1 (low):**
[main-biome-residue-conversation-item-helpers](.rclaude/project/cards/main-biome-residue-conversation-item-helpers.md)
-- `main` carries one line the formatter rewrites, so every worktree shows a stray
modified file the moment anyone runs `lint:fast`. Verified on a clean `main`, not
taken on trust. One line, formatting only. In the epic because twenty implementers
are cutting worktrees off this `main` right now and each one pays a round working
out the dirty file is not theirs.

**Board moved while I worked.** Three cards are `in-review` with real commits:
`wall-surface-shell` (467124ca, 878 insertions, 13 wall files),
`board-card-change-events` (35265fff + 7c57a18a, 779 insertions, 6622/2966 tests
green on branch), `node-stats-contract` (1 commit, 892 insertions). Nothing at
`done`, so nothing merged this beat -- an `in-review` card has not earned a merge
and I am not the verifier. **Merge order when the verdicts land:**
node-stats-contract (SentinelMessage, isolated) -> board-card-change-events
(SentinelMessage + handlers/index + use-websocket bypass) -> wall-surface-shell
(web-only) -> wall-live-channel (BrokerMessage tail, absorbs the ring). All three
touch `src/shared/protocol.ts`; the conflicts are append-at-tail and mechanical.

### 2026-08-19T11:33:00.000Z intent [overseer gen 4 -- WOKEN STALE, ran behind gen 5/6]

**Read this entry for two things only: the NUL-byte defect, and the concurrency
hazard.** Everything else I did was rediscovery of work gen 5 and gen 6 had
already done, because my briefing was several generations out of date.

**I WAS A STALE DUPLICATE.** My briefing said "Generation 4, 0/22 done, 0 in
progress". Reality when I read the board: `node-stats-contract` done AND merged,
three cards `in-review`, a gen 5 intent entry already in this log, card bodies
stamped "overseer, gen 6". I answered q1 (already answered by gen 5) and re-derived
the O4 split (already written onto eleven cards by gen 6). No harm in the answers
-- they agree -- but the beat was largely wasted.

**I CAUSED, DETECTED AND REPAIRED ONE DATA LOSS.** Having appended a duplicate
filter-contract section to all eleven pane cards, I stripped mine with a
read-modify-write. Gen 6 wrote to those files inside the window, so my write landed
on stale content and removed **gen 6's `## Filter wiring -- MANDATORY` block from
all eleven pane cards**. Caught on the verify pass, restored verbatim from my own
earlier read, verified exactly one block per card. It survived only because the
text was still in my context; the board is gitignored, so there was no other copy.
Written up as a third root cause on
[epic-engine-dispatch-races-planning](.rclaude/project/cards/epic-engine-dispatch-races-planning.md)
with done-criteria (overseer lease, no blind read-modify-write on cards, never
delete a question card, a recovery path for a gitignored board).

**THE ONE FINDING NOBODY ELSE HAS: a raw NUL byte makes a `.ts` file BINARY.**
`web/src/hooks/card-ledger-feed.ts` on `worktree-epic/epic-the-wall/board-card-change-events`
contains four literal U+0000 bytes, written as raw bytes rather than escapes, as
the key separator in the dedupe set (~line 73). Git classifies the file as binary:
`git diff --numstat main..HEAD -- <file>` reports `-  -` and the diffstat shows
`Bin 0 -> 3604 bytes`. Consequences: **no diff ever** (review-blind by
construction), **no 3-way merge** (any future conflict degrades to take-mine-or-
take-theirs, which is how work gets silently dropped), and formatters/greps treat
it as a blob. Present in the COMMITTED tree, not just the working copy. Fix is to
write the separator escaped -- runtime behaviour identical. Full finding, with the
verification commands, is on
[board-card-change-events](.rclaude/project/cards/board-card-change-events.md).
That card is `in-review` right now; **its verifier will not see this in a diff,
because there is no diff.** Whoever takes the verdict must check it by hand.

**BOARD CHANGES I MADE (all consistent with gen 6's plan, checked against it):**
- `wall-filter-bus` rescoped to **W2b** -- the header query box, `/` focus, `Esc`
  blur, persistence across surface transitions. `depends_on` cut from thirteen to
  `[wall-surface-shell, wall-filter-store]`. It edits no pane file. A GATE banner
  at the top names two `git log` commands an implementer can run in five seconds to
  confirm both are on `main` before writing anything.
- `wall-filter-crosspane-proof` (**W2c**) filed -- test-only, depends on all eleven
  panes plus W2b, lands last. Gen 6 rewrote it; its version stands.
- `wall-filter-bus-q2` reconstructed after it was deleted from disk mid-answer.
  Gen 6 then rewrote it into the cleaner record that is there now. Either way the
  thirteen citations resolve again.
- `wall-pane-commit-river`: its Done-means still said the dot's filter action
  "belongs to wall-filter-bus". Stale after O4 -- corrected to point at the action
  `wall-filter-store` exports.

**NO MERGES BY ME.** `node-stats-contract` was already merged (9b1d9f30, in `main`
at 505e067f) before I looked. `board-card-change-events` (ahead 2) is `in-review`
and I am not its verifier. `wall-surface-shell` (ahead 2) is `in-progress` with a
live writer. Gen 5's merge order still holds: node-stats-contract -> board-card ->
wall-surface-shell -> wall-live-channel.

**FOR THE NEXT GENERATION -- the two live hazards, in order:**
1. **Check whether another overseer is awake before you write anything.** Read the
   tail of this log first: if it carries a generation number higher than yours, your
   briefing is stale and your job is to verify, not to re-decide. Re-read any card
   immediately before you write it.
2. **The NUL byte above is invisible to code review.** It ships silently unless
   someone checks it by hand on `board-card-change-events`.
### 2026-08-19T11:32:05.553Z dispatch [bf031973-2919-48e7-a60f-33e3d22ad554] wall-openrouter-spend-store

Verifier dispatched for `wall-openrouter-spend-store` at generation 6.

### 2026-08-19T11:32:05.630Z dispatch [7baa0e46-76bb-4996-810b-ac268d94f8d5] main-biome-residue-conversation-item-helpers

Implementer dispatched for `main-biome-residue-conversation-item-helpers` at generation 6.


### 2026-08-19T11:32:00.000Z intent [2db7f01e-1cb0-4d8b-a578-a151270c2f4b]

Overseer gen 6. **First merge of this epic landed, and two overseer generations
were awake on the same beat again.**

**MERGED: `node-stats-contract` -> local `main` `9b1d9f30`.** Its verifier
approved it (card moved to `done`) while I was mid-beat. Rebased its branch onto
`7b8bf4c5` in its own worktree (clean, owner exited), fast-forwarded `main`,
then verified ON `main`: `node-stats*.test.ts` 40 pass / 0 fail, `typecheck`
clean, `lint:boundary` PASS.

**`git push origin main` was DENIED** by the unattended deny floor (push-to-main
is in the catastrophic set). I did not retry or work around it. Local `main` is
correct and is the source of truth; **origin is one commit behind until a human
pushes.** Every later generation should expect the same denial -- do not burn a
beat on it.

**q2 answered O4 -- and gen 4 answered it identically, in parallel.** We reached
the same verdict independently, which is reassuring about the verdict and damning
about the engine. What actually happened, so nobody reconstructs it wrong from
the digest: I appended a "Filter wiring -- MANDATORY" block to all eleven pane
cards at 18:25; gen 4 appended its "THE FILTER CONTRACT" block to the same eleven
at 18:26. **Both were present on every card** -- I measured it, 11/11 -- so eleven
cards carried two overlapping instructions written by two overseers. **I deleted
MINE and kept gen 4's**, because gen 4's is more specific and because
`wall-filter-bus` already references it by name. Verified after: exactly one
contract section per card. I also overwrote gen 4's `wall-filter-crosspane-proof`
with my own version of the same card before I knew it existed; the surviving
content is functionally what both of us specified, but that overwrite is a real
loss and the board is gitignored, so there is no other copy.

**THE EDIT THE q2 ANSWER LEFT DANGLING -- this is the substantive thing I added.**
Answering O4 shrinks `wall-filter-bus` to the header query box with two early
dependencies. But `wall-time-cursor` and `wall-navigation-and-hover` both
depended on `wall-filter-bus` *specifically because it transitively carried all
eleven pane edges* -- gen 0 wrote that reasoning down. Shrink the bus and that
edge silently stops meaning anything: both cards become dispatchable while zero
panes exist, which is precisely the empty-tree dispatch that already burned three
implementer runs on the bus itself. Filed
[wall-filter-crosspane-proof](.rclaude/project/cards/wall-filter-crosspane-proof.md)
(test-only, eleven pane edges, fixes the shared substrate but never a pane) and
repointed both cards at it, with the reason written onto each.

**Rule for the next generation, from this:** when you shrink a card, check what
depended on it and WHY. A dependency edge often encodes a reason that is not the
card's title. Re-scoping without re-reading the inbound edges converts a correct
graph into a plausible-looking wrong one.

**FOUND BY HAND: `web/src/hooks/card-ledger-feed.ts` is BINARY to git.** Lines 73
and 74 embed four raw U+0000 bytes as dedupe-key separators, written as literal
bytes instead of the escape. `git show --stat` reports `Bin 0 -> 3604 bytes`: no
line diff ever, so no reviewer or verifier can see the file's contents change,
and no 3-way merge, so any future conflict degrades to take-mine-or-take-theirs.
I found it because the diffstat looked wrong, not because any tool flagged it --
and the verifier holding that card right now cannot find it in a diff either.
Written onto `board-card-change-events` as a fix for that card (one line, in a
file it already owns), not split off as a separate defect. The NUL-as-separator
idea is right; only the encoding is wrong.

**TOLD `wall-live-channel` TO ADOPT THE LEDGER'S FEED.** Verified gen 3's claim
on the branch rather than trusting it: `protocol.ts:4335` adds `card_changed`,
and `use-websocket.ts:383-385` routes it plus `card_ledger_result` straight into
`card-ledger-feed.ts`. That is a second permanent panel subscription and the
epic's intent says ONE `wall` channel. `wall-live-channel` is the only card that
can honour that, so it now must fan the ledger in and delete the direct route --
or state the exception out loud and file a card. Its module-level single-feed
design stays; only the transport moves.

Nothing else was dispatchable by me and I dispatched nothing -- the engine owns
that. Board at the end of this beat: 1 merged, 1 done, 2 in-review, 1 in-progress,
the rest open, plus one new card (`wall-filter-crosspane-proof`).
### 2026-08-19T11:32:50.612Z dispatch [74d9375f-de28-4624-a656-0f3c08f4bb0b] wall-filter-store

Verifier dispatched for `wall-filter-store` at generation 6.

### 2026-08-19T11:33:35.586Z dispatch [59372b0c-a721-49d9-a41d-1df07883a6f2] main-biome-residue-conversation-item-helpers

Verifier dispatched for `main-biome-residue-conversation-item-helpers` at generation 6.

### 2026-08-19T11:40:20.855Z dispatch [ccc1b038-e208-41e1-a850-0fb8c228a16a] board-card-change-events

Verifier dispatched for `board-card-change-events` at generation 6.

### 2026-08-19T11:47:05.854Z dispatch [ac7be7eb-483c-4c15-bd2d-21c85d58c281] wall-card-changed-broadcast-retire

Implementer dispatched for `wall-card-changed-broadcast-retire` at generation 6.

### 2026-08-19T11:50:50.945Z dispatch [a53eaccf-cd07-449e-b6f3-d087abc9c979] wall-live-channel

Verifier dispatched for `wall-live-channel` at generation 6.


### 2026-08-19T11:56:00.000Z intent [fad3ed13-84e3-4613-a1fc-25d94e21c1f8]

Overseer gen 8. **I deliberately wrote almost nothing, and that was the correct
beat.** The one finding below is the reason, and it is the root cause of every
collision gens 3, 4 and 6 wrote up as a mystery.

**FOUR OVERSEER GENERATIONS ARE LIVE AT ONCE: 7, 8, 9 and 10.** Not a stale
briefing, not a late waker -- `list_conversations` returns all four with
`status: live` simultaneously. Gens 3/4/6 each hit this as "another overseer was
awake on the same beat" and each treated it as bad luck. It is not bad luck; it
is a broken lease, and it is now running four-wide.

**ROOT CAUSE, WITH THE VERSIONS -- and the fix is already written.** Jonas
committed [`6a76d3f3`](6a76d3f3) *"fix(epic): the lease named a holder nothing
could ever resolve"* at **18:49:07** today. Its own message describes this exact
failure: the wake takes the lease under a `pending-` placeholder, the swap to the
real conversation id was never written, so `break_lease` cannot refuse a live
holder (a placeholder resolves to nothing) and the CAS asked
`group.overseerAlive` -- "is SOME overseer-tagged conversation live" -- which is
true in precisely the case the CAS exists to refuse. It touches
`src/broker/epic-sweep.ts`, `epic-sweep-loop.ts`, `src/shared/epic-lease.ts`.

**The running broker does not have it.** `docker exec broker printenv
GIT_COMMIT_SHORT` = `8ca00fa6`, built **15:45:12**. The fix landed **three hours
later**. `git merge-base --is-ancestor 6a76d3f3 8ca00fa6` = NO. So the live epic
engine is still spawning an overseer per settle with the broken CAS, and will
keep doing so until the broker is redeployed. **A broker deploy is outside an
overseer's authority** (it recreates the container and drops every live
WebSocket), so no generation can fix this from inside the run. Escalated to Jonas
as the checkpoint for this beat.

**WHAT THIS MEANS FOR THE NEXT GENERATION -- read before you write anything.**
Until the broker carries `6a76d3f3`, assume you are one of several live
overseers. The board is gitignored, so a blind read-modify-write that loses
another generation's text is unrecoverable -- gen 4 destroyed eleven cards' worth
of gen 6's work this way and recovered it only because the text happened to still
be in its context. Concretely, this beat: I resolved to merge `wall-filter-store`
and `wall-openrouter-spend-store`, and while I was diagnosing, another generation
fast-forwarded **both** (`main@{18:54:38}`, `main@{18:54:44}`) and flipped
`wall-card-changed-broadcast-retire-q1` to `done`. Had I raced, two overseers
would have been rebasing the same branches into `main` concurrently. **Prefer
append-only writes and re-read immediately before every card write.**

**q1 IS ANSWERED AND THE ANSWER IS RIGHT.** I verified gen 7's verdict
independently at `ea882907` *before* reading it, and reached O1 on the same
evidence: `publishWallCardMoves` (PLURAL -- the singular grep is what misled the
implementer) has two real callers, `src/broker/handlers/card-ledger.ts:59` and
`src/broker/wall/wall-sources.ts:99`, and the panel-side `card_changed` bypass is
gone from `use-websocket.ts` (only a comment survives at :393). The wiring gap O3
was going to assign is already closed by `wall-live-channel` itself. F1 was the
whole defect: an empty `depends_on`, now `[board-card-change-events,
wall-live-channel]`. No further input needed on it.

**MAIN IS GREEN AFTER THE TWO MERGES -- I checked, because the merging generation
may not have.** On `main` at `6273fea6`: `bun run typecheck` exit 0,
`bun run lint:boundary` PASS, `bun test src/broker/openrouter` **10 pass / 0
fail**, `bunx vitest run src/lib/wall/ src/lib/pulse/` **170 pass / 0 fail** (the
filter substrate's 47 plus pulse's untouched 123 -- the identity assertion that
guards against forking pulse's parser holds on `main`). The pre-existing
project-board test failures are unrelated and still stand.

**I did NOT rewrite `run.md`.** Gen 7 wrote it at 18:53:50, 26 seconds before I
read it, and gens 9 and 10 are both live and newer than me. Rewriting the digest
underneath three live generations is the failure this entry exists to stop.

### 2026-08-19T11:56:00.000Z intent [overseer gen 7]

Answered the one open question, **merged two more cards into local `main`**, and
found that the question's blocking premises were stale by a single commit.

**q1 ANSWERED -- O1, sequence only. Rejected O3.** The implementer asked who
would wire `publishWallCardMove`, having found zero callers. **It already has
two.** The function is PLURAL -- `publishWallCardMoves` -- and their singular
grep matched only the definition, because the singular substring survives just
once, in a comment. Verified at `wall-live-channel`'s head `ea882907`:
`src/broker/handlers/card-ledger.ts:59` and `src/broker/wall/wall-sources.ts:99`.
Their F3 was equally stale: the panel-side `card_changed` bypass in
`use-websocket.ts` is GONE at head, `use-card-ledger.ts` no longer exists, and
`git grep card_changed -- web/` returns one docstring hit.

**The timing is the lesson, and it is worth carrying.** `ea882907` ("the card
ledger rides the wall channel, not a route of its own") was committed
**18:49:06 +0700**. The question was filed **18:50:32**. The implementer was
reasoning about a ref **86 seconds** behind the tree, and every one of their
three premises was true at the commit they held and false at the commit that
existed. They named their base explicitly (`3538c065`), which is the only reason
this was cheap to diagnose -- that habit is worth keeping. The habit to add:
`git fetch` and re-read HEAD before declaring a premise false.

Their F1 was TRUE and was the whole answer -- `main` has no
`src/broker/handlers/card-ledger.ts`. The card carried an **empty `depends_on`**
and was dispatched into a base where its target does not exist. One missing edge,
not a missing owner. Set `depends_on: [board-card-change-events,
wall-live-channel]`. Nothing added to anyone's scope; O3 would have assigned a
wiring job that is already done.

Also ruled the half they asked me not to leave open: **`card_ledger_request` /
`card_ledger_result` RETIRE with the broadcast.** Checked the obvious objection
first -- retiring it does not cost the project board its live updates, because
the board rides `project_changed` (`handlers/project.ts`, untouched). The
`card_changed` relay was only ever THE WALL's P3 feed, per the module's own
docstring, and the wall now gets it through the frame. No non-wall reader exists
to keep it for. Card's revised scope is ~40 deleted lines, not the ~20 estimated:
the read path is bigger than the broadcast, and its docstring and `canRead()`
helper go with it.

**MERGED TWO CARDS to local `main`.** Both were `done` (which under the `full`
gate means an independent conversation approved them) with unmerged branches --
nobody had collected them.

| Card | Branch | Merge |
|---|---|---|
| `wall-filter-store` | rebased 13 behind -> clean | `55bcebae`, +856 across 9 files, all new |
| `wall-openrouter-spend-store` | rebased 12 behind -> clean | `6273fea6`, +691/-21 across 6 files |

Verified ON `main` after both, not on the branches: `bun run typecheck` exit 0,
`bun run lint:boundary` PASS, `bun test src/broker/openrouter-spend-store.test.ts
src/broker/routes/__tests__/stats-openrouter.test.ts` **15 pass / 0 fail**,
`cd web && bunx vitest run src/lib/wall/` **47 pass / 0 fail**. `main` is green
at `6273fea6`.

**`git push origin main` DENIED again**, exactly as gen 6 documented. Local
`main` is the source of truth and carries three merged cards; origin is behind
until a human or an authorized writer pushes. Do not spend a beat on it.

**Consequence for the graph: `wall-filter-store` is now ON `main`.**
`wall-filter-bus` has two deps and one is satisfied -- it becomes dispatchable
the moment `wall-surface-shell` lands. That is the critical path now.

**BOTH BOUNCES ARE CORRECT AND I LEFT THEM.** `board-card-change-events` (G1,
NUL bytes) and `wall-surface-shell` (B1, palette command missing its `when`
guard while the modal is admin-gated) are same-card, one-line fixes. Neither is a
separate defect and neither moves forward by me.

**But G1 has a merge trap, and I wrote the way out onto the card.** The NUL bytes
are still in the committed blob at `35265fff` (re-measured: `tr -dc '\000' | wc -c`
prints 4). **A NUL-free version of that exact file already exists** at
`wall-live-channel`'s `ea882907` -- prints 0, and `--numstat` gives a real `72 0`
instead of `-  -`. That branch merged board-card at `3538c065`, then rewrote the
file to ride the wall frame. So R7 dies on its own at the wall-live-channel merge.
The instruction on the card is therefore: **fix G1 with the minimal escape change,
never a rewrite.** Merge order is board-card -> wall-live-channel, and the wall
version of that file supersedes; a minimal diff makes that conflict a trivial
take-theirs, a competing rewrite makes it a real three-way merge in a file that
was binary to git an hour ago.

**No replanning was needed beyond the one edge.** The graph gen 6 left is sound;
`wall-filter-store` merging validated its ordering rather than contradicting it.

### 2026-08-19T11:56:00.000Z intent [b6c08e29-b4aa-4731-9f71-44b311a83b24]

Overseer gen 10. **Nothing on my worklist was mine to do -- all of it was already
done by a generation running beside me. So I verified what nobody had verified,
and found why the generations keep overlapping.**

**MY BRIEFING WAS STALE ON EVERY POINT.** It said 5/27 done, one open question
(`wall-card-changed-broadcast-retire-q1`), nothing dispatchable. Reality:

- **q1 was ANSWERED and `done`** -- gen 7 wrote the decision (O1, sequence only)
  and set `depends_on: [board-card-change-events, wall-live-channel]` on
  [wall-card-changed-broadcast-retire](.rclaude/project/cards/wall-card-changed-broadcast-retire.md).
  It finished writing at **18:54:10**, and I read the file at **18:54:36** -- a
  26-second gap. Had I woken half a minute earlier I would have answered it a
  second time, in parallel, exactly as gens 4 and 6 both answered q2.
- **Both merge candidates were already merged.** `wall-filter-store` (`55bcebae`)
  and `wall-openrouter-spend-store` (`6273fea6`) are fast-forwarded onto local
  `main`. Three of this epic's cards are now on local `main`; `origin/main` is
  still `da024c7a`, three commits behind, because the push denial stands.

**WHAT I ACTUALLY CONTRIBUTED: `main` is GREEN after those two merges, and no one
had checked.** Both were merged by another generation minutes before I woke and
neither merge was followed by a verification pass on `main` itself. Run at
`6273fea6`:

| gate | result |
|---|---|
| `bun test src/broker/openrouter-spend-store.test.ts src/broker/routes/__tests__/stats-openrouter.test.ts` | **15 pass / 0 fail** |
| `bunx vitest run src/lib/wall/` (3 files) | **47 pass / 0 fail** |
| `bun run typecheck` (root **and** web) | clean |
| `bun run lint:boundary` | **PASS** |

Logs in `.claude/temp/gen10-*.log`. One process note worth carrying: my first
typecheck run reported clean but had inherited a `cd web` from an earlier call,
so it only covered the web half. The Bash tool's working directory persists
between calls. Re-run from an absolute path before believing a green gate.

**THE FINDING -- FOUR OVERSEERS ARE AWAKE RIGHT NOW, AND THE FIX FOR IT IS
COMMITTED BUT NOT RUNNING.** `list_conversations` at 18:55, all `live`, all with
input in the last three minutes:

| conversation | last input |
|---|---|
| overseer gen 7 | 3m |
| overseer gen 8 | 2m |
| overseer gen 9 | 2m |
| overseer gen 10 (me) | 1m |

R8 recorded this at concurrency **2** and cost gen 6's filter-contract block on
eleven cards. It is now **4**, on a board that is gitignored and has no other copy.

The cause is not the board and not the overseers. Jonas committed
**`6a76d3f3` "fix(epic): the lease named a holder nothing could ever resolve"**
at **18:49:07** today -- the CAS that is supposed to refuse a wake while the
holder is alive was asking `group.overseerAlive` ("is ANY overseer live"), which
is true in precisely the case the check exists to refuse. That is exactly this
bug, and it is fixed in the source. **It is not in the running broker.**

```
running broker: 8ca00fa6  (built 15:45)   docker exec broker printenv GIT_COMMIT_SHORT
lease fix:      6a76d3f3  (18:49)
git merge-base --is-ancestor 6a76d3f3 8ca00fa6  ->  NO
```

The container has been up since 08:48 UTC. So the deployed CAS is still the
broken one, and it will keep granting overlapping wakes for as long as the
container runs. **Gen 11 will overlap gen 10 the same way**, and every generation
after it, until the broker is rebuilt. That is also why the panel showed
"lease null . never woken" while five generations ran -- same commit, the
`pending-` placeholder that never got swapped for a real id.

**This is a CHECKPOINT and I have raised it with Jonas.** A broker deploy is
explicitly outside the standing web license (`docker compose up -d` recreates the
container and drops every live WebSocket), so it is his call and no overseer may
make it. I did not deploy and did not restart anything.

**BOARD CHANGES: none.** No question to answer, no verdict to hand down, no merge
to make, and the graph is correct as gens 6-9 left it. With three other overseers
mid-write I deliberately made no read-modify-write against any card -- that is the
mechanism that destroyed gen 6's work, and there was nothing I needed to change
badly enough to risk it. My run.md edits are surgical `Edit` calls with exact-match
anchors, so a concurrent rewrite makes them FAIL rather than silently clobber.

**STILL IN FLIGHT, for whoever wakes next:** `wall-live-channel` and
`main-biome-residue-conversation-item-helpers` are `in-review` with a live verifier
on the former (`a53eaccf`, last input 4m). `board-card-change-events` and
`wall-surface-shell` are `in-progress`. **R7 stands: the four raw NUL bytes in
`web/src/hooks/card-ledger-feed.ts` make it binary to git and its verifier cannot
see them in a diff.** Check it by hand before that card is allowed to merge.

### 2026-08-19T11:57:00.000Z intent [overseer gen 9]

**Three overseer generations were awake on this beat and I was one of them.** My
briefing said "gen 9, 5/27 done, 1 open question". By the time I had read the
question card it was already `done` -- gen 7 answered it at 18:54:10, 20 seconds
after I read it as `open`. `run.md` reads `gen: 10`. So I deliberately did NOT
re-decide anything and did NOT rewrite a file wholesale. Appends only, targeted
edits only. This entry records the two things that were still unclaimed.

**On q1 I reached gen 7's verdict independently before reading it, which is worth
one line as corroboration and no more.** I verified at `ea882907`, by sha:
`publishWallCardMoves` (PLURAL -- the question grepped the singular) has two real
callers, `src/broker/handlers/card-ledger.ts:59` and
`src/broker/wall/wall-sources.ts:99`; and the panel-side `card_changed` bypass is
gone -- `use-websocket.ts:393` now carries only a comment saying so. O1, sequence
only, no third card. Gen 7's answer stands and I added nothing to it.

**1. MAIN TOOK TWO MORE MERGES DURING THIS BEAT, AND NOBODY HAD VERIFIED THEM.**
`main` moved from `da024c7a` to `6273fea6` while I was mid-check:
`wall-filter-store` (`55bcebae`) then `wall-openrouter-spend-store` (`6273fea6`),
both fast-forwarded by a concurrent generation. Three cards are now merged, not
one. I ran the verification that step 3 asks for and that no log entry claimed:

| check | result |
|---|---|
| `bun run typecheck` (root + web) | clean |
| `bun run lint:boundary` | PASS |
| `bun test src/broker/__tests__` | 355 pass / 52 skip / **0 fail** |
| `cd web && bunx vitest run src/lib/wall` | 47 pass / 0 fail |

**`main` is green after both merges.** No new card needed. One note for whoever
runs web tests next: `web/` is **vitest**, not `bun test` -- I ran `bun test` on
`src/lib/wall` first and got 11 fake failures (`document is not defined`). That
is a bad invocation, not a regression, and it will fool the next agent too.

**2. THE MERGE HOLD NOBODY HAD WRITTEN DOWN -- `wall-live-channel` is `done` and
must NOT be merged yet.** It flipped to `done` during this beat and sits 6 ahead
of `main`. A fresh generation reading the board will merge it on sight, and that
is wrong, because the reason is invisible from its own card:
`board-card-change-events` is an **ancestor** of it (`35265fff`, merged in at
`3538c065`), and that card was BOUNCED and is `in-progress` -- its
`card-ledger-feed.ts` still carries four raw U+0000 bytes at `35265fff`. Merging
`wall-live-channel` now drags the verifier-rejected binary blob into `main`
through the back door and strands the fix on a card nobody redispatches once its
branch reads merged.

I verified both halves by sha rather than trusting the record (my own first pass
gave false zeros -- `git cat-file -p <branch-with-slashes>:<path>` swallowed under
`2>/dev/null` -- so these are the corrected numbers):

```
git cat-file -p 35265fff:web/src/hooks/card-ledger-feed.ts | tr -dc '\000' | wc -c   # 4  <- still binary
git cat-file -p ea882907:web/src/hooks/card-ledger-feed.ts | tr -dc '\000' | wc -c   # 0  <- wall-live-channel is clean
git diff --numstat 505e067f..ea882907 -- web/src/hooks/card-ledger-feed.ts           # 72  0
```

Written onto [wall-live-channel](.rclaude/project/cards/wall-live-channel.md) as a
`## MERGE HOLD` section, with the conflict resolution **pre-decided** so the next
merger does not deliberate it: the merge base holds the binary version, so git
degrades to `Cannot merge binary files` and take-one-side -- **take
`wall-live-channel`'s version wholesale**, then assert 0 NUL bytes before
committing. And **do not amend `35265fff`** to fix the NULs: rewriting it orphans
this branch's merge commit and turns a one-file take-theirs into a six-commit
replay. The escape fix goes on top as a new commit, which is what
`board-card-change-events` already instructs.

**I merged nothing.** The only `done` card with an unmerged branch is
`wall-live-channel`, and the paragraph above is the reason it stayed put. That is
a decision, not an omission.

**For the next generation:** the critical path is now one card wide. Nothing
downstream moves until `board-card-change-events` lands its ~4-byte escape fix --
`wall-surface-shell` and `wall-live-channel` are the two gates and nine pane cards
sit behind them. If that card is not in flight, it is the single highest-value
dispatch on the board.

### 2026-08-19T11:58:00.000Z checkpoint [fad3ed13-84e3-4613-a1fc-25d94e21c1f8]

**RUN PAUSED BY JONAS at generation 10/40. Overseer lease released.**

Gen 8 escalated the four-wide overseer overlap (gens 7/8/9/10 all `live`
simultaneously) with three options: redeploy the broker to activate the lease fix
`6a76d3f3`, carry on four-wide, or pause. **Jonas chose PAUSE.**

Reading of that choice, for whoever resumes: the broker rebuild was declined *for
now*, not rejected. Pause stops new overseer spawns without dropping every live
WebSocket, which is the cheaper half of the same remedy -- it removes the symptom
(concurrent generations clobbering a gitignored board) and leaves the cause
(`8ca00fa6` predates `6a76d3f3` by three hours) in place.

**THE RESUME PRECONDITION.** `epic_run action=start` resumes and never resets the
generation counter. But resuming against the SAME container reinstates the exact
fan-out that caused the pause -- the deployed CAS still asks "is ANY overseer
live" rather than "is THE HOLDER alive". So: **rebuild the broker first, then
resume.** Resuming without the rebuild reproduces R8 at concurrency 4 and the
next generation will be right back here.

**STATE AT PAUSE -- nothing is lost and nothing is half-written.**

- `main` GREEN at `6273fea6`, three cards merged: `node-stats-contract`
  (`9b1d9f30`), `wall-filter-store` (`55bcebae`), `wall-openrouter-spend-store`
  (`6273fea6`). Verified independently by gens 7, 9 and 10 -- typecheck (root and
  web), `lint:boundary` PASS, `src/broker/__tests__` 355 pass / 0 fail, web
  `src/lib/wall/` 47 pass / 0 fail.
- Local `main` is **three commits ahead of `origin/main`** and needs an
  authorised push. Overseers cannot push (unattended deny floor).
- Two cards bounced with correct findings, both same-card one-line fixes:
  `board-card-change-events` (G1, four raw NUL bytes) and `wall-surface-shell`
  (B1, ungated palette entry). **Findings intact, cards not moved forward.**
- `wall-live-channel` is `done` and **deliberately HELD** unmerged -- gen 9's
  ruling, with its expiry and pre-decided binary-conflict resolution on the card.
  A fresh generation running the done-plus-unmerged sweep will try to merge it on
  sight. Read the `## MERGE HOLD` section before touching it.
- All three question cards are answered and `done`. No card is waiting on a
  human except through the broker rebuild above.

The critical path on resume is unchanged: **`wall-surface-shell`**. The moment it
lands, `wall-filter-bus` and all eleven pane cards unblock at once.
### 2026-08-19T13:46:23.669Z dispatch [5d16406f-818f-46ab-8a21-32f78ff6fec5] main-biome-residue-conversation-item-helpers

Verifier dispatched for `main-biome-residue-conversation-item-helpers` at generation 10.

### 2026-08-19T13:46:25.882Z completion [broker] main-biome-residue-conversation-item-helpers

Card `main-biome-residue-conversation-item-helpers` settled: every backing conversation has ended. Read the card for what it claims and its gate evidence for what it proved.


### 2026-08-19T14:15:00.000Z intent [104f08c7-56a6-4ecf-bac5-3ea5720f6a9a]

Overseer gen 11. **The epic was not blocked on dependencies. It was blocked on a
lane the dispatcher does not read, and it had been for five generations.**

**THE FINDING. A bounced card parked at `in-progress` is NEVER dispatched again.**
`src/shared/epic-ready.ts:91` is the whole bug:

```js
if (child.bucket !== 'notStarted' || inFlight.has(child.card.slug)) continue
```

and `src/shared/epic-cards.ts:30-37` maps BOTH `in-progress` and `in-review` into
the `inProgress` bucket. So the dispatch lane draws only from `open`/`inbox`.
`in-review` at least keeps re-firing a verifier (`epic-ready.ts:58-60`, uncapped);
`in-progress` fires nothing at all, and the `inFlight` liveness check never even
runs because the bucket test short-circuits first.

**Our own prompt tells every generation the opposite** -- "leave it, it
redispatches". Gens 6 through 10 read that, left the two bounced cards alone, and
the cards sat. `wall-surface-shell` has **twelve cards** behind it. The digest
truthfully reported "nothing ready: X <- wall-surface-shell" every beat and never
said the card being waited on was invisible to the planner. That is why this
survived five generations: it is indistinguishable from a healthy dependency
stall.

Filed as [epic-bounced-card-never-redispatched](.rclaude/project/cards/epic-bounced-card-never-redispatched.md),
high priority, RED-test-first, with the preferred fix named (bounce to `open`
rather than teaching the pure graph function about liveness -- keep `epic-ready`
exactly answerable) and a fourth done-criterion that the prompt itself gets
corrected. Kept OUT of this epic, like the other two engine cards.

**ZERO workers were alive.** `list_conversations` returns no conversation for any
wall card -- not an implementer, not a verifier. All three "occupied" slots were
held by dead workers. `inFlight` was empty, so the concurrency ceiling was never
the constraint either; the briefing's "held back by the ceiling: none" was
accurate and misleading at the same time.

**I am also the only overseer alive, and that is new.** The running broker is
`b9713c4c` and `git merge-base --is-ancestor 6a76d3f3 b9713c4c` = YES, so the
lease fix gens 8 and 10 escalated is DEPLOYED. The four-wide overlap that cost
gen 6 eleven cards' worth of writing is over. Successors can stop writing
defensively -- though every edit I made this beat was still append-only, because
the board is gitignored and that costs nothing.

**THREE CARDS MOVED.**

| card | move | why |
|---|---|---|
| `wall-surface-shell` | in-progress -> **open** | dead worker, dead lane. B1+B2 intact, nothing re-litigated |
| `board-card-change-events` | in-progress -> **open** | same. G1's four NUL bytes re-measured, still 4 |
| `main-biome-residue-conversation-item-helpers` | in-review -> **done** | already fixed on `main` -- see below |

The two reopens are NOT new bounces and I said so on both cards in those words.
The findings stand verbatim; each card now names the exact remaining work (one
`when` guard + a 164-line test split; four bytes to escape) and warns that the
branch is 36 behind and must be rebased before the verifier's green numbers mean
anything again.

**THE BIOME CARD WAS FIXED BY SOMEONE ELSE ENTIRELY.** It sat in `in-review` for
three generations while two verifiers were dispatched and both settled without
recording a verdict. Meanwhile `main` picked up the identical change from an
unrelated worktree: `7283ca66 style(sidebar): wrap the display-colour shell style
at the line limit` -- `worktree-theme-neon-ramp` was editing the same function and
let biome win. Verified rather than assumed:
`git diff main <branch> -- <file>` is EMPTY (byte-identical) and
`bunx biome check` on that file exits 0 from `main`. Both Done-means boxes hold on
`main`. **Its branch must never be merged** -- the commit is a no-op now and the
branch is 33 behind; I wrote that onto the card in a section aimed squarely at the
next generation's done-plus-unmerged sweep.

**`wall-live-channel` STAYS HELD, and now the hold has an expiry.** Gen 9's ruling
is still correct -- `35265fff` is an ancestor of this branch and still carries the
four NUL bytes, so merging today drags a binary blob into `main` and strands the
fix. What changed is that the blocker can move again: `board-card-change-events`
is back in a dispatchable lane. Order unchanged: board-card merges first with the
minimal escape fix, then this rebases and its NUL-free version of
`card-ledger-feed.ts` wins the one conflict wholesale.

**A STALE ALERT, CORRECTED.** The state-of-union says "Main is RED:
project-board/launch-handoff.test.tsx + task-editor-focus.test.tsx fail on clean
checkout". Not true at `b9713c4c`: `bunx vitest run src/components/project-board/`
gives **15 files / 87 tests, all passing**, and both named files are in that
directory. Somebody fixed it and the SOTU did not catch up. Worth knowing, because
both reopened implementers will run the web suite and would otherwise waste a
round deciding whether they broke it.

**NO MERGES THIS BEAT.** The only `done` card with an unmerged branch is
`wall-live-channel` and the paragraph above is the deliberate reason it stayed
put. The biome branch is `done` and unmerged by design. `main` is untouched by me
and still equals `origin/main` at `b9713c4c` -- the push denial that blocked gens
6 and 7 is moot now, someone pushed.

**FOR GENERATION 12.** The board should finally dispatch: `wall-surface-shell` and
`board-card-change-events` are both `open` with satisfied dependencies, three free
slots, and no live workers to collide with. If it does NOT dispatch them, the
engine bug is worse than diagnosed and that card needs re-opening with the new
evidence. `wall-surface-shell` is the critical path -- twelve cards unblock the
moment it reaches `done`.
### 2026-08-19T13:55:23.747Z dispatch [948492ce-c4a2-41e9-9c91-2b135ead23b5] wall-surface-shell

Implementer dispatched for `wall-surface-shell` at generation 11.

### 2026-08-19T13:55:23.831Z dispatch [b2479a36-a7d4-493b-9bd9-6396b9d28730] node-stats-http-ingest

Implementer dispatched for `node-stats-http-ingest` at generation 11.

### 2026-08-19T13:55:23.980Z dispatch [bd7a79fd-ef79-42ab-9834-a1fa8ee2c555] board-card-change-events

Implementer dispatched for `board-card-change-events` at generation 11.

### 2026-08-19T13:56:08.567Z completion [broker] board-card-change-events

Card `board-card-change-events` settled: every backing conversation has ended. Read the card for what it claims and its gate evidence for what it proved.

### 2026-08-19T13:56:08.571Z completion [broker] wall-surface-shell

Card `wall-surface-shell` settled: every backing conversation has ended. Read the card for what it claims and its gate evidence for what it proved.



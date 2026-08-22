# Epic Mode -- running an epic to completion

> **Epic mode is not a fourth engine.** It is nightshift with a scope (one epic
> card), an ordering (`depends_on`), and a supervisor leg between the workers and
> Jonas. Dispatch, caps, the watchdog, the guardians and the deterministic
> DONE-gate are all the machinery that already existed.

---

## 1. The three seats

The whole design is one sentence: **separate the doer, the judge, and the one
who decides what happens next.** Each seat is a different process with different
settings, not a different paragraph in the same prompt.

| Seat | Does | May NOT |
|---|---|---|
| **WerkWorker** | One card, own worktree, own branch. Moves the card to `in-review` when done. | Block on a human. Approve its own work. Touch another card or branch. |
| **WerkVerifier** | Re-runs the acceptance command, reads the diff, approves or bounces. | Block on a human. See the werk-worker's conversation. |
| **WerkMaster** | Answers questions, merges verified work, replans the board, decides when to stop. Singleton. | Implement a card itself. Spawn anything. |

The werk-worker/werk-verifier split is not ceremony. Anthropic's harness work found
that *"agents tend to respond by confidently praising the work"*, and Cognition
measured a review agent catching ~2 bugs per PR (58% severe) -- but only when the
reviewer **did not share the coder's context**. A reviewer that reads the coder's
reasoning inherits the coder's blind spots. So `planWerkVerifierSpawn` hands over the
card and the diff, never the transcript.

---

## 2. The loop

```
                            ┌──────────────────────────────────┐
                            │             JONAS                │
                            │  the ONLY human in the loop      │
                            └───▲──────────────────────┬───────┘
                    question /  │                      │  steer / GO
                    checkpoint  │                      ▼
   ┌────────────────────────────┴──────────────────────────────────────┐
   │  EPIC WERK-MASTER  gen N    one conversation, one turn, dies      │
   │  SINGLETON -- holds the lease on the epic card                    │
   │                                                                   │
   │  READS   epic rollup (children + waitingOn) . epic baton tail .   │
   │          git state . the needs-werk-master question cards         │
   │  DECIDES answer questions | handle verdicts | merge | replan |    │
   │          ask Jonas | epic DONE                                    │
   │  WRITES  card frontmatter + append-only baton + the run digest    │
   └───┬───────────────────────────────────────────────▲───────────────┘
       │ (does NOT dispatch -- readiness is arithmetic)│  wake gen N+1
       ▼                                               │  "t2 settled"
   ┌───────────────────────────────────────────┐       │
   │  THE BEAT            planBeat()           │       │
   │  DAG order from depends_on . concurrency  │       │
   │  ceiling . `when` gates . dry-gen park    │       │
   └───┬───────────────────────────────────────┘       │
       │ dispatchSpawn(permissionMode: dontAsk         │
       │               + deny-floor + THE MUTE)        │
       ▼                                               │
   ┌──────────────────┐  ┌──────────────────┐          │
   │  WERK-WORKER     │  │  WERK-VERIFIER   │   ...    │
   │  card t2         │  │  card t5         │          │
   │  own worktree    │  │  scratch tree    │          │
   │  NO dialog       │  │  NO dialog       │          │
   │  NO notify       │  │  never sees the  │          │
   │  blocked -> card │  │  doer's context  │          │
   └───┬──────────────┘  └───┬──────────────┘          │
       │  terminal: done | blocked | errored | crashed │
       ▼                                               │
   ┌───────────────────────────────────────────────────┴───────────────┐
   │  GUARDIAN SWEEP   (broker, every 45s)                             │
   │  a settled card the baton has NOT acknowledged -> wake the        │
   │  werk-master at gen+1. The lease CAS lets one waker through.      │
   └───────────────────────────────────────────────────────────────────┘
```

---

## 3. Generation 0 -- the planning pass

**Nothing dispatches until the board has been read once, with fresh eyes.** An
epic is usually written as a pile of stories with no thought given to what has to
happen first, and `depends_on` is the field everybody leaves empty. Generation 0
exists to fix that before it costs anything.

It is **not a fourth seat.** It is the werk-master, with a different prompt and
dispatch suppressed for one beat: same permissions, same board access, same
baton, same right to reach a human. A separate role would have duplicated all
four for no capability anybody needed.

### Why it exists

Readiness is arithmetic over `depends_on` (`epic-ready.ts`) and nothing else
looks at it -- deliberately, because a model asked to eyeball a dependency list
will occasionally dispatch against an open one. The price of that correctness is
that **the DAG is only as good as the edges somebody remembered to write**, and
nobody writes the edge between "refactor the parser" and "add a parser flag".
Those two dispatch together, in separate worktrees, and collide.

So this pass does not move the gate to a model. It makes the arithmetic
trustworthy by **completing the graph the arithmetic runs on**, once, up front.
From beat 1 the engine enforces it deterministically, for free, forever.

### The job, in order

1. **Read the intent.** The epic card body is what the epic is FOR. Then every
   child card. Look for the gap between the two.
2. **Close what is already done.** Verified against the repo, not the board -- a
   card describing work already in the tree costs a full werk-worker *plus* a
   full werk-verifier to rediscover. Uncertain means leave it: a wrongly-closed card
   is silently dropped scope.
3. **File what is missing**, with `epic: <id>`. Split any card that is secretly
   four -- a card a werk-worker cannot finish in one sitting comes back bounced.
4. **Drop what stopped making sense**, archived with the reason. `archived`
   leaves the denominator, so a dropped card cannot fake progress.
5. **Write the edges.** The part nobody does by hand and the engine cannot infer.
6. **Write the baton** -- one `intent` entry naming every card created, closed,
   archived, split or re-ordered, and why -- then the run digest as the plan of
   record.

### What earns an edge

The question for any pair of cards is not "is one logically after the other" but
**"would two agents doing these simultaneously, without talking, produce a
mess"**. Add `depends_on` when:

- they edit the same file, or one renames/moves what the other edits;
- one establishes an interface, a schema, a migration or a config the other
  consumes -- *this is the infrastructure-first case*;
- one is a refactor and the other adds to the thing being refactored (the classic
  collision, and it almost never has a declared edge);
- one cannot be verified until the other lands.

Not for priority. Every edge costs parallelism, and an over-serialised epic runs
one card at a time for no reason. Order that is only a preference belongs in the
card body.

### The checkpoint gate

When the werk-planner exits, the engine compares the board's dispatch-relevant
fingerprint (`epic-board-fingerprint.ts`) against the snapshot it took before
the werk-planner started:

| Board | What happens |
|---|---|
| **changed** | `plan-checkpoint` -- the run stops and Jonas reviews the plan before any work goes out |
| **unchanged** | `plan-accept` -- straight through to beat 1 |

Decided from the board itself, never from the werk-planner's summary -- so the prompt
tells it to write the baton for the human who has to read it, not to influence
the gate.

### Defaults and the three states

`plan` defaults **on** (`EPIC_RUN_DEFAULTS`); no caller currently exposes a way
to turn it off. `planBaseline` is what distinguishes owed / in flight / settled,
and it is the fingerprint rather than a flag on purpose: the field that says a
werk-planner ran *is* the evidence used to judge whether it changed anything, so the
two can never disagree.

A **resume never re-plans** -- gen 0 already happened, the werk-master's own replan
step covers drift from there, and re-planning would churn cards that live workers
are holding open. A run armed before this stage existed reads as *already
planned* rather than as owing a plan, for the same reason.

Generation 0 outranks every other beat decision except the caps and a live
werk-master -- including unacknowledged settles -- because dispatching while a plan is
owed races the pass that exists to say what may run in parallel.

---

## 4. Why the wake is state-based

The obvious design fires the werk-master from a "worker ended" event. That loses a
settle whenever the werk-master is mid-turn, and double-fires whenever two workers
end together -- which is the normal case at concurrency 3, not an edge case.

So the beat asks a **standing question**: *is there a settled card the baton has
not acknowledged?* A missed sweep is repaired by the next one, and a duplicate is
refused by the lease compare-and-swap. Self-healing beats bookkeeping.

The guardian, not the werk-worker, fires the wake -- a werk-worker that crashes,
hangs, or gets watchdog-killed never gets to call a check-in tool, and those are
three of the four ways a card settles.

---

## 5. The blocked channel -- a werk-worker asks the BOARD

The rule is **no worker BLOCKS on a human** -- not "no worker speaks". That
distinction decides the list, and it is enforced by a `PreToolUse` hook keyed on
tool name (`epic-worker-permissions.ts`), not by prompt text.

| Tool | Worker | Why |
|---|---|---|
| `dialog`, `AskUserQuestion` | **blocked** | They park the worker until a human replies. Nobody is watching an unattended run, so the turn is simply lost. |
| `notify` | allowed | One-way. A worker that finds something alarming should be able to say so without stopping. |
| `send_message` | allowed | Routing between conversations. A worker telling the werk-master something directly is the system working. |

> **`dontAsk` is not this.** `dontAsk` suppresses CC's own *permission* prompts.
> It does nothing about an agent deciding to call `dialog` and ask Jonas a
> question. Left prompt-only, "no worker blocks on a human" holds right up until
> the moment it matters.

When blocked, the werk-worker:

1. Writes a card tagged `needs-werk-master` carrying the question **and its own
   recommendation** (a question with no recommendation makes the werk-master redo
   the analysis).
2. Adds that id to its own card's `depends_on`.
3. Appends a `## Blocked` section to its own card.
4. Sets its card back to `open`, pushes what is safe, and stops.

Three things fall out for free: the DAG stops redispatching the blocked card, the
question is a first-class board object (and an andon row), and answering it --
moving the question card to `done` -- unblocks the original with no special case.

---

## 6. Storage

```
<project>/.rclaude/project/
  cards/<epicId>.md          the epic card. Carries the WERK-MASTER LEASE:
                               overseer: conv_...   overseer_gen: 7
                               overseer_at: <iso>
                             (the lease keys keep the old word on purpose --
                              `werk-rename-lease-keys` owns them, not the seat rename)
  cards/<cardId>.md          a work card. Carries the SEAT LEASES, one per role:
                               seat_werk-worker: conv_...   seat_werk-worker_gen: 1
                               seat_werk-worker_at: <iso>
                               seat_werk-verifier: conv_... seat_werk-verifier_gen: 1
                               seat_werk-verifier_at: <iso>
  epics/<epicId>/
    run.md                   EpicRunMeta frontmatter + the werk-master's digest
    log.md                   THE BATON -- append-only, never rewritten
```

The lease lives on the **card**, not in `run.md`, so a stuck werk-master is visible
and breakable by a human reading the board without knowing the engine's layout.
`overseer_gen` survives a release: it is the run's generation counter, and reusing
a number would put two different beats in the baton under one id.

The baton is the werk-master's entire memory. Every generation is a fresh
conversation with no transcript from the last one -- which is what lets an epic
run past any context horizon.

### 6a. The seat lease -- one writer per `(epic, card, role)`

The engine's dispatch guards (`inFlight`, `inVerify`, the just-dispatched pending
set) are all guesses made by the party that is **not** holding the worktree: the
broker reasons from a registry it knows is behind, plus a log. Every guard of
that shape is wrong at exactly the moment its inputs are stale, which is the same
moment a duplicate happens. On 2026-08-21 two werk-workers were dispatched onto
one card and, because `cardBranch` derives the worktree name from the card id,
they shared **one worktree** -- the loser's edits were staged into the winner's
commit with no conflict and no signal.

So a seat claims its own lease when it connects, `epic_seat(action="claim")`,
before it reads the card or touches git. It is the same CAS as the werk-master lease
(`evaluateLease`), at a different scope:

| | WerkMaster lease | Seat lease |
|---|---|---|
| Key | the epic | `(epicId, cardId, role)` |
| Lives on | the epic card | the **work** card |
| Claimed by | the beat, before it spawns | the **seat itself**, on connect |
| Refusal means | this beat does not wake a werk-master | this conversation **exits non-zero** |

**Role is part of the key**, so a werk-worker and a werk-verifier on one card both
proceed -- that is the whole reason `inVerify` is a separate lane from
`inFlight`. Only a same-role collision is a collision.

**Three releases, and the third is the one that matters.** The seat releases
explicitly when it finishes; a seat that dies without releasing loses the lease
to the registry-liveness check; and a holder that is **alive but wedged** (the
classic case is blocking in a Bash call, which emits nothing and reads as idle)
loses it after `LEASE_STALE_MS`. That last one only works because the claim path
has **no early return above the CAS** -- the defect in `epic-beat.ts:251` that
deadlocks the werk-master lease is exactly a return placed above the question.

**It is a mutex between seats, never an authorisation gate.** If the claim cannot
reach the broker at all, the seat is told to PROCEED and note it; the dispatch
guard above is the protection for that beat. A lease that becomes a precondition
for working is a new way for the whole engine to stop.

Every collision -- a refusal, and a takeover of a dead or wedged holder -- is
written to the baton as `dispatch-failed`, naming both conversations. A belt that
fires invisibly teaches nobody that the guard above it has a hole.

---

## 7. `when` is a mode, not an engine

| `when` | Dispatch | Verdicts |
|---|---|---|
| `now` | immediately, ignores the clock | always |
| `window` | deferred to the project's nightshift window | always |
| `queue` | deferred until no other epic in the project has work in flight, then EXCLUSIVE until this run goes dry | always |
| an ISO instant | deferred until that moment passes -- an APPOINTMENT. Stored as `at:<iso>` | always |

A verdict lands whichever gate is in force: judging is not night work, a card
stuck in `in-review` is the worst place for work to sit, and -- for `queue` --
verdicts are what let the runner drain so the queued run can enter at all.

**`when` is a LIST and ALL of its gates must pass on the same beat.**
`when=window,queue` means "at night, and not while another epic is running".
Every gate is a PER-BEAT PREDICATE rather than an arm-time choice, which is what
makes them compose: `window` was always re-evaluated every beat, so `queue` is a
value on that axis and not a mechanism beside it.

The field is spelled `cadence` in `run.md` and on the wire, and `when` on the
verb surface -- one axis, two names, deliberately: renaming the stored field
would mean migrating every artifact on disk and would break the broker/sentinel
skew rule (they deploy separately). The codec is `src/shared/epic-when.ts`.

### `queue` -- a deliberate refusal to share

A queued run waits until nothing else in the project has a live seat, then holds
the runner exclusively: every OTHER epic stops dispatching (they keep verifying)
until the queued run goes dry, which parks it, which releases the hold. It is
the right shape for an epic that rewrites something everything else touches.

Holding is `startedAt` -- already defined as "the first beat the run was
PERMITTED to dispatch" -- so it needs no state of its own, and arming clears it.

The starvation risk is reported rather than left silent: position, what it is
behind, how long it has waited, on the beat note every tick, in `inspect`, and
on the wall's run rail. Past 30 minutes the line says `STARVING`.

### An APPOINTMENT -- arm it now, start it then

```
epic_run action=start epic_id=... when=2026-08-22T02:00:00+07:00
epic_run action=start epic_id=... when=window,2026-08-22T02:00:00+07:00
```

**An absolute instant with an offset, not a wall-clock time plus an IANA zone.**
A one-shot appointment has no recurrence, so the DST machinery `parseCron` needs
buys nothing here and costs the two edge cases it exists to handle. The offset is
kept rather than folded to UTC because it is the only record of which clock the
human was reading, and no surface may render a bare time (`format-when.ts`).

**Always give it an offset or a trailing `Z`.** A zoneless date-time is read as
UTC, explicitly and everywhere -- `Date.parse` would otherwise read that form as
LOCAL time, and the broker container runs UTC while the sentinel runs on the
laptop. UTC is also the safe direction to be wrong in: the run waits longer than
meant rather than firing early.

**It costs no wall clock.** `startedAt` means "the first beat the run was
PERMITTED to dispatch", the appointment withholds that permission exactly as
`window` does, and `maxWallClockMinutes` measures from `startedAt` -- so a run
armed at noon for 02:00 is not burning a budget it may not use.

**A waiting run is never mistaken for a stalled one.** The beat note carries
`waiting until <instant> (in 4h 12m)` on every tick, the same treatment the
restart quarantine gets; the `epic_run` caps line carries it beside spend and
wall clock; and the wall's run rail prints `WAITING -- ...` above the DAG buckets.

**`action=beat` overrides it, and records that it did.** The appointment is one
person's note about when to begin, and the person pressing BEAT NOW is the one
who set it. `window` and `queue` are NOT overridable, there or anywhere: `window`
is a project policy about when the box may be busy and `queue` is a promise made
to every other epic. The beat says which of them is holding rather than going
quiet.

**Two instants collapse to the latest.** Every gate must pass on the same beat,
so an earlier appointment is unconditionally satisfied by the time a later one
is; carrying both would be two countdowns to keep in step.

**A gate only holds DISPATCH.** Generation 0 (the planning pass) and werk-master
wakes go through it, exactly as they do through `window` -- planning is analysis,
and an epic that could not even be read until 02:00 would have nothing to
dispatch when 02:00 arrived.

---

## 8. Stop conditions

| Condition | What happens |
|---|---|
| Every child terminal | `complete` -- the werk-master reports what landed and what was dropped |
| An irreversible step, or a decision that is Jonas's | `checkpoint` -- one crisp question, recommendation first. The only path to a human. |
| Generation 0 rewrote the board | `plan-checkpoint` -- the plan is reviewed before any work goes out (§3) |
| Two consecutive generations with nothing dispatchable | `park` -- the werk-master gets exactly one chance to replan first |
| `spentUsd >= maxUsd` (default **$100**) | `park` -- see below |
| `maxWallClockMinutes` since first dispatch (default **480**) | `park` -- see below |
| `gen >= maxGens` (default 40) | `park` -- the run is thrashing, not working |

**The ceilings are checked dollars, then wall clock, then generations** -- most
expensive unit first, so a run over two at once reports the one that actually
cost something. `0` disarms any of them, and it has to be typed: none of the
defaults is infinity.

`maxGens` was the only brake for the life of the feature, and it is a unit of
**planning** rather than of spend: it bounds how many times the werk-master thinks
and bounds nothing about what the seats underneath it burn. On 2026-08-19 this
project billed **$2,481 in one calendar day** with an epic running unattended,
and no cap of any kind was involved in stopping it. `$100` is about 4% of that
day -- set where a human reading *"this run has spent $100 and is not finished"*
would say stop. Raise it per run when an epic genuinely warrants more.

`spentUsd` is **sticky**: it is folded fresh each beat from `turns.cost_usd`
across every conversation the run spawned, but turns are pruned and the
conversation registry forgets, so the fold is a *floor on the truth*. The higher
of banked and folded wins -- a brake that garbage collection can release is not a
brake. Re-arming a parked run therefore does not launder its spend; it parks
again on the next beat, which is the brake working. The wall clock, by contrast,
**does** restart on re-arm: it measures the current unattended stretch, and it
starts on the first beat the run was *permitted* to dispatch, so a `window` run
armed at noon does not burn its budget waiting for the night.

---

## 9. Relationship to the WERK cards

Epic mode is the delivery vehicle for two cards on
[werk-epic](../.rclaude/project/cards/werk-epic.md):

- **[werk-done-gate](../.rclaude/project/cards/werk-done-gate.md)** -- Tier 1 and
  Tier 2 already shipped (`board-gate.ts`, wired into `project_set_status`).
  Tier 3, the judge leg with no shared context, was written as
  `buildWerkVerifierPrompt` and had **zero callers** until `planWerkVerifierSpawn`.
- **[werk-andon](../.rclaude/project/cards/werk-andon.md)** -- the concurrency
  default is **3**, and cards over the ceiling are reported as `heldBack` rather
  than silently truncated. The ceiling is a *review* ceiling.

It also takes a down-payment on
**[werk-governor](../.rclaude/project/cards/werk-governor.md)**: the generation
ceiling and the dry-generation park are per-run brakes. The fleet-wide governor
(lifting `nightshift-watchdog` out of tag scope) is still that card's job.

---

## 10. Status

| Piece | State |
|---|---|
| Baton, run store, lease CAS, paths | **done**, sentinel-side, tested |
| `planEpic` (DAG + ceiling + lanes) | **done**, tested |
| `planBeat` (the decision) | **done**, tested |
| Generation 0 -- werk-planner prompt, checkpoint gate, fingerprint | **done**, tested, default on |
| Spend + wall-clock ceilings | **done**, tested -- and **fail-closed** since 2026-08-22: a sentinel that cannot carry them refuses the arm (see below) |
| Prompts for all three seats | **done**, tested |
| The mute | **done**, tested |
| `launchConfig.epic` tag | **done** |
| `EpicOp` / `EpicResult` + sentinel handlers | **done**, tested |
| Broker request handler + `EpicRequest` / `EpicEvent` | **done**, tested |
| Broker-initiated RPC + the executor | **done**, tested |
| The 45s sweep, started in `broker/index.ts` | **done**, tested |
| `POST /api/epic` + `epic_run` MCP verb | **done**, tested |
| RUN button + dialog | **done**, shipped to `web/dist` |
| **A live end-to-end run** | **DONE 2026-08-18** -- two cards, one dependency, zero human intervention |
| `inspect` / `list` / `beat` / `break_lease` + the beat ring | **built**, tested, **NOT DEPLOYED** |

The loop is closed. On 2026-08-18 an epic went arm -> dispatch -> in-review ->
independent werk-verifier -> done -> next card -> complete with nobody watching -- the
first completed unattended run in this codebase.

That run also found what §11's verbs exist to fix: the plan was computed every
beat and discarded, the beat log barely reached `docker logs`, and the only way
to see a run's state was to wait 45s and read the sentinel's files by hand. Four
findings from that smoke are still open on
[epic-smoke-findings](../.rclaude/project/cards/epic-smoke-findings.md) -- most
importantly that the deterministic DONE-gate never runs for an epic card, so the
werk-worker/werk-verifier separation currently holds by CONVENTION rather than by the
mechanism built to enforce it.

### A stale sentinel bundle can no longer disarm a ceiling

The sentinel owns `run.md` and ships as a **frozen bundle** that deploys
separately from the broker, so its `readEpicRun` is what populates the snapshot
the beat judges the caps against. A bundle built before the ceilings landed knows
none of `maxUsd` / `maxWallClockMinutes` / `spentUsd` and returns them absent --
and `run.maxUsd > 0` is false for a field that was **asked for and lost in
transit** exactly as it is for one nobody set. Until 2026-08-22 that meant the run
dispatched uncapped with nothing anywhere saying so, and the documented remedy was
`grep -c maxUsd packages/sentinel/bin/sentinel`. A safety mechanism whose failure
detector is a human remembering to grep a 532 KB binary is not a safety mechanism.

**A cap that cannot be enforced is an ERROR, never an absence.** Absent is not
read as unlimited anywhere, and four mechanisms replace the grep:

| Mechanism | Where | What it does |
|---|---|---|
| `readCeiling` | `src/shared/epic-run-caps.ts` | Three answers, not two: `capped`, `disarmed` (a typed `0`, and only a typed `0`), `unenforceable` (absent, non-numeric, negative). |
| The arm refusal | `capCapabilityRefusal`, `src/broker/epic-arm.ts` | **The reply is the capability probe.** `start` sends the ceilings and the sentinel echoes the run back; an echo without them proves the bundle predates them. The arm is refused, the run the sentinel already wrote is **paused**, and the reason goes to `docker logs broker`, to the baton as a `checkpoint`, and to the caller. No version handshake to keep in step -- the check is a property of the data, so it keeps working for whatever the next lost field turns out to be. |
| The beat park | `capBeat`, `src/broker/epic-beat.ts` | Checked **before** the ceilings themselves, because the arithmetic cannot ask the question. A live run whose sentinel is rolled back mid-flight parks with the reason on the baton rather than dispatching. It parks rather than holds: the condition is a deploy, so unlike headroom it does not fix itself in twenty minutes. |
| Foreign-key passthrough | `EPIC_RUN_KEYS` + `foreignKeys`, `src/shared/epic-run-store.ts` | `writeRun` used to serialise the typed object and nothing else, so any build dropped every key it had not heard of. An unknown key is now assumed to belong to a **newer** writer and survives the round trip -- so an old bundle can no longer *delete* a new one's fields. (`gen` is exempt: this build owns it by having retired it.) |

The passthrough is forward-looking only and cannot repair a bundle already frozen
without it; that is what the arm refusal and the beat park are for. Every field
added from here on is skew-proof by construction rather than by remembering.

Both refusals name the fix: `bun run build:packages`, restart the sentinel, arm
again.

**Deploying the new verbs needs an explicit go, twice.** The executor, the sweep
and the broker actions live in the BROKER, so they need the image rebuilt and the
container recreated -- which drops every live WebSocket. The deeper baton read
and the lease-on-`get` are SENTINEL changes, and the sentinel ships as a frozen
bundle, so they need `build:packages` plus a sentinel restart. That restart does
NOT kill running conversations -- agent hosts are spawned `detached` and unref'd,
survive the bounce, and are re-adopted from the PID registry -- but it does kill
every host shell (web terminal) and fails any spawn/revive in flight while the
sentinel is down. Neither is covered by the standing web-deploy licence.

## 11. Running one

```
epic_run(project="claude://...", epic_id="werk-epic", action="start",
         when="now", concurrency=3)
```

or the **RUN** button on any epic card in the EPICS view.

`when` takes `now`, `window`, `queue`, or a comma-separated composition of them
(§7). `cadence` is still accepted as its old name.

### The verbs

Everything an epic run can be driven, inspected or debugged by is one MCP tool,
`epic_run`, and one route, `POST /api/epic`. (The one exception is `epic_seat` /
`POST /api/epic-seat` -- §6a -- and it is an exception for a reason: every action
below names a `project` and an `epicId`, and a seat knows neither. It knows only
that it is itself.)

| Action | Does | Costs |
|---|---|---|
| `start` | arm or RESUME. Never resets the generation counter. | sentinel |
| ↳ | answers with the STATUS BLOCK only -- no digest, see below | |
| `pause` | stop dispatching, release the lease | sentinel |
| `abort` | terminal, `reason` into the baton | sentinel |
| `beat` | **run one beat NOW** instead of waiting up to 45s | broker |
| `list` | every run in the project: status, gen, in flight, armed | broker |
| `get` | the cheap read -- run, digest, baton tail | sentinel |
| `inspect` | **everything at once** (below) | broker |
| `break_lease` | release a stuck werk-master so the next beat wakes a fresh one | broker |

`lease`, `patch`, `log_append`, `release` and the three `seat_*` ops stay
ENGINE-INTERNAL and are refused over `/api/epic`: exposing them would let a caller
forge a generation, hand-edit the append-only baton, or evict a live worker from
its own card. The seat ops are reached only through `/api/epic-seat`, which never
takes a card from the request -- it reads one from the caller's own launch tag.
`break_lease` is `release`'s audited public face -- it refuses a live holder
unless forced, and writes who broke it and why into the baton.

### `start` is cheap on purpose

`start` merges rather than clobbers, so sending one knob changes one knob and
nothing else -- which makes it the reconfigure verb as much as the arm verb, and
raising a parked run's `max_usd` its most common call by far.

So it answers with the STATUS BLOCK ALONE: run state, `when`, target,
concurrency, the three caps and the lease, plus a line saying where the digest
went. Roughly what `list` costs. It used to return the whole plan-of-record
digest on every call, ~1500 tokens of context the caller usually wrote itself
ten minutes earlier, which made the verb that RELEASES a brake feel expensive
enough to avoid.

`get` is the digest's home and is one call away. There is no flag: making
callers opt in to the cheap behaviour would tax the common case to serve the
rare one, and a fresh arm has no digest yet anyway -- only the placeholder the
first werk-master generation replaces.

### `inspect` -- reach for this first when an epic looks stuck

One call, no mutation, and it answers the question in this order:

1. **Why it is or is not moving** -- `idleReason`, computed by `epic-ready.ts`.
   This is the line to read first. It used to be computed on every beat and
   thrown away.
2. **The plan** -- dispatch / verify / questions / held back by the ceiling /
   waiting on dependencies, each with the cards named and the deps that hold them.
3. **Live** -- what is actually running: cards in flight, whether the werk-master is
   alive, which settled cards the baton has **not acknowledged** (that is what a
   wake is FOR), and every epic-tagged conversation with its role and generation.
4. **Beats the sweep performed** -- the mechanical layer under the baton. The
   baton is the werk-master's memory; this is what the machine did.
5. **The baton.**

Two fields are worth knowing by name because each marks a specific failure:

- `armed: NO` on a run whose status says `armed` means **the broker restarted and
  forgot it** (the registry is in memory -- see §6). Re-arm; `start` resumes.
- `generationMismatch` means spawns are being tagged with a generation the run
  file does not have, i.e. **spawns are racing the lease**, which freezes a run
  silently. It was a log line nobody read; it is now a field.

### Reading deeper into the baton

`baton_limit`, `baton_kinds` and `baton_card` shape the slice on `get` and
`inspect` -- "the last 200", "every verdict", "everything that ever happened to
t5". The default tail is 20, sized for a werk-master's PROMPT rather than for a
human debugging a forty-generation run; filtering happens before the tail, so
"the last 2 verdicts" means two verdicts, not however many fall in the last two
entries.

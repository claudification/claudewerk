# The trusted runner -- the epic engine held against every way it can die

> **What this is.** [docs/epic-mode.md](epic-mode.md) says what the engine DOES.
> This says what happens when it is interrupted: every fact the engine holds, who
> writes it, where it is durable, and what a process dying at that exact instant
> costs. It exists because in the 24 hours to 2026-08-22 the runner took roughly
> 100 fix commits and every one of them was a correctness hole in machinery that
> is about to be handed money and left alone.
>
> Written for [werk-runner-resilience](../.rclaude/project/cards/werk-runner-resilience.md),
> which gates [werk-auto-arm](../.rclaude/project/cards/werk-auto-arm.md).

---

## 0. The verdict, first

**Not trusted for unattended auto-arm yet. Trusted for supervised runs.**

Every failure on the card's list now has a stated answer and a test, and three
that did not have one when this audit started have one as of `12f28300`. What is
missing is not a mechanism; it is **evidence**. The recovery paths in §4 are
tested at the unit and seam level and have never been exercised against a live
broker, a live sentinel and a real kill. Nine of the twelve rows below cite an
incident, which means they were found in production rather than in review -- and
the honest reading of that is that review has not been the thing catching these.

The three residuals in §6 are each survivable and each has a belt underneath it.
None of them justifies arming an epic while Jonas sleeps until a run has survived
a deliberate `docker restart` mid-beat and a deliberate `kill -9` of a seat.
**That smoke is the remaining gate, and it is one afternoon of work, not a card's
worth.**

---

## 1. The rule the whole design reduces to

> **A claim is held by a live process for a bounded time, never by a field that
> says so.**

Every recurring bug in this engine is one violation of that sentence:

| The bug | The belief with no expiry |
|---|---|
| A dead seat held a concurrency slot for 12 minutes | `inFlight` -- the broker's *belief* a card is being worked |
| A werk-master whose end was never recorded held the beat forever | `status !== 'ended'` on a row nothing ever moves |
| Two werk-workers in one worktree | `inFlight` again, stale at exactly the moment it mattered |
| A run frozen at `stale wake: expected gen 12, epic is at gen 11` | a MIRROR of the generation that nothing reconciled |
| A torn `run.md` read as a fresh armed run | a parse fallback standing in for a fact |
| A torn CARD reset the generation counter to 1 | the same fallback, on the file that holds the lease |

So the design has exactly two primitives -- a **lease** (§3) and a **standing
question** (§2) -- and one storage rule: the mutable state is small enough that
recovery is "re-read three scalars and re-derive the rest from the board".

---

## 2. The state machine

### 2.1 The run

```
                    start
                      |
                      v
   (nothing) ----> armed ----------------------------+
                      |                              |
                      |  lease granted               |  pause / abort
                      v                              v
                   running ----------------------> paused / aborted
                    |  ^                              ^
                    |  |  next beat                   |  park, checkpoint,
                    |  +------------------------------+  plan-checkpoint
                    |
                    |  every child terminal
                    v
                 complete
```

`armed` and `running` are the only states a beat acts on
(`isInertRun`, `epic-beat.ts`). `paused` covers **every** stop that is not
`abort` or `complete` -- a park, a checkpoint and a plan-checkpoint are all
`paused` plus a baton entry saying which, and all three go through the SAME
function (`standDown`, `epic-beat-actions.ts`), which is the fix for "three
different stop paths did three different things". `start` resumes any of them
without resetting the generation counter.

### 2.2 One beat, in order

The order **is** the contract. Everything below step 2 assumes step 2 happened.

| # | Step | Why here |
|---|---|---|
| 1 | read run + lease + baton (one `get`), read the board (one `list`) | one instant, one set of facts |
| 2 | **acknowledge every settled card into the baton** | a settle not written down is a settle the next sweep rediscovers *forever* |
| 3 | record settled promises; note failed launches; reap dead werk-masters | same rule: a fact learned and not written is a fact re-learned |
| 4 | if this beat will park or complete, take the promise ledger's LAST CALL | there is no beat after an inert run |
| 5 | write the beat's ledger patch (`dryGens`, `spentUsd`, `startedAt`, …) | **before** the actions, or a crash mid-dispatch resets the brake |
| 6 | perform actions: wake / dispatch / verify / park / complete | |

### 2.3 One seat

```
  dispatched ---> spawned ---> claims its seat ---> works ---> releases ---> settles
       |             |              |                 |            |
       |             |              +-- REFUSED ------+            |
       |             |                  (exits, card stays with the holder)
       |             +-- spawn failed: no seat, card stays dispatchable
       +-- broker died here: seat is live, baton has no record (see §6, R2)
```

A seat's card leaves the dispatch lane on THREE independent grounds, and it needs
all three because each is blind to a different failure:

1. **the board lane** -- the card is no longer `open`;
2. **the engine's belief** (`inFlight` / `inVerify` / the pending-seat set) --
   which is *bounded* by `SEAT_SILENCE_MS`, so a corpse cannot hold a slot;
3. **the seat lease** -- checked by the process doing the writing, at the moment
   it starts writing (§3).

---

## 3. The lease model, stated once

**One CAS, two scopes.** `evaluateLease` (`src/shared/epic-lease.ts`) decides
both. The only thing that differs is which frontmatter keys carry the grip.

| | Werk-master lease | Seat lease |
|---|---|---|
| Key | the epic | `(epicId, cardId, role)` |
| Lives on | the epic card, `overseer*` | the **work** card, `seat_<role>*` |
| Claimed by | the beat, before it spawns | the **seat itself**, on connect |
| Refusal means | this beat does not wake a werk-master | that conversation **exits** |
| Written by | the sentinel (`casLeaseOnCard`) | the sentinel (`casLeaseOnCard`) |
| Liveness known by | the broker (conversation registry) | the broker |

**The five properties, and what each is for.**

1. **Compare-and-swap on the generation.** A waker states the generation it
   believes is current; exactly one is right. This is what makes a double wake
   safe rather than merely unlikely -- two seats finishing inside one 45s sweep is
   the *normal* case at concurrency 3.
2. **No await between the read and the write** (`casLeaseOnCard`). Node's
   synchronous fs is what makes it a CAS at all. If this ever moves off it, that
   is the code that breaks, and it is the only place it can break.
3. **The generation survives a release.** `releasePatch` clears the holder and the
   timestamp and deliberately leaves `<prefix>_gen` standing -- reusing a number
   would put two different beats in the baton under one id.
4. **Three ways to lose it, and the third is the one that matters.** Explicit
   release; death without release (the registry says the holder is not live);
   and **alive but wedged**, at `LEASE_STALE_MS` (10 min). The third only works
   because the claim path has **no early return above the CAS** -- the defect that
   deadlocked the werk-master gate on 2026-08-20 was exactly a return placed above
   the question. See §5.
5. **It is a mutex between seats, never an authorisation gate.** A seat that
   cannot reach the broker is told to PROCEED and note it. A lease that becomes a
   precondition for working is a new way for the whole engine to stop.

**The lease's own storage is now crash-atomic** (`patchCardMeta`,
`writeFileAtomic`) and a torn card is refused rather than read as "never woken"
(`EpicCardUnreadableError`). Until `12f28300` neither was true, which meant the
mutual-exclusion state was the least durable thing in the engine.

**Every collision is audited** -- a refusal and a takeover alike -- into the
baton, naming both conversations. A belt that fires invisibly teaches nobody that
the guard above it has a hole.

---

## 4. Recovery, one row per failure

The card's §3 list, plus the ones the audit added. "Cost" is what a human loses.

### 4.1 Process death

| Failure | What is durable | What is lost | Recovery | Cost |
|---|---|---|---|---|
| **Broker restarts** | the armed set (`kv`, `epic-registry.ts`), everything on disk | the in-memory conversation picture, the beat ring | boot rehydrates the armed set; `RESTART_QUARANTINE_MS` (2 min) holds every beat while agent hosts reconnect, so the first decision is made on a complete picture | ≤ 2 min of one run's cadence, automatic |
| **Broker restarts mid-beat** | steps 1-5 of §2.2 that completed | the rest of that beat | the next tick asks the same standing questions and redoes what is missing; step 2 is idempotent (the baton is checked before appending) | one tick |
| **Sentinel restarts** | everything (it owns the files) | in-flight ops fail | every epic op is `{ ok: false }` for the outage; `runEpicBeat` reports `run artifact NOT READ` and **skips rather than acting blind**; running conversations survive (detached, unref'd, PID-registry re-adopt) | one or more ticks |
| **Sentinel killed mid-write of `run.md`** | the previous `run.md` | the write | `writeFileAtomic`: rename, so a reader sees the old file or the new one, never a prefix | nothing |
| **Sentinel killed mid-write of a CARD** | the previous card | the write | same, since `12f28300`. Before it: a prefix, which parsed to `{}`, which reset the generation counter and which the *next* patch rewrote into a card with no title, status or dependencies | nothing (was: a destroyed card) |
| **A torn file exists anyway** (power loss, older bundle, hand edit) | -- | -- | **refused, never believed**: `EpicRunUnreadableError` / `EpicCardUnreadableError` make every op fail with the reason. Recovery is by hand and is one command (`mv` the run aside and re-arm; `git checkout` the card) | one human minute |
| **The sweep tick throws** | -- | that tick | the reentrancy guard is released in a `finally` and the throw is logged, not rethrown into `setInterval`. Before `12f28300` a throw in the pre-scan region latched the guard and the engine was **dead for the life of the process** | one tick |

### 4.2 A seat dies

| Failure | Detected by | Recovery | Cost |
|---|---|---|---|
| **Seat killed / crashed** (socket gone) | `seatAbandoned` at `SEAT_SILENCE_MS` (10 min) | the slot is released, the card is acknowledged as settled with a git report of what the corpse left uncommitted | one card, named loudly in the baton |
| **Seat alive but silently dead** (blocked in a Bash call: holds its socket, emits nothing) | *not* by the socket reaper -- by the LEASE's own TTL when the next claimant arrives, and by `MAX_CARD_SEATS` bounding the retries | the next dispatch's claim displaces it and the takeover is audited | one seat's tokens |
| **Seat spawn fails** | the spawn reply | the card simply stays dispatchable and the next beat retries -- *one retry, not a whole generation*. Bounded by `MAX_CARD_SEATS` (6 = one attempt plus two bounces, per lane); past it the card is `unspawnable` and reported | bounded |
| **Two seats on one card** | the seat lease, at the point of use | the loser exits without writing; both conversations are named in the baton | nothing, and the guard above it learns it has a hole |

### 4.3 The supervisor dies

| Failure | Detected by | Recovery |
|---|---|---|
| **Werk-master conversation dies without recording an end** | `buildWerkMasterReaper` at `WERK_MASTER_SILENCE_MS` (15 min) | `werkMasterLost` wakes a replacement at gen+1, once, keyed on the lease holder so it cannot loop |
| **Werk-master alive but wedged** | `werkMasterGate`'s TTL, `LEASE_STALE_MS` (10 min) | the hold lifts; a wake's CAS grants over the aged holder and records it in `replaced`. A supervisor that stays wedged costs ONE extra generation per TTL window -- bounded by `maxGens`, loud in the baton, and not a stopped run |
| **Two werk-masters** | the CAS | exactly one waker's `expectGen` matches |

The two graces are deliberately different numbers and must stay that way.
15 > 10 is an *invariant*, asserted by `graceClearsLeaseStaleness`: a fold that
declared the werk-master dead while the CAS still refused to replace it would
freeze the run by a second mechanism instead of the first.

### 4.4 Time and version

| Failure | Answer |
|---|---|
| **Clock skew, sentinel vs broker** | The sentinel stamps every `_at`; the broker judges the age. `get` now reports the sentinel's own clock (`EpicResult.clockMs`) and the beat measures the age **on one clock**. A skew past one minute is logged. Uncorrected, twenty minutes of drift made every live werk-master read as instantly stale and dispatched work underneath it on every tick |
| **Clock runs backwards** | `silentForMs` clamps at 0 (reported as "just now", never as a future seat); `leaseHeldMs` clamps at 0 (reads as fresh, which holds rather than displaces) |
| **Generation race** (`generationMismatch`) | The run artifact carries **no** generation any more; the card's `overseer_gen` is the only copy, and the beat, the log line, the prompt header and the CAS all read it from the same `get`. Two copies is what caused the failure; deleting one is the fix. Residual mismatches are surfaced as a field, not a log line nobody read |
| **Old sentinel bundle, new broker** | Fields are optional-for-skew throughout, and every fallback is chosen to fail in the survivable direction. A cap that cannot be enforced is an **error**, never an absence: the arm is refused and the run paused (`capCapabilityRefusal`), and a live run whose sentinel rolls back mid-flight parks (`capBeat`) |
| **Old bundle DELETING new fields** | `EPIC_RUN_KEYS` + `foreignKeys`: an unknown key is assumed to belong to a newer writer and survives the round trip |

---

## 5. HOLD, PARK, REFUSE -- the pattern to reuse

The card asked for the `runner-headroom-admission` distinction generalised. It is
three answers, and picking the wrong one is most of what makes a run wedge:

| Answer | When | Shape |
|---|---|---|
| **HOLD** | the condition **clears itself** | a per-beat predicate on the `when` axis, with a *countdown in the note on every tick*. Closed night window, another epic holding the queue, an appointment not yet due, no plan headroom |
| **PARK** | the condition needs **a human or a deploy** | flip to `paused`, write the reason to the baton, drop out of the armed set. Spend, wall clock, generations, unlanded work, a sentinel too old to carry the caps |
| **REFUSE** | the engine **cannot see** enough to decide | do nothing, say exactly what could not be read, act on the next tick. A torn artifact, a failed `get` |

Two rules fall out, and both are load-bearing:

- **A held beat is never silent.** A run with nothing in flight and nothing to
  show for itself is indistinguishable from one that quietly died, and this
  codebase's recurring failure is exactly that. The reason string IS the
  countdown.
- **Never PARK on something that fixes itself.** Parking on a 5h usage window
  needs a human to un-park a condition that cleared while they slept.

---

## 6. What is still not covered -- honestly

**R1. The recovery paths have never been exercised against a live system.**
Every row in §4 is tested at the unit or seam level. None has been tested by
restarting the real broker mid-beat or `kill -9`ing a real seat. Nine of the
twelve cite an incident, which is the tell: these were found by being hurt, not
by being reviewed. *This is the gate on auto-arm.*

**R2. A spawn is recorded AFTER it happens.** `spawnForCard` dispatches, then
appends the `dispatch` baton entry. If the baton write fails (sentinel down), a
live seat exists that the pending-seat guard cannot see, and the next beat may
dispatch a second one onto the same card. The **seat lease is the belt** and it
holds -- the second seat is refused and exits -- but the belt firing means the
guard above it had a hole, which is precisely the shape §3 says to audit. Not
fixed here: reversing the order trades this for a phantom entry for a spawn that
never happened, which is a worse lie in a file that is append-only. The honest
fix is a two-phase entry, and that is a card, not a line.

**R3. `fsync` is not called anywhere.** `writeFileAtomic` protects against a
killed *process*; it does not protect against power loss, which can still lose
the last write entirely. That was a deliberate trade (a real disk round trip on
every write) and the failure this box actually has is restarts and OOMs, not
power cuts. It is written down here so nobody reads more into "atomic" than is
there.

**R4. Not audited in this pass:** the promise ledger's crash behaviour, the
`git_fabric` 15s ceiling under a slow sentinel, and what a `.rclaude/` on a full
disk does to the baton append. Each is a card if it matters.

---

## 7. The smoke that would close R1

One session, in this order, on a scratch epic with two cards and one dependency:

1. Arm it. `docker restart broker` mid-beat. **Assert:** the armed set rehydrates,
   the quarantine holds for 2 minutes, the run resumes with no human input and no
   duplicate seat.
2. `kill -9` a live werk-worker's agent host. **Assert:** within
   `SEAT_SILENCE_MS` the slot is released, the card is acknowledged with a git
   report of what it left uncommitted, and the run continues.
3. `kill -STOP` the werk-master (alive, socket held, silent). **Assert:** the beat
   holds for `LEASE_STALE_MS`, says so with the age on every tick, then lifts and
   the CAS replaces the holder.
4. `SIGKILL` the sentinel during a lease write. **Assert:** the card on disk is
   the old one or the new one, never a prefix.
5. Set the broker container's clock 20 minutes forward. **Assert:** `CLOCK SKEW`
   in the log, and no dispatch underneath a live werk-master.

Five kills. If all five recover with no human input, the verdict in §0 flips.

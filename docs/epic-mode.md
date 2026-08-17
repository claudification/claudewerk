# Epic Mode — running an epic to completion

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
| **Implementer** | One card, own worktree, own branch. Moves the card to `in-review` when done. | Talk to a human. Approve its own work. Touch another card or branch. |
| **Verifier** | Re-runs the acceptance command, reads the diff, approves or bounces. | Talk to a human. See the implementer's conversation. |
| **Overseer** | Answers questions, merges verified work, replans the board, decides when to stop. Singleton. | Implement a card itself. Spawn anything. |

The implementer/verifier split is not ceremony. Anthropic's harness work found
that *"agents tend to respond by confidently praising the work"*, and Cognition
measured a review agent catching ~2 bugs per PR (58% severe) — but only when the
reviewer **did not share the coder's context**. A reviewer that reads the coder's
reasoning inherits the coder's blind spots. So `planVerifierSpawn` hands over the
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
   │  EPIC OVERSEER   gen N        one conversation, one turn, dies    │
   │  SINGLETON -- holds the lease on the epic card                    │
   │                                                                   │
   │  READS   epic rollup (children + waitingOn) . epic baton tail .   │
   │          git state . the needs-overseer question cards            │
   │  DECIDES answer questions | handle verdicts | merge | replan |    │
   │          ask Jonas | epic DONE                                    │
   │  WRITES  card frontmatter + append-only baton + the run digest    │
   └───┬───────────────────────────────────────────────▲───────────────┘
       │ (does NOT dispatch -- readiness is arithmetic)│  wake gen N+1
       ▼                                               │  "t2 settled"
   ┌───────────────────────────────────────────┐       │
   │  THE BEAT            planBeat()           │       │
   │  DAG order from depends_on . concurrency  │       │
   │  ceiling . cadence gate . dry-gen park    │       │
   └───┬───────────────────────────────────────┘       │
       │ dispatchSpawn(permissionMode: dontAsk         │
       │               + deny-floor + THE MUTE)        │
       ▼                                               │
   ┌──────────────────┐  ┌──────────────────┐          │
   │  IMPLEMENTER     │  │  VERIFIER        │   ...    │
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
   │  overseer at gen+1. The lease CAS lets exactly one waker through. │
   └───────────────────────────────────────────────────────────────────┘
```

---

## 3. Why the wake is state-based

The obvious design fires the overseer from a "worker ended" event. That loses a
settle whenever the overseer is mid-turn, and double-fires whenever two workers
end together — which is the normal case at concurrency 3, not an edge case.

So the beat asks a **standing question**: *is there a settled card the baton has
not acknowledged?* A missed sweep is repaired by the next one, and a duplicate is
refused by the lease compare-and-swap. Self-healing beats bookkeeping.

The guardian, not the implementer, fires the wake — an implementer that crashes,
hangs, or gets watchdog-killed never gets to call a check-in tool, and those are
three of the four ways a card settles.

---

## 4. The blocked channel — an implementer asks the BOARD

An implementer has no `dialog` and no `notify`. Not by convention: by a
`PreToolUse` hook keyed on tool name (`epic-worker-permissions.ts`).

> **`dontAsk` is not this.** `dontAsk` suppresses CC's own *permission* prompts.
> It does nothing about an agent deciding to call `dialog` and ask Jonas a
> question. Left prompt-only, "only the overseer asks" holds right up until the
> moment it matters.

When blocked, the implementer:

1. Writes a card tagged `needs-overseer` carrying the question **and its own
   recommendation** (a question with no recommendation makes the overseer redo
   the analysis).
2. Adds that id to its own card's `depends_on`.
3. Appends a `## Blocked` section to its own card.
4. Sets its card back to `open`, pushes what is safe, and stops.

Three things fall out for free: the DAG stops redispatching the blocked card, the
question is a first-class board object (and an andon row), and answering it —
moving the question card to `done` — unblocks the original with no special case.

---

## 5. Storage

```
<project>/.rclaude/project/
  cards/<epicId>.md          the epic card. Carries the LEASE:
                               overseer: conv_...   overseer_gen: 7
                               overseer_at: <iso>
  epics/<epicId>/
    run.md                   EpicRunMeta frontmatter + the overseer's digest
    log.md                   THE BATON -- append-only, never rewritten
```

The lease lives on the **card**, not in `run.md`, so a stuck overseer is visible
and breakable by a human reading the board without knowing the engine's layout.
`overseer_gen` survives a release: it is the run's generation counter, and reusing
a number would put two different beats in the baton under one id.

The baton is the overseer's entire memory. Every generation is a fresh
conversation with no transcript from the last one — which is what lets an epic
run past any context horizon.

---

## 6. Cadence is a mode, not an engine

| `cadence` | Dispatch | Verdicts |
|---|---|---|
| `now` | immediately, ignores the clock | always |
| `window` | deferred to the project's nightshift window | always |

A verdict lands either way: judging is not night work, and a card stuck in
`in-review` is the worst place for work to sit.

---

## 7. Stop conditions

| Condition | What happens |
|---|---|
| Every child terminal | `complete` — the overseer reports what landed and what was dropped |
| An irreversible step, or a decision that is Jonas's | `checkpoint` — one crisp question, recommendation first. The only path to a human. |
| Two consecutive generations with nothing dispatchable | `park` — the overseer gets exactly one chance to replan first |
| `gen >= maxGens` (default 40) | `park` — the run is thrashing, not working |

---

## 8. Relationship to the WERK cards

Epic mode is the delivery vehicle for two cards on
[werk-epic](../.rclaude/project/cards/werk-epic.md):

- **[werk-done-gate](../.rclaude/project/cards/werk-done-gate.md)** — Tier 1 and
  Tier 2 already shipped (`board-gate.ts`, wired into `project_set_status`).
  Tier 3, the judge leg with no shared context, was written as
  `buildGuardPrompt` and had **zero callers** until `planVerifierSpawn`.
- **[werk-andon](../.rclaude/project/cards/werk-andon.md)** — the concurrency
  default is **3**, and cards over the ceiling are reported as `heldBack` rather
  than silently truncated. The ceiling is a *review* ceiling.

It also takes a down-payment on
**[werk-governor](../.rclaude/project/cards/werk-governor.md)**: the generation
ceiling and the dry-generation park are per-run brakes. The fleet-wide governor
(lifting `nightshift-watchdog` out of tag scope) is still that card's job.

---

## 9. What is NOT wired yet

Honest status. The substrate and the decisions are built and tested; nothing
spawns an epic worker yet.

| Piece | State |
|---|---|
| Baton, run store, lease CAS, paths | **done**, sentinel-side, tested |
| `planEpic` (DAG + ceiling + lanes) | **done**, tested |
| `planBeat` (the decision) | **done**, tested |
| Prompts for all three seats | **done**, tested |
| The mute | **done**, tested |
| `launchConfig.epic` tag | **done** (protocol) |
| `EpicOp` / `EpicResult` + sentinel handlers | **done**, tested |
| Broker request handler + `EpicRequest`/`EpicEvent` | **not built** |
| Guardian sweep grouping on `epic` | **not built** |
| MCP verb to start/pause/abort a run | **not built** |
| A live end-to-end run | **never run** |

That last row is the one that matters. Nightshift has **0 completed runs ever**
and sat at "Phase F FAILED" from 2026-06-26; the blocker (the sentinel's
`expandPath` mangling a `claude://` URI) has since been fixed and covered by
`src/sentinel/expand-path.test.ts`, but the closed loop has still never been
demonstrated. **Do not add more substrate before one trivial two-card epic runs
end to end.**

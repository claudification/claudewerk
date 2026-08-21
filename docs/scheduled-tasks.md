# Scheduled Tasks

Scheduled spawns bound to a project -- either **recurring** on a cron or a
**one-shot** at a single moment. A schedule fires unattended on its own clock,
launches a conversation with a prompt you wrote once, and keeps a history of
every firing -- including the ones that did nothing.

## Vocabulary

The obvious words are all taken in this codebase, so:

| Term | Means |
|---|---|
| **SCHEDULE** (`sch_…`) | The persistent record: when + where + what |
| **RUN** (`schrun_…`) | One firing of a schedule; a row of history |
| `jobId` | UNCHANGED -- the per-launch progress-correlation id. A RUN carries one |

`task` is deliberately avoided in code: the `tasks` SQLite table holds CC todos,
and `.rclaude/project/` holds board cards. The UI says "Scheduled Tasks" because
that is what people call them; the code says SCHEDULE and RUN.

## Two kinds: repeating and one-shot

A schedule carries **exactly one** of these. Both, or neither, is rejected at the
door.

| Kind | Field | Means |
|---|---|---|
| **Repeating** | `cron` | A 5-field expression, evaluated as wall-clock in `tz` |
| **One-shot** | `runAt` | A single **instant** (epoch ms). Fires once, then disarms itself |

A one-time task is genuinely a different thing from a recurrence, not a cron
with `maxRuns: 1`. Forcing it through cron would make the UI describe "run once
on 15 Aug" as *"every year on the 15th of August"* -- a lie it would keep telling
right up until it fired.

`runAt` is an **instant, not a wall clock**, which is what makes one-shots immune
to everything in the next section: there is no gap to fall into and no repeated
hour to dedupe. The editor converts the wall clock you type, in the zone you
pick, into that instant -- and refuses a time that does not exist there.

**Firing late is usually right.** "Run at 15:00" with the broker down 15:00-15:04
should still run at 15:05; that is what a one-time instruction means. But late
has a limit: past a **6-hour grace** the schedule records a `missed` run
explaining how overdue it was, then disarms. Waking a three-day-old task on
Monday morning is a surprise, not a service.

**After firing it is disarmed, never deleted.** The record and its history stay
so you can see what ran and open the conversation it spawned.

`maxRuns` is unchanged and still applies to *repeating* schedules -- the two are
orthogonal: `maxRuns` bounds a recurrence, `runAt` replaces one.

## Timezones -- read this first

**The broker container runs in UTC.** `docker exec broker date` says so, and
there is no `TZ` in `docker-compose.yml`. A cron expression without a zone would
therefore be evaluated against UTC wall-clock, not yours: `0 9 * * *` would fire
at 11:00 in Berlin summer.

So every schedule carries a **required IANA `tz`**, defaulted from the creating
browser. Matching happens against wall-clock fields projected into that zone
(`cron-time.ts`, via `Intl.DateTimeFormat.formatToParts`).

DST is handled by construction, not by luck:

| Transition | Behaviour |
|---|---|
| Spring forward (02:00 -> 03:00) | A schedule set inside the gap does not fire that day. The wall clock does not exist, and inventing one is worse than skipping. |
| Fall back (02:00 happens twice) | Fires **once**. The `lastFiredMinuteKey` guard (zone-qualified, minute-resolution) suppresses the second pass, and `nextFires` resolves the ambiguous clock to its EARLIER instant so the preview agrees with the tick. |

Both directions are pinned in `src/shared/cron-parse.test.ts`.

### Nothing renders a bare time

`src/shared/format-when.ts` is the single place that decides how an instant is
shown, and it always shows three things together:

```
Cron       0 9 * * 1-5  (Europe/Berlin)
Next run   Wed 13 Aug, 09:00
           in 2 minutes
```

When the viewer's zone differs from the schedule's, the absolute line shows both
(`09:00 Europe/Berlin -- 08:00 your time`); when they agree, one. The relative
line ticks off a single shared 30s timer (`useRelativeTime`), not one per row.

## Cron syntax

Five fields, standard Vixie semantics. No dependency -- `src/shared/cron-parse.ts`.

```
minute hour day-of-month month day-of-week
```

- `*`, `n`, `a-b`, `*/n`, `a-b/n`, and comma-separated lists of those
- month accepts `jan`..`dec`; day-of-week accepts `sun`..`sat` (and `7` = Sunday)
- macros: `@hourly` `@daily` `@midnight` `@weekly` `@monthly` `@yearly` `@annually`
- **when BOTH day-of-month and day-of-week are restricted, a day matches if
  EITHER does** -- that is why `0 0 13 * fri` means "the 13th, and every Friday"

Minimum granularity is one minute; the engine ticks at 60s. A one-shot has no
cron at all -- see the two kinds above.

`describeCron()` renders the expression back as a sentence ("Every weekday at
09:00"), shown live under the input so a typo is caught before saving.
`describeWhen()` wraps it so a one-shot gets the same treatment ("Once, Thu 13
Aug, 09:00 (Europe/Berlin)") and every surface renders one kind of sentence.

## What a schedule spawns

The `spawn` field is the **same partial spawn snapshot a launch profile carries**,
which is why the editor reuses `LaunchConfigFields` from the spawn dialog rather
than growing a second, drifting launch form.

Defaults for a new schedule:

```ts
{ adHoc: true, leaveRunning: false, headless: true, transport: 'claude-headless' }
```

`adHoc` is the seam that makes the worker **exit after its turn**
(`shouldExitAfterResult`). Without it every scheduled run would leak a live
session until the watchdog reaped it. The editor's "Run type" control flips this
to Persistent (`leaveRunning: true`) when you want the conversation to stay open.

Precedence when building the spawn request: launch profile (if `profileId`) <
the schedule's own `spawn` < the fields the schedule OWNS (`cwd`, `prompt`, name,
description). Nothing inherited can redirect the target or replace the prompt.

## Policies

| Policy | Default | What the other option does |
|---|---|---|
| `overlap` | `skip` -- do not fire while the previous run is alive | `parallel`: fire regardless |
| `catchUp` | `skip` -- record the gap, run nothing | `once`: re-run a single missed fire, if less than 6h stale |
| `maxRuns` | unlimited | stops and disarms after N runs |
| `startAt` / `endAt` | none | window outside which it never fires |

**Missed fires.** On boot the engine reconciles what an outage skipped: one
`missed` RUN row per expected fire (capped at 20) so the gap is visible in
history, and nothing is replayed unless `catchUp: 'once'`. Waking up to forty
queued overnight runs is worse than a gap.

**Failure backoff.** Five consecutive *dispatch* failures disarm the schedule and
send a push. A successful run resets the counter; re-enabling from the UI also
clears it. Agent-turn quality is not judged here -- only whether the spawn
happened.

**Concurrency.** At most 3 scheduler-originated spawns in flight globally;
excess records `skipped_overlap`. A slot is held only for the duration of the
dispatch, so a fire that is *refused* never occupies one. (Until 2026-08-21 the
count was the engine's double-fire set, which included the schedule asking, so
the ceiling of 3 actually admitted 2.)

**Work orders and reserved seats.** A schedule may name an `orderId` -- today
only `REFINER@1` (`src/shared/refiner-order.ts`). The order supplies the seat's
caps (model, effort, budget, deny rules), composed through `composeOrderCaps` so
it can only ever *narrow* what the scheduler already holds, and it declares a
`reservation`: how many of the 3 slots that role may hold at once. `REFINER@1`
reserves 1, so a backlog of `#needs-refine` cards leaves 2 slots permanently
reachable by the nightly sweep and the recap. A schedule naming no order is
bounded by the global ceiling alone.

| Refusal in `error` | Means |
|---|---|
| `scheduler at its concurrency ceiling (3)` | The whole pool is busy -- raise the pool |
| `order X holds its reserved N of 3 scheduler slots` | That role is at its share while the pool has room -- raise the reservation |

## Run history

Every firing writes a row, including the ones that launched nothing:

| Outcome | Means |
|---|---|
| `spawned` | A conversation was launched |
| `error` | Dispatch failed (or the owner lost permission) |
| `skipped_overlap` | Previous run still alive, or the concurrency ceiling was hit |
| `missed` | Should have fired during an outage; recorded, not run. Also how a one-shot records that it went stale |
| `skipped_disabled` | Reserved |

That is deliberate: a schedule that quietly never runs must look different from
one that runs fine. Retention is 200 runs per schedule / 90 days.

## Security

A schedule **is** a spawn -- one that fires later, unattended, with nobody at the
keyboard. So:

- every route is gated on the **`spawn` permission**;
- the schedule records `createdBy`, and that user's **current** grants are
  re-checked at **every fire**. A revoked or demoted owner disarms the schedule
  rather than continuing to launch work;
- scheduled fires run with `bypassApprovalGate`. The interactive spawn-approval
  dialog exists so a human can vet a spawn, and at 03:00 there is no human. The
  vetting happens at CREATE time instead. Hard rejects (bypassPermissions,
  sensitive env) are not bypassable either way, and the scheduler identifies as
  `trusted`, never `benevolent`.

## HTTP API

All routes require authentication and the `spawn` permission.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/scheduled-tasks` | all schedules; `?project=<uri>` filters |
| POST | `/api/scheduled-tasks` | create; validates cron + tz, 400 with the failing field |
| PATCH | `/api/scheduled-tasks/:id` | any subset; the MERGED record is re-validated |
| DELETE | `/api/scheduled-tasks/:id` | removes the schedule and its history |
| POST | `/api/scheduled-tasks/:id/run` | fire now, off-schedule (`trigger: manual`) |
| GET | `/api/scheduled-tasks/:id/runs` | history, newest first; `?limit=` |

WebSocket broadcasts: `scheduled_tasks_updated` (full list, after any change) and
`scheduled_task_run` (one firing). The panel is kept fresh by these, not polling.

"Run now" deliberately does **not** stamp the fire marker, so clicking it during
a scheduled minute cannot suppress -- or double -- the real run.

## The agent surface (MCP)

An agent gets the same CRUD the panel has, through six tools. They are named
**`schedule_*`, never `task`** -- `TaskCreate` in the same toolbelt makes a todo
item, while these arm a spawn that fires at 03:00 whether or not anyone is
watching, and naming them alike is how an agent reaches for the wrong one.

| Tool | Does |
|---|---|
| `schedule_list` | Schedules in your project (or one you name, if benevolent) |
| `schedule_get` | One schedule + its run history, including the fires that launched nothing |
| `schedule_create` | Arm a new one |
| `schedule_update` | Change anything, **including `enabled`** -- that is enable/disable |
| `schedule_delete` | Remove it and its history |
| `schedule_run_now` | Fire off-schedule (does not stamp the fire marker) |

### The trust gate

A schedule is a spawn with nobody at the keyboard, so the agent surface is
narrower than the panel's:

| | Requires |
|---|---|
| create / update / delete / run_now | **benevolent** trust |
| read your OWN project | any agent-host caller |
| read ANOTHER project | **benevolent** trust |

The approval dialog that vets an ordinary spawn cannot help here -- it exists so
a human can look at it, and the whole point of a schedule is that it fires when
no human is present. So for an untrusted conversation the answer is no, not
"ask later". Naming someone else's project on a read is REFUSED rather than
quietly narrowed: a silent narrowing reads as "that project has no schedules",
which is a different and wrong answer.

The caller's project always comes from the broker's view of its connection,
never the wire body.

### Who it runs as

A conversation is not a permission principal, and `ownerMaySpawn` re-checks a
real user's grants at **every fire**. So an agent-created schedule still has a
human `createdBy`:

- one registered spawn-capable user -> that user, no argument needed;
- several -> the create is REFUSED until it passes `owner`, because guessing
  would pin someone else's permissions to work they never authorised;
- a named owner who does not exist, is revoked, or lacks `spawn` -> refused.

That last check is the same predicate the engine applies later, run early on
purpose. Skipping it would produce a schedule that looks armed in the panel and
then disarms itself after five silent dispatch failures, weeks later.

### Two defaults that are silent when wrong

- **Timezone** defaults to the AGENT HOST's zone, never the broker's -- the
  container is UTC, so an unzoned schedule fires at the wrong hour. Every tool
  result prints the zone back.
- **Directory** defaults to the project ROOT with any `.claude/worktrees/<name>`
  segment folded away. A schedule pinned to a worktree outlives that worktree
  and then fires into a directory that no longer exists.

## Where things live

| Concern | File |
|---|---|
| Cron parse + match | `src/shared/cron-parse.ts` |
| "When does it run?" sentence | `src/shared/describe-when.ts` (both kinds) |
| Next-fire projection | `src/shared/cron-next.ts`, `src/shared/schedule-next-fire.ts` |
| Timezone projection | `src/shared/cron-time.ts` |
| English description | `src/shared/cron-describe.ts` |
| Time display rules | `src/shared/format-when.ts` |
| Record + validation | `src/shared/scheduled-task.ts` |
| Fire decisions (pure) | `src/broker/scheduled-tasks/policy.ts` |
| The tick | `src/broker/scheduled-tasks/engine.ts` |
| Firing + run rows | `src/broker/scheduled-tasks/fire.ts` |
| Outage reconciliation | `src/broker/scheduled-tasks/catch-up.ts` |
| Broker wiring | `src/broker/scheduled-tasks/wiring.ts` |
| Create/patch (shared by routes AND agents) | `src/broker/scheduled-tasks/operations.ts` |
| Owner attribution | `src/broker/scheduled-tasks/owner.ts` |
| Routes | `src/broker/scheduled-tasks/routes.ts` |
| Agent wire handlers + trust gate | `src/broker/handlers/scheduled-tasks-mcp.ts`, `scheduled-tasks-gate.ts` |
| Agent tools | `src/agent-host-common/mcp-host/mcp-tools/schedule*.ts` |
| Storage | `src/broker/store/sqlite/scheduled-tasks.ts` (+ memory twin) |
| Control panel | `web/src/components/scheduled-tasks/` |
| Sidebar badge | `web/src/components/project-list/project-badges.tsx` |

## Operating

```bash
# which schedules are one-shots, and when they fire
docker exec broker broker-cli query \
  "SELECT id, name, cron, run_at, enabled FROM scheduled_tasks"

# every fire, with full context
docker compose logs -f broker | grep '\[sched\]'

# one schedule end to end
docker compose logs --tail=2000 broker | grep 'sch_1a2b3c4d'
```

A fire line carries id, name, project, cron, tz, the wall-clock minute, trigger,
outcome, conversation and job ids, plus the error when there is one -- enough to
reconstruct what happened without the database.

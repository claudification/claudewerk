# Performance Monitor

The control panel ships an opt-in, in-browser performance monitor -- the **Perf**
tab in "Details for Nerds" (Cmd+P -> `Details for Nerds`, or the `nerd-modal`).
It records a ring buffer of timed samples, rolls them up by category and by wire
message, and exports a markdown report. It is **OFF by default** and records
nothing until enabled; when off, every `record()` call is a no-op so there is
zero overhead.

This doc explains **what each number means** -- because a raw millisecond figure
without its category and context lies (a 3s `commit->paint` once looked like
catastrophic switch lag but was just a backgrounded tab; see
`.claude/docs/plan-transcript-switch-perf.md`).

## Turning it on

| How | Where |
|-----|-------|
| User | Settings > Developer > "Performance monitor" toggle |
| Agent (remote) | `web_set_perf_monitor {enabled:true}` MCP tool (see below) |

Both paths call the same `updateControlPanelPrefs({ showPerfMonitor })`, which
persists the pref **and** flips the ring buffer via `setPerfEnabled()`. Turning it
off clears the buffer.

## The two things we actually measure

Cost lands in two fundamentally different places, and the monitor keeps them
separate because they have different causes and different fixes:

1. **Synchronous work** -- JS that runs to completion on the main thread in one
   go: parsing a WS frame, a message handler building new store state, the
   incremental grouping pass. Fully attributable to whatever triggered it.
2. **Asynchronous render work** -- a store mutation schedules a React re-render;
   React commits on a later microtask, and the browser paints on the *next
   frame*. The commit and the paint are separated from the mutation that caused
   them, so they're attributed to a **batch**, not a single call.

Everything below is one or the other.

## Categories

Each sample has a `category`, a `label`, a `durationMs`, and (when known) a
`msgType` attribution tag. The categories:

| Category | What it measures | Sync/async | Source |
|----------|------------------|------------|--------|
| `message` | One wire message's **synchronous handler apply** cost -- the handler building new store state inside the batched flush loop. Label `apply:<type>`. Excludes the Zustand notify (deferred to batch end). | sync | `use-websocket.ts` flush loop |
| `ws` | Transport: `onmessage` (JSON parse + routing) and `flush` (the whole rAF batch wall-time). **Wraps** the per-message apply spans. | sync | `use-websocket.ts` |
| `render` | React **commit** cost = `Profiler.actualDuration`. Time React spent rendering+committing the changed fibers. Label = the `<Profiler id>` (e.g. `ProjectList`, `TranscriptGroups`). | async | `MaybeProfiler` (`perf-profiler.tsx`) |
| `render` (`<id>.commit->paint`) | Time from React's commit to the **next browser paint** -- where layout, style recompute, and compositing live. This is the cost the *user* feels and it is NOT in `actualDuration`. | async | `useCommitToPaintTimer` |
| `grouping` | Transcript incremental grouping (entries -> display groups). | sync | `useIncrementalGroups` |
| `scroll` | Scroll re-pin / settle work on conversation switch + follow. | sync/async | transcript scroll logic |
| `transcript` | Transcript maintenance: live-cap prune, page-cache push. | sync | `use-websocket.ts` prune |
| `other` | Zero-duration **markers**, not costs: `list.rerender` (per-frame row/group re-render tally) and `visibility` (tab hidden/shown). Never pollutes the timing stats. | n/a | `tallyListRender`, visibility marker |

### `actualDuration` vs `baseDuration` (the `base=` in render details)

React's Profiler reports both. `actualDuration` (the headline number) is what
this render **actually cost**, given memoization. `baseDuration` (shown as
`base=Nms` in the detail) is what it **would have cost with no memoization at
all** -- i.e. the headroom your `memo`/`useMemo` is buying. A render with
`actualDuration` 4ms / `base=25ms` means memoization saved ~21ms; if those two
numbers converge, your memoization has stopped working.

## The "By message" rollup

`messageImpactStats()` answers *"what does each inbound wire message DO?"* by
keying every sample on its `msgType` tag:

| Column | Meaning |
|--------|---------|
| `n` | number of `apply:` spans (how many of this message arrived) |
| `Apply` | total synchronous handler cost (exact) |
| `Render` | total React commit cost it triggered (`render`, excl. commit->paint) |
| `Paint` | total commit->paint cost it triggered |
| `Group` | total grouping cost |
| `Total` | `Apply + Render + Paint + Group + other downstream` |

**Attribution model:**
- **Apply is exact** -- one timed span per message, tagged with that message's type.
- **Render/Paint/Group are approximate** -- they fire after the batch's Zustand
  notify, so there's no single message to blame. They're credited to the
  batch's **dominant** message type (the most frequent type in that flush),
  within a 250ms window after the flush. A pure-streaming batch (all
  `transcript_entries`) is exact; a mixed batch credits the heaviest contributor.
  The full per-flush composition stays visible in the `ws flush` timeline entry.
- **`ws` is excluded from Total** -- the flush wall-time is measured *around* the
  apply loop, so it already contains every `apply:` span in that batch. Summing
  both would double-count the handler cost. Transport overhead therefore lives in
  the Summary's `ws` row only, never in a message's Total.

## Supporting signals in the Timeline

The exported report interleaves perf samples with `debug-log` lines so a spike
sits next to the thing that caused it. The log lines you'll see and what they mean:

| Log tag | Meaning |
|---------|---------|
| `[switch-diag]` | Per conversation-switch: `msToPaint` (switch click -> paint), `domTotal` (DOM node count), `transcript`/`sidebar`/`header` (per-subtree node counts), `vrows` (virtualized rows), `cmEditors` (mounted CodeMirror instances). |
| `[list-churn]` | Per-frame conversation-list re-render tally: `rows=N groups=M`. A memo leak shows MANY rows per store mutation; selector churn shows the store notifying constantly while rows stay ~0 or 1. Constant `rows=1` while idle = a ticker selector (relative time / live cost) re-rendering one row. |
| `[grouping]` | `N new entries -> M groups (X.Xms)` -- the incremental grouping pass. |
| `[sync]` | Transcript sync: `FETCH`/`GOT`/`REFETCH`, cache hits, seq tracking. |
| `[chunk]` | Lazy-chunk load timings (code-split bundles). A cold switch that also loads a chunk pays both -- don't blame the switch for the chunk's ms. |
| `[follow]` | Transcript follow/anchor state (switch-pin, settle, drift). |
| `[transcript-prune]` | Live-cap eviction into the page cache. |

### The rAF-suspension caveat

A backgrounded tab pauses `requestAnimationFrame`, so a `commit->paint` that
spans a hidden period shows a multi-second gap that is **wall-clock idle, not
main-thread jank**. Those samples are tagged `suspended(tab-hidden)` and are
**excluded** from the Summary's avg/p95/max (and from the By-message rollup) so
they don't poison the aggregates -- but they stay in the raw timeline. A huge
number with a `suspended` tag is an artifact, not a stall.

## MCP tools (remote, opted-in browser)

When a control-panel browser has opted in to agent remote-control (Settings >
System > Debug; default-deny, 1h grant), an agent can drive the perf monitor:

| Tool | Args | Does |
|------|------|------|
| `web_set_perf_monitor` | `enabled: boolean`, `clientId?` | Turn the monitor on/off (mirrors the Settings toggle). |
| `web_perf_report` | `significantOnly?: boolean`, `clientId?` | Grab the markdown report (Summary + By message + Timeline). Errors if the monitor is OFF. |

**Workflow:** `web_set_perf_monitor {enabled:true}` -> ask the user to reproduce
the slow activity -> `web_perf_report` -> `web_set_perf_monitor {enabled:false}`
(the Profiler wrappers add per-commit overhead while on). Use `significantOnly`
to cut sub-2.5ms noise.

## Code map

| File | Owns |
|------|------|
| `web/src/lib/perf-metrics.ts` | ring buffer, `record()`, `categoryStats`, `messageImpactStats`, `PerfCategory` |
| `web/src/lib/perf-message-context.ts` | per-message + flush-batch attribution tags |
| `web/src/lib/perf-report.ts` | `buildPerfReport()` (shared by Copy button + MCP) |
| `web/src/components/perf-profiler.tsx` | `MaybeProfiler` -- commit + commit->paint timing |
| `web/src/components/nerd-modal.tsx` | the Perf tab UI |
| `web/src/components/nerd-modal-message-impact.tsx` | the By-message table |
| `web/src/lib/web-control-dispatch.ts` | browser side of the `perf_report` / `set_perf_monitor` ops |
| `src/broker/routes/mcp-server.ts` | the `web_perf_report` / `web_set_perf_monitor` MCP tools |

For the transcript-switch perf deep dive (evidence, ruled-out causes, root cause,
profiling method) see `.claude/docs/plan-transcript-switch-perf.md`.

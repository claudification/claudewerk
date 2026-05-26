# Daemon Backend Sweep -- Actionable Findings

**Date:** 2026-05-27\
**Scope:** Full sweep of the `claude --bg` daemon backend (cc-daemon + daemon-agent-host + sentinel daemon dispatch + broker daemon handlers + web daemon UI) against the shipped plans, the protocol covenants, and upstream Claude Code reality.\
**Method:** Read every daemon-tagged file (~7,900 LOC); audited logs + structured-wire emissions against the EVERYTHING IS A STRUCTURED MESSAGE + LOG EVERYTHING covenants; verified protocol claims against the running 2.1.150 binary and the public CC changelog.\
**Plans referenced:** `plan-daemon-launch-ux.md` (phases A-I shipped on origin/main), `plan-daemon-followups.md` (commits 1-2 shipped, commit 3 deferred), `plan-claude-agents-integration.md` (superseded substrate).

This is a punch list, ordered by impact. Each item has a one-line WHAT, a WHY-it-matters, and a concrete file:line FIX target. No speculation -- if the fix needs a spike, it's marked SPIKE-GATED.

---

## P0 -- broken behavior the user can hit today

### P0-1. Permission UI is broken end-to-end for daemon conversations

**What.** When a daemon worker hits a tool-permission gate, the dashboard's Allow/Deny dialog produces a `permission_response` wire message. The broker forwards it to whichever socket owns the conversation (`src/broker/handlers/permissions.ts:65-75`). For a daemon conv that socket is the daemon-agent-host -- whose `handleInbound` (`src/daemon-agent-host/index.ts:247-286`) has NO case for `permission_response`. The message falls through to `bridge.handleMessage(msg)` (line 285), which is the PTY bytes channel. Net effect: the JSON object is either silently dropped or typed verbatim into the worker PTY.

**Why it matters.** The web Allow/Deny button does nothing visible. Users see a permission prompt, click Allow, the worker stays blocked. Plan Section 8 already proved the daemon `permission-response` op is a stub in 2.1.145; the real path is `reply()` with `"1"`/`"2"`/`"3"` text. The `daemon-control.ts` `reply` op already works for the chat-box path. We just never wired `permission_response` to it.

**Fix.** In `src/daemon-agent-host/index.ts:247-286`, add a branch:

```ts
if (t === 'permission_response') {
  const decision = (msg as PermissionResponseFromBroker).behavior  // 'allow' | 'allow_always' | 'deny'
  const text = permissionDecisionToText(decision)   // '1' | '2' | '3'
  void daemonControl.reply(text).catch(err => log(`permission reply error: ${err.message}`))
  return
}
```

Add `permissionDecisionToText` (decision -> "1"/"2"/"3") in a shared util (it's also useful for the broker if it ever wants to log the actual text). Plan-daemon-launch-ux.md Section 8 spike result documents the 1/2/3 mapping (lines 1473-1481).

Emit a `DaemonControlResult` either way so the toast in `web/src/lib/daemon-control.ts:56` fires.

**Test:** add a daemon-host inbound-route unit test that asserts `permission_response` -> `daemonControl.reply('1')`, and the `DaemonControlResult` is emitted.

---

### P0-2. `daemon_launch_event` is a dead wire contract

**What.** The protocol type `DaemonLaunchEvent` (`src/shared/protocol.ts:2580-2625`), all 8 `DaemonLaunchStep` enum values (`dispatch_requested`, `worker_dispatched`, `attach_started`, `attach_retry`, `attached`, `attach_lost`, `reattached`, `worker_gone`), the broker handler `src/broker/handlers/daemon.ts` `normalizeDaemonLaunchEvent`, and the test fixture all exist. NO code calls `transport.send({type:'daemon_launch_event', ...})` anywhere. Repo-wide grep confirms: the protocol type, the broker handler, the handler test, and the unused enum values are the only hits.

**Why it matters.** This is a direct EVERYTHING IS A STRUCTURED MESSAGE covenant violation. Every dispatch/attach/retry/re-attach/worker-gone transition the plan promises ships today as either an untyped `launch_log` (sentinel side) or a wrong-typed `boot_event` (host side, hiding `attach_lost` and `reattached` inside `awaiting_init`). The control-panel launch timeline cannot tell ATTACH from NEW from RESUME; an attach drop+reattach looks identical to a slow first boot.

**Fix.** Wire the producer side. Per plan Section 3.2 the daemon-host is the authority. Producer locations:

| Step | Producer site (file:line) |
|---|---|
| `dispatch_requested` | `src/sentinel/index.ts:1113` (just before `dispatchDaemonWorker`) -- sentinel-emitted; daemon-host doesn't see the dispatch |
| `worker_dispatched` | `src/sentinel/index.ts:1120` (just after `claude --bg` returns the short) -- sentinel-emitted |
| `attach_started` | `src/daemon-agent-host/index.ts:333` (entering `attachWithRetry`) |
| `attach_retry` | `src/daemon-agent-host/attach-retry.ts` (the existing `onRetry` callback) |
| `attached` | `src/daemon-agent-host/index.ts:350` (after ack) |
| `attach_lost` | `src/daemon-agent-host/index.ts:360-373` (`handleAttachClose`) |
| `reattached` | `src/daemon-agent-host/index.ts:386-389` (after re-attach succeeds) |
| `worker_gone` | `src/daemon-agent-host/index.ts:380-383, 458-463` |

Since sentinel and daemon-host both emit, the broker handler must accept it from either source. The sentinel currently emits `launch_log` (`src/sentinel/index.ts:1407`) -- replace these calls with `daemon_launch_event` emission for daemon dispatches, or have the broker translate `launch_log` -> `daemon_launch_event` when `backend === 'daemon'`. Preferred: emit the typed message at the source.

**Pattern to copy.** `src/claude-agent-host/launch-events.ts` is the reference module per the project CLAUDE.md covenant. Create `src/daemon-agent-host/launch-events.ts` with the same shape: emit helper + 500-entry replay buffer + replay-on-reconnect hook. Today there is no buffer -- a late-attaching dashboard misses every step that happened before its WS connect.

**Test:** assert each `DaemonLaunchStep` value fires from its expected site. Smoke test: dispatch NEW, kill the socket mid-attach, check the buffer replays attach_started -> attach_lost -> reattached -> attached.

---

### P0-3. `/clear` rotation never pushes the new `ccSessionId` to the broker

**What.** When a daemon worker runs `/clear`, the session observer detects a new JSONL filename in the project directory and calls `onSessionId(nextSessionId)` in `src/daemon-agent-host/index.ts:295-324`. The host sends a `conversation_reset` (line 320) and calls `transport.setSessionId(nextSessionId, 'stream_json')` (line 299). The `setSessionId` mutates host-local transport state only -- it does NOT push a typed `update_conversation_metadata` to the broker. The broker's `agentHostMeta.ccSessionId` goes stale until the next reconnect rebuilds `buildMeta()`.

**Why it matters.** Claude-agent-host's `session-transition.ts` sends BOTH `conversation_reset` AND a meta update (per the IDENTITY MODEL section in `.claude/CLAUDE.md`). Daemon-agent-host emits only the reset. Broker-side telemetry, transcript-folder mapping, and any code that reads `agentHostMeta.ccSessionId` will see the OLD ccSessionId after a daemon `/clear` until the next disconnect-reconnect cycle. Combined with the lack of `daemon_launch_event` for the rotation, the user cannot tell from the UI that the session rotated at all.

**Fix.** In `src/daemon-agent-host/index.ts:314-323` (the non-`isFirst` branch of `onSessionId`), emit `update_conversation_metadata` carrying the new ccSessionId into the opaque `agentHostMeta` bag, mirroring `src/claude-agent-host/session-transition.ts`. The broker writer is whitelisted; the boundary rule is satisfied.

**Log fix on the same line.** The current `log('ccSessionId rotated -> ${nextSessionId.slice(0, 8)} (/clear)')` at line 314 is missing the previous ccSessionId, the conversationId, the rotationCount, and the transcript path before/after. This is a LOG EVERYTHING covenant violation -- a flap would be invisible. Required fields per the covenant box: prev/next state + ids + counts + ages.

**Test:** rotate ccSessionId via the session-observer test harness, assert both `conversation_reset` and `update_conversation_metadata` ship, assert the meta carries the new ccSessionId.

---

## P1 -- covenant violations + structural gaps

### P1-1. `cc-daemon/*` library has ZERO logging on op failures

**What.** Every op in `src/shared/cc-daemon/ops.ts` (`ping`, `list`, `has`, `dispatch`, `reply`, `kill`, `respawnStale`, `awaitAck`) throws on failure but never logs. `client.ts` and `attach.ts` are the same. The only fail-path observability is whatever the caller chooses to log; most callers do `.catch(err => debug(...))` which loses the op name and short context.

**Why it matters.** When a daemon op fails (EPROTO mismatch, ENOJOB, ESTARTING storm), the only evidence is the catch-site message -- which is sometimes `debug()`-only (not surfaced in prod), and sometimes missing the daemon error `code` field entirely. Reproducing a daemon protocol regression in prod requires a re-attach with strace.

**Fix.** This is library code, so emitting wire messages from inside `cc-daemon/` would violate layering. But a `(err: DaemonError) => void` injected logger callback wouldn't. Wire a `logCallback` option into each op's options bag (default no-op); set it from each call site to a structured logger that includes op name + short + conversationId + the daemon `code` field. Two-line change per op, eliminates the blind spots.

Alternative: re-export a `wrapWithLogging(ops, logger)` higher-order factory in `cc-daemon/index.ts` so call sites can opt in once.

**Files:** `src/shared/cc-daemon/ops.ts`, `client.ts`, `attach.ts`, `subscribe.ts`. Call sites: `daemon-control.ts`, `daemon-agent-host/index.ts`, `session-observer.ts`.

---

### P1-2. `DaemonPermissionResponse` is dead protocol bloat (or the P0-1 fix wires it)

**What.** `DaemonPermissionResponse` is declared in `src/shared/protocol.ts:2756`, listed in `DAEMON_CONTROL_OPS` at `src/broker/handlers/daemon.ts:377`, and given a toast label in `web/src/lib/daemon-control.ts:32`. NO handler routes or produces it. `src/daemon-agent-host/daemon-control.ts:17-19` explicitly comments it as "spike-gated and NOT wired here yet."

**Why it matters.** A published wire contract that nobody honors is technical debt with negative documentation value -- a future engineer reading `protocol.ts` reasonably assumes it works. The plan (Section 8 spike findings, lines 1452-1530) settled the question: the daemon op is dead, the real channel is `reply()` with `"1"`/`"2"`/`"3"`.

**Fix.** Two options, pick one:

- **A. Delete** `DaemonPermissionResponse`, the `permission_response` enum value in `DAEMON_CONTROL_OPS`, and the toast label. Drop the spike script comment to a single-line note pointing at the plan.
- **B. Keep + wire** -- as part of P0-1, redirect `DaemonPermissionResponse` to invoke `daemonControl.reply(text)` with the decision-to-text mapper. The plan's Section 8 Phase G implementation proposal (lines 1452-1530) is the spec.

Either is fine; the current half-built state is the worst of both. RECOMMENDED: B, as a single change with P0-1. Note: the wire `requestId` field becomes broker-internal-only telemetry -- never sent to the daemon (the daemon op is dead, and `reply` has no correlation).

---

### P1-3. Plan Section 11.4 wire messages not implemented

**What.** Plan-daemon-launch-ux.md Section 11.4 specifies four follow-up wire messages. Two shipped (`cc_version_changed` @ d3fb9f0f, `daemon_session_retired` @ 2aa2844a). Two never landed:

- `external_claude_sessions_observed` -- sentinel emits when `claude agents --json` finds sessions the broker did not launch (Section 11.1 A1/A2)
- `cc_min_version_unmet` -- sentinel emits when `defaultBackend='daemon'` is requested but `claude --version` < 2.1.142

`grep -r --include='*.ts'` returns ZERO hits for either name across `src/`.

**Why it matters.**

- `external_claude_sessions_observed` makes orphan `claude --bg` sessions (started outside the broker) visible. Without it, users running `claude --bg` from a terminal create invisible workers that race against broker-spawned ones for the daemon's name registry. The 2.1.145 `claude agents --json` op makes this cheap (Section 11.1 verified the schema).
- `cc_min_version_unmet` is the safety net for the P3-2 cutover. The current `defaultBackend: 'pty'` default protects the user, but the moment `defaultBackend='daemon'` is flipped on a host with CC < 2.1.142, sleep/wake will silently drop conversations. The plan says ship as defensive guard.

**Fix.**

- `cc_min_version_unmet`: add to `src/sentinel/cc-version-watcher.ts` (the watcher already pings the daemon). If `version < 2.1.142` AND `global.defaultBackend === 'daemon'`, emit the typed event on every poll until the version updates or the flag is cleared. Reuse the existing replay-on-reconnect harness used by `cc_version_changed`. ~30 LOC.
- `external_claude_sessions_observed`: new `src/sentinel/claude-agents-probe.ts` per Plan Section 11.1 A1, running `claude agents --json --cwd <projectPath>` on a 10s cadence. Diff against the broker's known short set; emit the typed event for unknown sessions. ~150 LOC + tests.

Either of these is a SURGICAL ticket; doing both is a small worktree.

---

### P1-4. `cc-daemon-socket-protocol.md` roster.json schema is incomplete

**What.** `docs/cc-daemon-socket-protocol.md` documents `~/.claude/daemon/roster.json` at a summary level. The actual 2.1.150 schema (verified by direct read) includes more per-worker fields than our doc lists: `pid`, `procStart`, `sessionId`, `rendezvousSock`, `ptySock`, `cliVersion`, `startedAt`, `attempt`, `cwd`, `dispatch{proto, short, nonce, sessionId, createdAt, source, cwd, launch{mode, args}, env, isolation, respawnFlags, agent, seed{intent}, cols, rows}`, `decModes[]`. Top-level: `proto`, `supervisorPid`, `updatedAt`, `workers{}`.

**Why it matters.** A future engineer (or an LLM reading our doc) cannot tell which fields are stable vs. observed-only-on-one-version. The `dispatch.respawnFlags`, `dispatch.seed.intent`, and `dispatch.isolation` fields look interesting for adopt/respawn flows but are absent from our doc.

**Fix.** Update Section "Roster schema" in `docs/cc-daemon-socket-protocol.md` with the full field list. Mark each field as VERIFIED (proto:1, version range), so a future schema diff is grep-able. Tag the `messagingSock` field as "only populated on adopt/unverified-claim paths" per the plan-daemon-launch-ux.md Section 8 spike (line 1378).

Stale version references: the doc claims 2.1.143. Bump to "verified on 2.1.150" and list verified range.

---

### P1-5. ATTACH mode is not distinguishable in the log stream from NEW/RESUME

**What.** `src/sentinel/index.ts:3014` (ATTACH path) and `src/sentinel/index.ts:1113` (NEW/RESUME dispatch) both use the same `launchLog(...)` channel. Daemon-agent-host treats all three modes identically once running -- `boot_event` steps look the same. The only post-hoc way to tell what mode a daemon conv was launched in is to read `agentHostMeta.daemonMode` from the conversation.

**Why it matters.** Per the LOG EVERYTHING covenant, "source + initiator" must be on every log line. A future engineer staring at a daemon conversation's logs cannot tell whether the broker did `claude --bg`, `claude --bg --resume`, or attached to a worker someone else dispatched. This matters when diagnosing "the worker ignored my settings JSON" (ATTACH ignores config; NEW honors it) or "the worker has the wrong session" (RESUME forks vs. doesn't).

**Fix.** When the P0-2 `daemon_launch_event` lands, every step carries `daemonMode`. The log lines that emit it should also include the mode in the structured payload. Specifically:

- `src/sentinel/index.ts:1407` `launchLog`s for daemon ops should carry `daemonMode`.
- `src/daemon-agent-host/index.ts:299` (`emitBoot('init_received', ...)`) should include `daemonMode` and the relevant payload field per mode (`daemonResumeSessionId` for resume, `daemonAttachShort` for attach).

---

## P2 -- thin logs that violate LOG EVERYTHING

Required reading: the LOG EVERYTHING covenant box in `.claude/CLAUDE.md`. Each line below is a bare log that fails the "future you reconstructs the flap from `docker logs broker` alone" test.

| File:line | Current | Missing fields |
|---|---|---|
| `src/daemon-agent-host/index.ts:160` | `onDisconnected: () => debug('broker disconnected')` | prev state, last activity, liveSockets, reason |
| `src/daemon-agent-host/index.ts:161` | `onError: err => debug(\`transport error: ${err.message}\`)` | conversationId, ccSessionId, count, since-last-ok timer |
| `src/daemon-agent-host/index.ts:314` | `log(\`ccSessionId rotated -> ${nextSessionId.slice(0,8)} (/clear)\`)` | PREVIOUS ccSessionId, conversationId, rotationCount, transcriptPath before/after -- see P0-3 |
| `src/daemon-agent-host/index.ts:363,381,386` | `attach socket dropped: reason=...` | connectionId, attachId, ageMs since attach, attempt# |
| `src/daemon-agent-host/index.ts:430` | "not classified" classifyVanish log | conversationId |
| `src/sentinel/index.ts:1209` | `daemon-host exited normally: ...` | conversationId, daemonShort, statusBefore |
| `src/sentinel/index.ts:3014,3044` | `daemon attach target verified` | conversationId, `alive` from the `has` probe |
| `src/broker/backends/claude-daemon.ts:265` | `console.warn('[daemon-spawn] FAILED ...')` | jobId, statusCode, sentinel alias |
| `src/broker/handlers/daemon.ts:137` | `console.warn('[daemon-unend] ...')` | prev endedBy, prev lastActivity, age since end, lastSeen-in-roster -- this is the un-end flap path the covenant origin story is about |
| `src/broker/handlers/daemon.ts:279` | `daemon_roster_request` log | subscriber connId / role -- helps multi-dashboard diag |

Each fix is 1-3 lines. The `daemon-unend` one (`src/broker/handlers/daemon.ts:137`) is the highest priority of the P2 set -- it is exactly the class of flap the LOG EVERYTHING covenant exists to surface.

---

## P3 -- refactor opportunities (no bug, just debt)

### P3-1. Mirror `launch-events.ts` pattern in daemon-agent-host

Daemon-agent-host has no equivalent of `src/claude-agent-host/launch-events.ts` (the CLAUDE.md covenant reference pattern). The P0-2 fix should not just add wire emissions -- it should add a `src/daemon-agent-host/launch-events.ts` module with the same shape as the claude-agent-host one: emit helper, 500-entry buffer, replay-on-reconnect hook, `currentLaunchId` for distinguishing re-launches. Without this, even after P0-2 ships, late-connecting dashboards miss steps that happened before the WS handshake.

### P3-2. Multi-profile daemon roster watch (knowingly deferred)

`src/sentinel/daemon-roster.ts:36` comment: "watching multiple profile configDirs at once is deferred." Today the roster watcher only watches the sentinel's active CLAUDE_CONFIG_DIR. If sentinel runs under profile-X and a profile-Y daemon worker is also live on the same machine, that worker is invisible -- both to the roster forward and to the ATTACH browser.

Low priority until multi-profile is the default workflow; high impact when it is.

### P3-3. Stale plan version references

`plan-daemon-launch-ux.md`, `plan-daemon-followups.md`, and `docs/cc-daemon-socket-protocol.md` reference CC 2.1.143 / 2.1.144 / 2.1.145 as the verified versions. The running binary is 2.1.150. Update the doc footers to "verified on 2.1.150" and add a note about 2.1.147's "restart-in-place on update" feature -- not currently surfaced in our docs.

Worth a `git grep -n "2.1.14"` pass to find every stale version mention.

### P3-4. Cutover follow-ups still dated

`plan-daemon-launch-ux.md` Phase I status block (lines 1178-1192) lists three dated follow-ups: deploy, live-confirm-routing, and June-15 billing reclassification re-verify. Today is 2026-05-27; the June-15 gate is 19 days out. Track explicitly so the cutover flip doesn't happen on a stale assumption.

### P3-5. `permission_response` enum value in `DAEMON_CONTROL_OPS` is unreachable

`src/broker/handlers/daemon.ts:377` includes `'permission_response'` in the `DAEMON_CONTROL_OPS` set, but `daemon-control.ts:100-106` never produces a result with `op:'permission_response'`. Resolves with P1-2 -- delete or wire.

---

## Decision tree -- what to ship first

```
                             ┌─────────────────────────────────┐
                             │  PERMISSION UI BROKEN (P0-1)?   │
                             │  -> SHIP NOW                    │
                             │  Worktree: daemon-perm-relay   │
                             │  ~80 LOC, 1 day                 │
                             └─────────────────────────────────┘
                                            │
                                            ▼
                             ┌─────────────────────────────────┐
                             │  WIRE LAUNCH EVENTS (P0-2)      │
                             │  + /clear meta push (P0-3)      │
                             │  + launch-events.ts pattern     │
                             │  Worktree: daemon-launch-events│
                             │  ~250 LOC, 1-2 days             │
                             └─────────────────────────────────┘
                                            │
                                            ▼
                             ┌─────────────────────────────────┐
                             │  P1 logging passes + Section    │
                             │  11.4 wire messages             │
                             │  Surgical lane, each small      │
                             └─────────────────────────────────┘
                                            │
                                            ▼
                             ┌─────────────────────────────────┐
                             │  P2 / P3 housekeeping            │
                             │  Doc updates, dead-code purge   │
                             └─────────────────────────────────┘
```

---

## Files NOT touched in this sweep

These are areas that are either healthy (no findings) or genuinely out of scope:

- `web/src/components/spawn-dialog/daemon-mode-panel.tsx`, `daemon-roster-browser.tsx`, `daemon-launch.ts` -- clean, well-tested.
- `src/sentinel/daemon-dispatch.ts` -- pure functions, fully unit-tested.
- `src/shared/cc-daemon/socket-path.ts`, `frame.ts`, `types.ts` -- clean.
- `src/broker/__tests__/staging/daemon-e2e.test.ts` -- live NEW E2E proven against 2.1.144.
- `bin/daemon-host` -- harness only.

---

## Out of scope (explicitly)

- The `--fallback-model` plumbing gap (Section 11.2 B2) -- separate surgical ticket already noted.
- The `worktree.bgIsolation: 'none'` exposure (Section 11.3 B/T5) -- feature ticket, not a bug.
- Live driving the daemon to verify the P0-1 fix -- needs Jonas authorization (subscription billing, real worker).
- Cutover flip to `defaultBackend: 'daemon'` -- intentionally opt-in until P3-4's three gates clear.

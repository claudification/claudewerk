#!/usr/bin/env bun
/**
 * daemon-agent-host -- the agent host that ATTACHES to a Claude Code daemon
 * worker instead of spawning `claude` itself.
 *
 * The Claude Code 2.1.143+ supervisor daemon (`claude daemon`) hosts background
 * `claude` workers as PTY processes billed against the Anthropic subscription.
 * This host does not spawn a process: the sentinel has already dispatched a
 * `claude --bg` worker, and this host attaches to that worker's PTY over the
 * daemon control socket, mirroring it to the broker exactly like a normal
 * agent host. The broker cannot tell it apart from claude-agent-host.
 *
 * Because the daemon -- not claudewerk -- owns the worker process, claudewerk's
 * SessionStart hook never fires. The worker's `ccSessionId` is therefore
 * DERIVED, not observed via a hook: `session-observer.ts` reads it from the
 * daemon `list` op (the initial id) and from the project transcript directory
 * (a `/clear` rotation -- the daemon's `JobRecord.sessionId` never rotates).
 *
 * Lifecycle:
 *   1. parseDaemonHostConfig()      -- env -> config (mode: new|resume|attach)
 *   2. resolveControlSocket()       -- locate the daemon control.sock
 *   3. createHostTransport()        -- connect to the broker, emit boot events
 *   4. observeDaemonSession()       -- derive the worker's ccSessionId
 *   5. first ccSessionId            -- attachWithRetry the PTY, wire the bridges
 *   6. ccSessionId rotates (/clear) -- conversation_reset, re-point transcript
 *   7. attach socket drops          -- probe `has`; re-attach if the worker lives
 *   8. worker gone / SIGTERM        -- close everything, exit
 *
 * The transcript watch, dialect translation and broker transport are reused
 * verbatim from claude-agent-host -- the daemon worker IS `claude`, so its
 * transcript JSONL and tool vocabulary are identical. This host only replaces
 * the front end (attach instead of spawn). See
 * `.claude/docs/plan-claude-agents-integration.md` section 6.1.
 *
 * Env vars (set by the sentinel's `spawnDaemonHostDirect`):
 *   CLAUDWERK_BROKER / RCLAUDE_BROKER   ws://broker
 *   CLAUDWERK_SECRET / RCLAUDE_SECRET   broker auth token
 *   RCLAUDE_CONVERSATION_ID             stable conversation id (broker key)
 *   CLAUDWERK_DAEMON_SHORT              the 8-hex daemon worker short id
 *   CLAUDWERK_DAEMON_MODE               new | resume | attach (default: new)
 *   CLAUDWERK_DAEMON_RESUME_SESSION     resume input id (mode=resume only)
 *   RCLAUDE_CWD                         worker cwd (transcript-path slug source)
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import type { AttachCloseReason, AttachHandle } from '../shared/cc-daemon/attach'
import { has } from '../shared/cc-daemon/ops'
import { resolveControlSocket } from '../shared/cc-daemon/socket-path'
import { createHostTransport, type HostTransport } from '../shared/host-transport'
import { permissionDecisionToText } from '../shared/permission-decision'
import { cwdToProjectUri } from '../shared/project-uri'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostBoot,
  type BootEvent,
  type BootStep,
  type BrokerMessage,
  type ControlDeliver,
  type ConversationEnd,
  type ConversationMeta,
  type ConversationReset,
  type DaemonControlResult,
  type DaemonSessionRetired,
  type EffortChanged,
  type PermissionResponse,
  type SendInput,
  type UpdateConversationMetadata,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { attachWithRetry } from './attach-retry'
import { type BrokerBridge, createBrokerBridge } from './broker-bridge'
import { type DaemonHostConfig, parseDaemonHostConfig } from './cli-args'
import { createDaemonControl } from './daemon-control'
import { createDaemonLaunchEvents, type DaemonLaunchEvents } from './launch-events'
import { classifyVanish, type DaemonSessionObserver, observeDaemonSession } from './session-observer'
import { createStatusMirror, type StatusMirror } from './status-mirror'
import { createTranscriptBridge, type TranscriptBridge } from './transcript-bridge'

const log = (msg: string) => process.stderr.write(`[daemon-host] ${msg}\n`)
const debugEnabled = !!process.env.DAEMON_HOST_DEBUG || !!process.env.RCLAUDE_DEBUG
const debug = debugEnabled ? log : () => {}

/** Initial PTY size used for the first attach -- the broker resizes us once a
 *  terminal viewer opens. A sane 80x24 default keeps the worker readable until
 *  then. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const HOST_VERSION = `daemon-host/${BUILD_VERSION.gitHashShort}`

/** Build the boot message sent on the first broker connect (no session id yet). */
function buildBoot(cfg: DaemonHostConfig): AgentHostBoot {
  return {
    type: 'agent_host_boot',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    conversationId: cfg.conversationId,
    project: cwdToProjectUri(cfg.cwd),
    capabilities: ['terminal', 'boot_stream'],
    claudeArgs: [],
    version: HOST_VERSION,
    buildTime: BUILD_VERSION.buildTime,
    agentHostType: 'daemon',
    startedAt: Date.now(),
  }
}

/** Build the meta message sent on a reconnect once the ccSessionId is known. */
function buildMeta(cfg: DaemonHostConfig, ccSessionId: string): ConversationMeta {
  return {
    type: 'meta',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    ccSessionId,
    conversationId: cfg.conversationId,
    project: cwdToProjectUri(cfg.cwd),
    startedAt: Date.now(),
    capabilities: ['terminal', 'boot_stream'],
    version: HOST_VERSION,
    buildTime: BUILD_VERSION.buildTime,
    agentHostType: 'daemon',
  }
}

async function main(): Promise<void> {
  const cfg = parseDaemonHostConfig()
  const resumeNote = cfg.resumeSessionId ? ` resumeFrom=${cfg.resumeSessionId.slice(0, 8)}` : ''
  log(
    `starting conv=${cfg.conversationId.slice(0, 8)} short=${cfg.daemonShort} mode=${cfg.mode}${resumeNote} ` +
      `cwd=${cfg.cwd} broker=${cfg.brokerUrl}`,
  )

  const controlSock = resolveControlSocket()
  if (!controlSock) {
    log('FATAL: no Claude Code daemon control socket found (daemon not running?)')
    process.exit(1)
  }
  debug(`control socket: ${controlSock}`)

  // --- mutable host state ----------------------------------------------------
  let ccSessionId: string | null = null
  let attachHandle: AttachHandle | null = null
  let bridge: BrokerBridge | null = null
  let transcriptBridge: TranscriptBridge | null = null
  let statusMirror: StatusMirror | null = null
  let observer: DaemonSessionObserver | null = null
  let shuttingDown = false
  /** True while a socket-drop re-attach is in flight -- guards re-entrancy. */
  let reattaching = false
  /** Lazily-built once transport exists -- the typed daemon launch timeline. */
  let launchEvents: DaemonLaunchEvents | null = null
  /** /clear ccSessionId rotations observed this process lifetime -- stamped on
   *  the structured rotation log so a flap is reconstructable from logs alone. */
  let ccRotationCount = 0
  /** Set when (a) reattachAfterDrop confirms the worker is gone, or (b) the
   *  observer's `onGone` fires -- guards the worker_gone launch event so it
   *  emits exactly once per process. */
  let workerGoneEmitted = false
  /** Transport error count + last-ok timer -- carried on the structured error
   *  log line so a flap is reconstructable from logs alone (LOG EVERYTHING). */
  let transportErrorCount = 0
  let lastTransportOkAt = Date.now()

  // --- broker transport (created up front so boot events have a channel) -----
  const transport: HostTransport = createHostTransport({
    brokerUrl: cfg.brokerUrl,
    brokerSecret: cfg.brokerSecret,
    conversationId: cfg.conversationId,
    hostVersion: HOST_VERSION,
    buildInitialMessage: () => (ccSessionId ? buildMeta(cfg, ccSessionId) : buildBoot(cfg)),
    onMessage: handleInbound,
    onConnected: () => {
      debug('broker connected')
      lastTransportOkAt = Date.now()
      emitBoot('broker_connected')
      // Replay buffered daemon launch events so a late-attaching dashboard
      // sees the full timeline (EVERYTHING IS A STRUCTURED MESSAGE +
      // LOG EVERYTHING -- the timeline is the user-facing audit trail).
      launchEvents?.replay()
    },
    onDisconnected: () =>
      log(
        `[transport] broker disconnected conv=${cfg.conversationId.slice(0, 8)} ` +
          `ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'} attached=${attachHandle && !attachHandle.closed} ` +
          `lastOkAgoMs=${Date.now() - lastTransportOkAt} shuttingDown=${shuttingDown}`,
      ),
    onError: err => {
      transportErrorCount += 1
      log(
        `[transport] error conv=${cfg.conversationId.slice(0, 8)} ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'} ` +
          `errCount=${transportErrorCount} lastOkAgoMs=${Date.now() - lastTransportOkAt} ` +
          `message="${err.message}"`,
      )
    },
    onDiag: (_kind, m, args) => debug(`diag: ${m} ${args ? JSON.stringify(args) : ''}`),
  })

  // --- typed daemon launch timeline ------------------------------------------
  // Mirrors src/claude-agent-host/launch-events.ts -- emit helper + 500-entry
  // replay buffer + replay-on-reconnect. ATTACH-mode launches inherit the
  // sentinel-emitted dispatch_requested / worker_dispatched (broker-persisted).
  launchEvents = createDaemonLaunchEvents({
    conversationId: cfg.conversationId,
    daemonMode: cfg.mode,
    short: cfg.daemonShort,
    transport,
    log,
  })

  // --- remote-control surface (reply / kill / respawn-stale) -----------------
  // Routes the broker's control verbs onto the cc-daemon control socket and
  // emits a DaemonControlResult for every op. `handleInbound` references this
  // before this line runs, but it is only ever CALLED after the WS connects,
  // by which point `daemonControl` is assigned.
  const daemonControl = createDaemonControl({
    controlSock,
    daemonShort: cfg.daemonShort,
    conversationId: cfg.conversationId,
    emit: result => transport.send(result),
    log,
  })

  /** Emit a structured boot-lifecycle event so the user sees host progress. */
  function emitBoot(step: BootStep, detail?: string): void {
    const ev: BootEvent = { type: 'boot_event', conversationId: cfg.conversationId, step, t: Date.now() }
    if (detail) ev.detail = detail
    transport.send(ev)
    debug(`boot_event: ${step}${detail ? ` (${detail})` : ''}`)
  }

  emitBoot('agent_host_started', HOST_VERSION)

  // --- inbound broker message routing ----------------------------------------
  /**
   * Route one inbound broker message. The remote-control verbs (Phase G) are
   * intercepted here and dispatched to the cc-daemon control socket; raw
   * terminal traffic falls through to the PTY bridge.
   *   `input`                  -> daemon `reply` (chat-box turn injection)
   *   `terminate_conversation` -> daemon `kill`, then host shutdown
   *   `daemon_respawn_stale`   -> daemon `respawn-stale`
   */
  /** Emit a daemon_control_result for a verb the daemon-agent-host handled itself. */
  function emitControlResult(op: DaemonControlResult['op'], ok: boolean, detail: string): void {
    transport.send({ type: 'daemon_control_result', conversationId: cfg.conversationId, op, ok, detail, t: Date.now() })
  }

  /** set_effort: live `/effort` is a no-op (spike 3a) -- record the level + warn. */
  function applySetEffort(level: string | undefined): void {
    if (!level) return
    const ev: EffortChanged = {
      type: 'effort_changed',
      conversationId: cfg.conversationId,
      level,
      appliedVia: 'next_dispatch',
      t: Date.now(),
    }
    transport.send(ev)
    emitControlResult(
      'set_effort',
      true,
      `effort recorded (${level}); applies on the next worker (re)spawn -- daemon workers read CLAUDE_CODE_EFFORT_LEVEL at process start, live /effort is a no-op`,
    )
    log(`[daemon-control] set_effort ${cfg.conversationId.slice(0, 8)} -> ${level} (recorded for next dispatch)`)
  }

  /** interrupt: Ctrl+C straight into the worker PTY through the attach handle. */
  function applyInterrupt(): void {
    if (attachHandle && !attachHandle.closed) {
      attachHandle.writeInput('\x03')
      emitControlResult('interrupt', true, 'Ctrl+C sent to the worker PTY')
    } else {
      emitControlResult('interrupt', false, 'no live attach handle to interrupt')
    }
  }

  /** set_model: switch the worker's model live via a /model reply (spike 3b). */
  function applySetModel(model: string | undefined): void {
    if (!model) return
    void daemonControl.setModel(model).catch((err: unknown) => log(`set_model: ${(err as Error).message}`))
  }

  /** Route a unified `control` verb onto the daemon control surface. */
  function handleControl(msg: ControlDeliver): void {
    if (msg.action === 'set_model') applySetModel(msg.model)
    else if (msg.action === 'set_effort') applySetEffort(msg.effort)
    else if (msg.action === 'interrupt') applyInterrupt()
    // set_permission_mode / clear / quit are not live-controllable on a daemon
    // worker (regression -- see daemon-mode docs). Surface it, do not pretend.
    else log(`[daemon-control] control action ${msg.action} not supported live on a daemon worker`)
  }

  function handleInbound(msg: BrokerMessage): void {
    const t = (msg as { type?: string }).type
    if (t === 'control') {
      handleControl(msg as ControlDeliver)
      return
    }
    if (t === 'terminate_conversation') {
      log('broker requested termination -- killing daemon worker')
      daemonControl
        .kill()
        .catch((err: unknown) => log(`kill op error: ${(err as Error).message}`))
        .finally(() => shutdown('dashboard-other', false))
      return
    }
    if (t === 'daemon_respawn_stale') {
      log('broker requested respawn-stale')
      void daemonControl
        .respawnStale()
        .catch((err: unknown) => log(`respawn-stale op error: ${(err as Error).message}`))
      return
    }
    if (t === 'input') {
      // The chat box submits a turn -- route to the daemon `reply` op rather
      // than typing raw bytes into the worker PTY (the raw web terminal still
      // uses `terminal_data` -> PTY below).
      const input = (msg as SendInput).input
      if (typeof input === 'string' && input.length > 0) {
        void daemonControl.reply(input).catch((err: unknown) => log(`reply op error: ${(err as Error).message}`))
      } else {
        debug('input message with empty/invalid input -- ignored')
      }
      return
    }
    if (t === 'permission_response') {
      // The control panel answered a tool-use permission gate. The daemon has
      // no typed permission-response op (2.1.150 stub); the verified path is
      // `reply()` with the numbered menu choice -- the worker resolves its own
      // active gate when it sees text on the rendezvous socket. Mapping lives
      // in src/shared/permission-decision.ts; see plan-daemon-launch-ux.md § 8.
      const resp = msg as PermissionResponse
      const text = permissionDecisionToText(resp.behavior)
      log(
        `[permission] response received behavior=${resp.behavior} -> reply='${text}' requestId=${resp.requestId.slice(0, 12)}`,
      )
      void daemonControl
        .reply(text)
        .catch((err: unknown) => log(`permission reply op error: ${(err as Error).message}`))
      return
    }
    if (t === 'transcript_request' || t === 'transcript_kick') {
      transcriptBridge?.resend().catch((err: unknown) => debug(`resend failed: ${(err as Error).message}`))
      return
    }
    // terminal_data / terminal_resize / terminal_attach / terminal_detach -> PTY
    bridge?.handleMessage(msg)
  }

  // --- ccSessionId observation (the no-hook derivation) ----------------------
  /**
   * Fired by the session observer on the first ccSessionId and on every
   * rotation (a `/clear` inside the worker mints a new CC session). The first
   * call bootstraps the attach + bridges; later calls re-point the transcript
   * watcher and tell the broker to wipe ephemeral state.
   */
  function onSessionId(nextSessionId: string): void {
    if (shuttingDown) return
    const prev = ccSessionId
    const isFirst = prev === null
    ccSessionId = nextSessionId
    transport.setSessionId(nextSessionId, 'stream_json')

    if (isFirst) {
      // ATTACH-mode tagging (P1-5): the init detail string carries the launch
      // mode + ccSessionId so log scrapes can distinguish ATTACH from NEW/RESUME
      // without joining against agentHostMeta. Wire/payload remains a string;
      // structured daemon_launch_event carries mode in payload.
      const resumeNote =
        cfg.mode === 'resume' && cfg.resumeSessionId
          ? ` resumeFrom=${cfg.resumeSessionId.slice(0, 8)}`
          : cfg.mode === 'attach'
            ? ` attachShort=${cfg.daemonShort}`
            : ''
      emitBoot('init_received', `mode=${cfg.mode} ccSessionId=${nextSessionId.slice(0, 8)}${resumeNote}`)
      bootstrap(nextSessionId).catch((err: unknown) => {
        log(`FATAL: bootstrap failed: ${(err as Error).message}`)
        emitBoot('boot_error', (err as Error).message)
        shutdown('cc-exit-crash', true)
      })
      return
    }

    // /clear rotated the session id -- the worker is the same PTY, only its
    // transcript file changed. Tell the broker to (a) wipe ephemeral state via
    // conversation_reset, then (b) update the opaque agentHostMeta with the
    // new ccSessionId so transcript-folder mapping + status logger see the
    // current id without waiting for the next reconnect (P0-3 sweep finding).
    ccRotationCount += 1
    log(
      `[ccSessionId-rotation] conv=${cfg.conversationId.slice(0, 8)} prev=${prev?.slice(0, 8) ?? '-'} ` +
        `next=${nextSessionId.slice(0, 8)} rotation=${ccRotationCount} trigger=/clear ` +
        `transcriptPath=${cfg.cwd}`,
    )
    const reset: ConversationReset = {
      type: 'conversation_reset',
      conversationId: cfg.conversationId,
      project: cwdToProjectUri(cfg.cwd),
    }
    transport.send(reset)
    // Push the new ccSessionId into agentHostMeta (opaque bag, boundary-clean
    // -- the broker never reads it back as a typed field). Mirrors the meta
    // update claude-agent-host does on the same rotation.
    const metaUpdate: UpdateConversationMetadata = {
      type: 'update_conversation_metadata',
      conversationId: cfg.conversationId,
      metadata: {
        ccSessionId: nextSessionId,
        prevCcSessionId: prev,
        rotationCount: ccRotationCount,
        rotatedAt: Date.now(),
      },
    }
    transport.send(metaUpdate)
    transcriptBridge
      ?.watch(nextSessionId, cfg.cwd)
      .catch((err: unknown) => debug(`re-watch failed: ${(err as Error).message}`))
  }

  /**
   * Open (or re-open) the attach socket to the daemon worker. `attachWithRetry`
   * absorbs the transient ESTARTING/ENOJOB boot race; on success the new handle
   * is recorded and handed to the bridge. Used by both first-time `bootstrap()`
   * and the socket-drop re-attach path.
   */
  async function doAttach(): Promise<AttachHandle> {
    launchEvents?.emit('attach_started', { detail: `short=${cfg.daemonShort} mode=${cfg.mode}` })
    const handle = await attachWithRetry(
      controlSock as string,
      cfg.daemonShort,
      {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        onData: pty => bridge?.feedPty(pty),
        onClose: handleAttachClose,
        onError: err => debug(`attach error: ${err.message}`),
      },
      {
        onRetry: (attempt, maxAttempts, code) => {
          emitBoot('awaiting_init', `attach retry ${attempt}/${maxAttempts} (${code ?? 'transient'})`)
          launchEvents?.emit('attach_retry', {
            detail: `${attempt}/${maxAttempts} ${code ?? 'transient'}`,
            raw: { attempt, maxAttempts, code },
          })
        },
      },
    )
    attachHandle = handle
    bridge?.setAttachHandle(handle)
    debug(`attached: short=${cfg.daemonShort} state=${handle.ack.state} via=${handle.ack.via}`)
    launchEvents?.emit('attached', {
      detail: `state=${handle.ack.state} via=${handle.ack.via}`,
      raw: { state: handle.ack.state, via: handle.ack.via },
    })
    return handle
  }

  /**
   * Attach socket closed. `client-closed` is our own shutdown -- ignore it.
   * Anything else: the socket dropped, but the WORKER may still be alive (a
   * daemon hiccup, a transient network blip). Probe `has` before deciding --
   * re-attach a live worker rather than ending the conversation.
   */
  function handleAttachClose(reason: AttachCloseReason): void {
    if (reason === 'client-closed' || shuttingDown || reattaching) return
    reattaching = true
    log(
      `[attach] socket dropped reason=${reason} short=${cfg.daemonShort} ` +
        `conv=${cfg.conversationId.slice(0, 8)} ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'} ` +
        `rotationCount=${ccRotationCount} -- probing worker liveness`,
    )
    emitBoot('awaiting_init', `attach lost (${reason}); probing worker`)
    launchEvents?.emit('attach_lost', { detail: `reason=${reason}`, raw: { reason } })
    reattachAfterDrop(reason)
      .catch((err: unknown) => {
        log(`re-attach failed: ${(err as Error).message}`)
        shutdown('daemon-job-gone', true)
      })
      .finally(() => {
        reattaching = false
      })
  }

  /** Probe the worker after an attach drop; re-attach if alive, else end. */
  async function reattachAfterDrop(reason: AttachCloseReason): Promise<void> {
    const probe = await has(controlSock as string, cfg.daemonShort)
    const alive = probe.ok === true && probe.alive === true
    const present = probe.ok === true && probe.present === true
    if (!alive || !present) {
      log(
        `[attach] worker gone after drop short=${cfg.daemonShort} conv=${cfg.conversationId.slice(0, 8)} ` +
          `alive=${alive} present=${present} probeOk=${probe.ok} reason=${reason} ` +
          `ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'}`,
      )
      emitWorkerGone({ reason: `attach-drop+probe alive=${alive} present=${present}`, source: reason })
      maybeEmitRetired()
      shutdown('daemon-job-gone', true)
      return
    }
    log(
      `[attach] worker still alive after drop -- re-attaching short=${cfg.daemonShort} ` +
        `conv=${cfg.conversationId.slice(0, 8)} reason=${reason} ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'}`,
    )
    await doAttach()
    launchEvents?.emit('reattached', { detail: `reason=${reason}`, raw: { reason } })
    emitBoot('conversation_ready', `re-attached after socket drop (${reason})`)
  }

  /** Single worker_gone emitter -- guards against double-emit when both the
   *  attach-drop probe AND the observer's onGone hook fire on the same vanish. */
  function emitWorkerGone(payload: { reason: string; source?: string }): void {
    if (workerGoneEmitted) return
    workerGoneEmitted = true
    launchEvents?.emit('worker_gone', { detail: payload.reason, raw: { ...payload } })
  }

  /** One-time setup after the worker's first ccSessionId is known. */
  async function bootstrap(firstSessionId: string): Promise<void> {
    const handle = await doAttach()
    bridge = createBrokerBridge({
      transport,
      attachHandle: handle,
      conversationId: cfg.conversationId,
      debug,
    })
    transcriptBridge = createTranscriptBridge({
      transport,
      onError: err => debug(`transcript error: ${err.message}`),
      debug: debugEnabled ? (m: string) => debug(`[tx] ${m}`) : undefined,
    })
    await transcriptBridge.watch(firstSessionId, cfg.cwd)
    // Mirror the worker's `subscribe` state stream to the broker as structured
    // status (transport-reframe Phase 7, uplift #12d). A second read-only
    // connection alongside the PTY attach -- best-effort, never fatal.
    statusMirror = createStatusMirror({
      controlSock: controlSock as string,
      daemonShort: cfg.daemonShort,
      conversationId: cfg.conversationId,
      send: msg => transport.send(msg),
      // Always-on logger (NOT debug-gated): a dead status mirror stops all status
      // flow for this conversation and must be visible in production logs
      // (LOG EVERYTHING). The mirror only logs lifecycle close/error, never
      // per-frame churn, so this does not spam.
      log,
    })
    emitBoot('conversation_ready')
  }

  /**
   * Worker vanished from the roster. Consult the observer's last observation:
   * a long-idle worker that disappears was retired by the daemon (a graceful
   * end-of-life), not crashed. Emit a typed `daemon_session_retired` BEFORE
   * the conversation_end so the broker has a structured reason for the end
   * (EVERYTHING IS A STRUCTURED MESSAGE -- no diag-only retirement events).
   */
  function maybeEmitRetired(): void {
    const verdict = classifyVanish(observer?.lastObservation() ?? null, Date.now())
    if (!verdict.retired) {
      log(
        `[vanish] not classified as retired conv=${cfg.conversationId.slice(0, 8)} ` +
          `short=${cfg.daemonShort} lastState=${verdict.lastState ?? '(never seen)'} idleMs=${verdict.idleMs ?? 0} ` +
          `ccSessionId=${ccSessionId?.slice(0, 8) ?? '-'}`,
      )
      return
    }
    const event: DaemonSessionRetired = {
      type: 'daemon_session_retired',
      conversationId: cfg.conversationId,
      short: cfg.daemonShort,
      ccSessionId,
      lastState: verdict.lastState,
      idleMs: verdict.idleMs,
      retiredAt: Date.now(),
    }
    log(
      `worker retired by daemon -- short=${cfg.daemonShort} ccSessionId=${ccSessionId ?? '-'}` +
        ` lastState=${verdict.lastState} idleMs=${verdict.idleMs}`,
    )
    transport.send(event)
  }

  emitBoot('awaiting_init')
  observer = observeDaemonSession({
    controlSock,
    daemonShort: cfg.daemonShort,
    mode: cfg.mode,
    cwd: cfg.cwd,
    onSessionId,
    onGone: () => {
      if (!shuttingDown) {
        log('worker no longer in daemon roster')
        emitWorkerGone({ reason: 'observer:onGone -- worker left the daemon roster', source: 'observer' })
        maybeEmitRetired()
        shutdown('daemon-job-gone', true)
      }
    },
    onError: err => debug(`observer error: ${err.message}`),
  })

  // --- shutdown --------------------------------------------------------------
  /**
   * Tear everything down. `emitEnd` controls whether a `ConversationEnd` wire
   * message is sent: true when the WORKER itself terminated (a genuine
   * conversation end), false when our own process is being reaped (SIGTERM /
   * broker terminate) -- the broker handles those via the WS close.
   */
  function shutdown(source: ConversationEnd['source'], emitEnd: boolean): void {
    if (shuttingDown) return
    shuttingDown = true
    log(`shutdown: ${source}`)
    if (emitEnd) {
      emitBoot('claude_exited', source)
      const end: ConversationEnd = {
        type: 'end',
        conversationId: cfg.conversationId,
        reason: `daemon worker ended: ${source}`,
        endedAt: Date.now(),
      }
      if (source) end.source = source
      transport.send(end)
    }
    observer?.stop()
    bridge?.stop()
    transcriptBridge?.stop()
    statusMirror?.stop()
    attachHandle?.close()
    transport.flush()
    setTimeout(() => {
      transport.close()
      process.exit(0)
    }, 200)
  }

  process.on('SIGINT', () => shutdown('sentinel-kill', false))
  process.on('SIGTERM', () => shutdown('sentinel-kill', false))
}

main().catch(err => {
  log(`FATAL: ${(err as Error).stack ?? err}`)
  process.exit(1)
})

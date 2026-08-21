/**
 * Stream-JSON Backend (headless mode)
 * Spawns claude --print with NDJSON I/O instead of PTY.
 * Parses structured output and converts to TranscriptEntry format.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type { TranscriptEntry } from '../shared/protocol'
import { ensureSecureDir, writeSecureFileSync } from '../shared/secure-temp'
import { buildControlFailedEntry, controlDiagLine, type PendingControl } from './control-response'
import { debug as _debug } from './debug'
import { type HandlerContext, handleMessage } from './stream-handlers'
import { createMonitorTracker } from './stream-monitors'
import { createReplayBuffer, flushReplayBuffer } from './stream-replay'
import { syntheticUserUuid, userContentHash } from './synthetic-user-uuid'
import { type ParsedTurnSummary, TURN_SUMMARY_ENV } from './turn-summary'

const SHOW_PRETTY = !!process.env.RCLAUDE_SHOW_TRANSCRIPT_PRETTY
const SHOW_TRANSCRIPT = SHOW_PRETTY || !!process.env.RCLAUDE_SHOW_TRANSCRIPT

const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}

function colorizeJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${C.cyan}$1${C.reset}:`)
    .replace(/: "([^"]*?)"/g, `: ${C.green}$1${C.reset}`)
    .replace(/: (\d+\.?\d*)/g, `: ${C.yellow}$1${C.reset}`)
    .replace(/: (true|false|null)/g, `: ${C.magenta}$1${C.reset}`)
}

function transcriptLog(direction: '>>>' | '<<<', msg: Record<string, unknown>) {
  if (!SHOW_TRANSCRIPT) return
  const type = msg.type as string
  if (type === 'stream_event') return

  const arrow = direction === '>>>' ? `${C.cyan}>>>${C.reset}` : `${C.green}<<<${C.reset}`

  if (SHOW_PRETTY) {
    const json = JSON.stringify(msg, null, 2)
    process.stderr.write(`${arrow} ${colorizeJson(json)}\n`)
  } else {
    process.stderr.write(`${direction} ${JSON.stringify(msg)}\n`)
  }
}

const debug = (msg: string) => _debug(`[stream] ${msg}`)

export interface StreamBackendOptions {
  args: string[]
  settingsPath: string
  conversationId: string
  localServerPort: number
  brokerUrl?: string
  brokerSecret?: string
  cwd?: string
  env?: Record<string, string>
  includePartialMessages?: boolean
  syntheticUserUuids?: Map<string, string>
  onTranscriptEntries?: (entries: TranscriptEntry[], isInitial: boolean) => void
  onInit?: (init: StreamInitMessage) => void
  onResult?: (result: StreamResultMessage) => void
  onPermissionRequest?: (request: StreamPermissionRequest) => void
  onStreamEvent?: (event: Record<string, unknown>) => void
  onRateLimitStatus?: (info: {
    status: 'limited' | 'allowed'
    retryAfterMs?: number
    rateLimitType?: string
    resetsAt?: number
    utilization?: number
    raw: Record<string, unknown>
  }) => void
  onTaskStarted?: (task: { taskId: string; toolUseId: string; taskType: string; description: string }) => void
  onSubagentEntry?: (agentId: string, entry: TranscriptEntry) => void
  onMonitorUpdate?: (monitor: {
    taskId: string
    toolUseId: string
    description: string
    command?: string
    persistent?: boolean
    timeoutMs?: number
    status: 'running' | 'completed' | 'timed_out' | 'failed'
    eventCount: number
    outputPath?: string
  }) => void
  onScheduledTaskFire?: (content: string) => void
  /** The CURRENT full set of running background tasks (a snapshot, not a delta).
   *  CC emits this as `system/background_tasks_changed`; the host maps it to a
   *  neutral shape here so nothing CC-specific crosses to the broker. Empty
   *  array = nothing running. */
  onBackgroundTasksChanged?: (
    tasks: Array<{ id: string; kind: 'shell' | 'agent' | string; description: string }>,
  ) => void
  /** Backend hit an auth failure on an inference call (CC: `system/api_retry`
   *  with `error_status: 401`). Drives the in-transcript "Authorize" hint.
   *  EPHEMERAL -- the receiver broadcasts, never persists; see
   *  ConversationAuthNeeded in src/shared/protocol.ts. */
  onAuthNeeded?: (info: { errorStatus: number; detail?: string }) => void
  onPlanModeChanged?: (planMode: boolean) => void
  onApiStatus?: (status: string) => void
  /** Backend emitted a thinking-progress ping (CC: `system/thinking_tokens`).
   *  EPHEMERAL -- the receiver MUST NOT persist these; see ThinkingProgress
   *  in src/shared/protocol.ts. */
  onThinkingProgress?: (sample: { tokens: number; delta?: number }) => void
  /** Backend pushed an updated `/` command-completion catalog (CC:
   *  `system/commands_changed`). `names` is the full slash-command set; the
   *  receiver refreshes conversation_info so the composer autocomplete stays
   *  live mid-session. */
  onCommandsChanged?: (names: string[]) => void
  /** Backend classified the turn it just finished (CC: `system/post_turn_summary`).
   *  Conversation STATE, not a transcript row: `detail` is a ~30-char label of
   *  what the agent is doing right now. Only fires when the spawn env opts in
   *  (see TURN_SUMMARY_ENV in ./turn-summary). */
  onTurnSummary?: (summary: ParsedTurnSummary) => void
  onJsonStreamLine?: (line: string) => void
  /** Host-level diagnostic sink (`ctx.diag`). The stream layer owns facts the
   *  host never sees -- control-response outcomes above all -- and LOG
   *  EVERYTHING means they reach the same NDJSON as the rest of the lifecycle. */
  onDiag?: (type: string, msg: string) => void
  onExit?: (code: number | null) => void
}

export interface StreamInitMessage {
  session_id: string
  cwd: string
  model: string
  tools: Array<{ name: string; type?: string }>
  mcp_servers?: Array<{ name: string; status?: string }>
  // CC 2.1.219+: --mcp-config entries skipped by config validation. Opaque shape.
  mcp_server_errors?: Array<{ name?: string; error?: string }>
  claude_code_version?: string
  permissionMode?: string
  [key: string]: unknown
}

export interface StreamResultMessage {
  subtype: string
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  usage?: Record<string, unknown>
  [key: string]: unknown
}

export interface StreamPermissionRequest {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  [key: string]: unknown
}

/** Result of a generic control_request round-trip (debug-control feature). */
export interface ControlRequestResult {
  ok: boolean
  /** CC's control_response subtype ('success' | 'error'). */
  subtype?: string
  /** Inner response payload on success (shape varies by command). */
  response?: unknown
  /** Error text on failure. */
  error?: string
  /** True when no response arrived before the timeout. */
  timedOut?: boolean
}

/** In-flight awaited control_requests: the verb (so the outcome can be diag'd
 *  with detail) plus the promise resolver, keyed by request_id. */
type ControlResolvers = Map<string, { subtype: string; resolve: (r: ControlRequestResult) => void }>

export interface StreamProcess {
  proc: Subprocess
  sendUserMessage: (text: string) => void
  sendPermissionResponse: (
    requestId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
    toolUseId?: string,
    denyMessage?: string,
  ) => void
  sendSetModel: (model: string) => void
  sendSetPermissionMode: (mode: string) => void
  sendUpdateEnv: (variables: Record<string, string>) => void
  sendSetEffort: (level: string) => void
  sendInterrupt: () => void
  /** Generic control_request poke (debug-control). Sends `{subtype, ...payload}`
   *  to CC and resolves with the control_response (success or error). */
  sendControlRequest: (
    subtype: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<ControlRequestResult>
  forwardStdin: () => void
  kill: (signal?: NodeJS.Signals) => void
  closeStdin: () => boolean
}

export function spawnStreamClaude(options: StreamBackendOptions): StreamProcess {
  const { onJsonStreamLine } = options

  const proc = spawnProcess(options)
  const diagLog = initDiagLog(options.cwd, options.conversationId, proc.pid)

  // Resolvers for generic debug control_requests, keyed by request_id.
  // Separate from pendingControlRequests (which drives set_model/perm-mode
  // transcript notices); this one returns the full response to the caller.
  const controlRequestResolvers: ControlResolvers = new Map()

  const hctx: HandlerContext = {
    monitors: createMonitorTracker(),
    replay: createReplayBuffer(),
    pendingControlRequests: new Map(),
    controlRequestResolvers,
    syntheticUserUuids: options.syntheticUserUuids,
    conversationId: options.conversationId,
    callbacks: {
      onTranscriptEntries: options.onTranscriptEntries,
      onInit: options.onInit,
      onResult: options.onResult,
      onPermissionRequest: options.onPermissionRequest,
      onStreamEvent: options.onStreamEvent,
      onRateLimitStatus: options.onRateLimitStatus,
      onTaskStarted: options.onTaskStarted,
      onSubagentEntry: options.onSubagentEntry,
      onMonitorUpdate: options.onMonitorUpdate,
      onScheduledTaskFire: options.onScheduledTaskFire,
      onBackgroundTasksChanged: options.onBackgroundTasksChanged,
      onAuthNeeded: options.onAuthNeeded,
      onPlanModeChanged: options.onPlanModeChanged,
      onApiStatus: options.onApiStatus,
      onThinkingProgress: options.onThinkingProgress,
      onCommandsChanged: options.onCommandsChanged,
      onTurnSummary: options.onTurnSummary,
      onDiag: options.onDiag,
    },
  }

  function processLine(line: string) {
    if (!line.trim()) return
    diagLog('>>>', line)
    onJsonStreamLine?.(line)
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      transcriptLog('>>>', msg)
      handleMessage(hctx, msg)
    } catch (err) {
      debug(`Failed to parse NDJSON line: ${err}`)
      diagLog('ERR', `parse: ${err}`)
    }
  }

  readStream(proc.stdout, processLine, hctx)
  readStderr(proc.stderr, diagLog)

  function writeStdin(json: Record<string, unknown>) {
    if (!proc.stdin) {
      debug('stdin not available')
      return
    }
    const line = JSON.stringify(json)
    diagLog('<<<', line)
    transcriptLog('<<<', json)
    proc.stdin.write(`${line}\n`)
    proc.stdin.flush()
  }

  return buildStreamProcess(proc, writeStdin, options, hctx.pendingControlRequests, controlRequestResolvers)
}

function spawnProcess(options: StreamBackendOptions) {
  const { args, settingsPath, conversationId, localServerPort, brokerUrl, brokerSecret, cwd, env, onExit } = options

  const filteredArgs = args.filter(
    (a, i, arr) =>
      a !== '--print' &&
      a !== '-p' &&
      !(a === '--output-format' || (i > 0 && arr[i - 1] === '--output-format')) &&
      !(a === '--input-format' || (i > 0 && arr[i - 1] === '--input-format')),
  )

  const claudeArgs = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // CC 2.1.145+ rejects --print + --output-format=stream-json without --verbose.
    '--verbose',
    ...(options.includePartialMessages !== false ? ['--include-partial-messages'] : []),
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--settings',
    settingsPath,
    ...filteredArgs,
  ]

  debug(`Spawning: claude ${claudeArgs.join(' ')}`)

  return Bun.spawn(['claude', ...claudeArgs], {
    cwd: cwd || process.cwd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Opt in to CC's own turn classifier so `post_turn_summary` reaches the
      // wire. Placed BEFORE ...env so an operator can still override or unset
      // it per-spawn. See ./turn-summary for the gate and its blast radius.
      ...TURN_SUMMARY_ENV,
      ...env,
      RCLAUDE_CONVERSATION_ID: conversationId,
      RCLAUDE_PORT: String(localServerPort),
      ...(brokerUrl ? { RCLAUDE_BROKER: brokerUrl } : {}),
      ...(brokerSecret ? { RCLAUDE_SECRET: brokerSecret } : {}),
      CLAUDE_CODE_TASK_LIST_ID: conversationId,
    },
    onExit(_proc, exitCode) {
      debug(`Process exited with code ${exitCode}`)
      onExit?.(exitCode)
    },
  })
}

function initDiagLog(
  cwd: string | undefined,
  conversationId: string,
  pid: number,
): (prefix: string, line: string) => void {
  // `.rclaude/settings/` holds transcript content -- keep it owner-only (0700)
  // and the log itself 0600.
  const diagPath = join(cwd || process.cwd(), '.rclaude', 'settings', `headless-${conversationId}.ndjsonl`)
  try {
    ensureSecureDir(join(cwd || process.cwd(), '.rclaude', 'settings'))
    writeSecureFileSync(diagPath, `# headless stream log - ${new Date().toISOString()}\n# pid=${pid}\n`)
    debug(`Diagnostic log: ${diagPath}`)
  } catch {
    debug('Failed to create diagnostic log')
  }

  return function diagLog(prefix: string, line: string) {
    try {
      appendFileSync(diagPath, `${prefix} ${line}\n`)
    } catch {
      // ignore write errors
    }
  }
}

async function readStream(
  stdout: ReadableStream<Uint8Array> | null,
  processLine: (line: string) => void,
  hctx: HandlerContext,
) {
  if (!stdout) return
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let lineBuf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      lineBuf += chunk
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() || ''
      for (const line of lines) {
        processLine(line)
      }
    }
    if (lineBuf.trim()) processLine(lineBuf)
    if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  } catch (err) {
    debug(`Stream read error: ${err}`)
  }
}

async function readStderr(stderr: ReadableStream<Uint8Array> | null, diagLog: (prefix: string, line: string) => void) {
  if (!stderr) return
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text.trim()) {
        debug(`stderr: ${text.trim()}`)
        diagLog('ERR', text.trim())
      }
    }
  } catch {
    // ignore
  }
}

let controlSeq = 0
function nextRequestId(prefix: string): string {
  return `${prefix}-${++controlSeq}`
}

/** How long a set_model / set_permission_mode may go unanswered before the host
 *  declares it lost. Generous -- CC answers these in milliseconds when it is
 *  alive, so anything past this is a hang, not slowness. */
const CONTROL_RESPONSE_TIMEOUT_MS = 15_000

/**
 * Arm the no-response watchdog for a control_request whose answer drives a
 * transcript notice. A request CC never answers used to sit in the pending map
 * forever and the user saw nothing -- the same silence as a refusal, one layer
 * further out. The handler deletes the pending entry when the response lands, so
 * a fired timer with nothing to delete is the definition of "no answer came".
 */
function armControlTimeout(
  id: string,
  pending: PendingControl,
  pendingControlRequests: Map<string, PendingControl>,
  options: StreamBackendOptions,
) {
  const timer = setTimeout(() => {
    if (!pendingControlRequests.delete(id)) return
    const reason = `no response from Claude Code after ${CONTROL_RESPONSE_TIMEOUT_MS / 1000}s`
    options.onDiag?.('conversation', `${controlDiagLine(id, pending, 'timeout')}: ${reason}`)
    debug(`control_request ${id} (${pending.subtype}) timed out`)
    options.onTranscriptEntries?.([buildControlFailedEntry(pending, reason) as TranscriptEntry], false)
  }, CONTROL_RESPONSE_TIMEOUT_MS)
  timer.unref?.()
}

function buildStreamProcess(
  proc: Subprocess<'pipe', 'pipe', 'pipe'>,
  writeStdin: (json: Record<string, unknown>) => void,
  options: StreamBackendOptions,
  pendingControlRequests: Map<string, { subtype: string; detail?: string }>,
  controlRequestResolvers: ControlResolvers,
): StreamProcess {
  return {
    proc,

    sendUserMessage(text: string) {
      const content = text
      debug(`Sending user message: ${text.slice(0, 80)}...`)
      writeStdin({
        type: 'user',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
      // Stash a deterministic UUID so the CC echo (which arrives later,
      // after the current turn finishes) produces the same UUID. The broker
      // deduplicates via INSERT OR IGNORE -- the synthetic (correct position)
      // wins, the CC echo (displaced) is dropped. The SAME derivation is
      // re-applied on the JSONL file-watcher path (transcript-manager) so a file
      // resend dedups even after this stash is consumed/cleared.
      const uuid = syntheticUserUuid(options.conversationId, content)
      options.syntheticUserUuids?.set(userContentHash(content), uuid)
      options.onTranscriptEntries?.(
        [
          {
            type: 'user',
            timestamp: new Date().toISOString(),
            message: { role: 'user', content },
            uuid,
          } as TranscriptEntry,
        ],
        false,
      )
    },

    sendPermissionResponse(
      requestId: string,
      allow: boolean,
      updatedInput?: Record<string, unknown>,
      toolUseId?: string,
      denyMessage?: string,
    ) {
      debug(`Permission response: ${requestId} -> ${allow ? 'allow' : 'deny'}`)
      writeStdin({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: allow
            ? { behavior: 'allow', updatedInput: updatedInput || {}, ...(toolUseId && { toolUseID: toolUseId }) }
            : {
                behavior: 'deny',
                // The deny message is surfaced to the agent (e.g. ExitPlanMode
                // rejection reason), so prefer the caller's text over the default.
                message: denyMessage?.trim() || 'Denied by user',
                ...(toolUseId && { toolUseID: toolUseId }),
              },
        },
      })
    },

    sendSetModel(model: string) {
      debug(`Setting model: ${model}`)
      const id = nextRequestId('mdl')
      const pending: PendingControl = { subtype: 'set_model', detail: model }
      pendingControlRequests.set(id, pending)
      armControlTimeout(id, pending, pendingControlRequests, options)
      writeStdin({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'set_model', model },
      })
    },

    sendSetPermissionMode(mode: string) {
      debug(`Setting permission mode: ${mode}`)
      const id = nextRequestId('perm')
      const pending: PendingControl = { subtype: 'set_permission_mode', detail: mode }
      pendingControlRequests.set(id, pending)
      armControlTimeout(id, pending, pendingControlRequests, options)
      writeStdin({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'set_permission_mode', mode },
      })
    },

    sendUpdateEnv(variables: Record<string, string>) {
      const keys = Object.keys(variables)
      if (keys.length === 0) return
      debug(`Updating env: ${keys.join(', ')}`)
      writeStdin({ type: 'update_environment_variables', variables })
    },

    sendSetEffort(level: string) {
      debug(`Setting effort: ${level}`)
      writeStdin({
        type: 'update_environment_variables',
        variables: { CLAUDE_CODE_EFFORT_LEVEL: level },
      })
    },

    sendInterrupt() {
      debug('Sending interrupt')
      // CC answers an interrupt with a real control_response (verified against
      // 2.1.238: `{subtype: "success", response: {still_queued: []}}`), so this
      // rides the same confirm/refuse/timeout path as every other verb rather
      // than being fire-and-hope.
      const id = nextRequestId('int')
      const pending: PendingControl = { subtype: 'interrupt' }
      pendingControlRequests.set(id, pending)
      armControlTimeout(id, pending, pendingControlRequests, options)
      writeStdin({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'interrupt' },
      })
    },

    sendControlRequest(subtype: string, payload: Record<string, unknown>, timeoutMs = 8000) {
      return new Promise<ControlRequestResult>(resolve => {
        const id = nextRequestId('dbg')
        let settled = false
        const finish = (r: ControlRequestResult) => {
          if (settled) return
          settled = true
          controlRequestResolvers.delete(id)
          resolve(r)
        }
        const timer = setTimeout(() => {
          // A timeout is the same silence as a refusal, one layer out -- diag
          // it here so the NDJSON records the verb that never came back.
          options.onDiag?.(
            'conversation',
            `${controlDiagLine(id, { subtype }, 'timeout')}: no response after ${timeoutMs}ms`,
          )
          finish({ ok: false, timedOut: true, error: `control_request ${subtype} timed out after ${timeoutMs}ms` })
        }, timeoutMs)
        controlRequestResolvers.set(id, {
          subtype,
          resolve: r => {
            clearTimeout(timer)
            finish(r)
          },
        })
        debug(`debug control_request: ${subtype} (${id})`)
        writeStdin({ type: 'control_request', request_id: id, request: { subtype, ...payload } })
      })
    },

    forwardStdin() {
      if (!process.stdin.isTTY) {
        debug('Forwarding parent stdin to claude stdin')
        process.stdin.on('data', (chunk: Buffer) => {
          if (proc.stdin) {
            proc.stdin.write(chunk.toString())
            proc.stdin.flush()
          }
        })
        process.stdin.on('end', () => {
          debug('Parent stdin closed')
        })
      }
    },

    kill(signal: NodeJS.Signals = 'SIGTERM') {
      proc.kill(signal)
    },

    closeStdin() {
      try {
        const stdin = proc.stdin
        if (stdin && typeof stdin !== 'number') {
          stdin.end()
          debug('[stream] CC stdin closed (EOF sent)')
          return true
        }
      } catch (e) {
        debug(`[stream] Failed to close stdin: ${e}`)
      }
      return false
    },
  }
}

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
import { debug as _debug } from './debug'
import { type HandlerContext, handleMessage } from './stream-handlers'
import { createMonitorTracker } from './stream-monitors'
import { createReplayBuffer, flushReplayBuffer } from './stream-replay'
import { syntheticUserUuid, userContentHash } from './synthetic-user-uuid'

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
  onJsonStreamLine?: (line: string) => void
  onExit?: (code: number | null) => void
}

export interface StreamInitMessage {
  session_id: string
  cwd: string
  model: string
  tools: Array<{ name: string; type?: string }>
  mcp_servers?: Array<{ name: string; status?: string }>
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

export interface StreamProcess {
  proc: Subprocess
  sendUserMessage: (text: string, opts?: { origin?: { kind: string; server: string } }) => void
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
  const controlRequestResolvers = new Map<string, (r: ControlRequestResult) => void>()

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

// Exported for unit tests (sendUserMessage attribution): the real caller is
// spawnStreamClaude, which needs a live subprocess.
export function buildStreamProcess(
  proc: Subprocess<'pipe', 'pipe', 'pipe'>,
  writeStdin: (json: Record<string, unknown>) => void,
  options: StreamBackendOptions,
  pendingControlRequests: Map<string, { subtype: string; detail?: string }>,
  controlRequestResolvers: Map<string, (r: ControlRequestResult) => void>,
): StreamProcess {
  return {
    proc,

    sendUserMessage(text: string, opts?: { origin?: { kind: string; server: string } }) {
      // The model always gets RAW text -- an injected-as-user message (e.g. the
      // voice orb relaying speech) must read as normal user input, never a
      // wrapper. Attribution rides on the transcript ENTRY only (opts.origin),
      // so it renders "from <server>" without changing what the model sees.
      const content = text
      debug(`Sending user message${opts?.origin ? ` (via ${opts.origin.server})` : ''}: ${text.slice(0, 80)}...`)
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
            ...(opts?.origin && { origin: opts.origin }),
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
      pendingControlRequests.set(id, { subtype: 'set_model', detail: model })
      writeStdin({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'set_model', model },
      })
    },

    sendSetPermissionMode(mode: string) {
      debug(`Setting permission mode: ${mode}`)
      const id = nextRequestId('perm')
      pendingControlRequests.set(id, { subtype: 'set_permission_mode', detail: mode })
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
      writeStdin({
        type: 'control_request',
        request_id: nextRequestId('int'),
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
        const timer = setTimeout(
          () => finish({ ok: false, timedOut: true, error: `control_request ${subtype} timed out` }),
          timeoutMs,
        )
        controlRequestResolvers.set(id, r => {
          clearTimeout(timer)
          finish(r)
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

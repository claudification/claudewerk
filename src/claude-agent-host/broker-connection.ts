/**
 * Broker Connection
 * Establishes and manages the WebSocket connection to the broker.
 * Houses all WS callback handlers and pending request/response state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PendingCallbacks } from '../agent-host-common/host-rpc'
import {
  deliverDialogEvent,
  isMcpChannelReady,
  keepaliveDialog,
  pushChannelMessage,
  resolveDialog,
  sendPermissionResponse,
} from '../agent-host-common/mcp-host/mcp-channel'
import {
  clearBrokerRpcPending,
  dispatchBrokerRpcResponse,
  setBrokerRpcSender,
} from '../agent-host-common/mcp-host/mcp-tools/lib/broker-rpc'
import type { DialogResult } from '../shared/dialog-schema'
import type {
  AgentHostMessage,
  InterConversationDelivery,
  RclaudePermissionConfig,
  SystemChannelDelivery,
} from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'
import { dispatchDebugControl } from './debug-dispatch'
import { executeControl } from './execute-control'
import { replayLaunchEvents } from './launch-events'
import { resolveAskRequest } from './local-server'
import { clearInteraction, replayInteractions } from './pending-interactions'
import type { RulesEngine } from './permission-rules'
import { getTerminalSize } from './pty-spawn'
import { readAndSendTasks, startTaskWatching } from './task-watcher'
import { resendTranscriptFromFile } from './transcript-manager'
import { createWsClient } from './ws-client'

export interface BrokerConnectionDeps {
  brokerUrl: string
  brokerSecret: string | undefined
  conversationId: string
  cwd: string
  configuredModel: string | undefined
  claudeArgs: string[]
  claudeVersion: string | undefined
  claudeAuth: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string } | undefined
  spinnerVerbs: string[] | undefined
  noTerminal: boolean
  headless: boolean
  channelEnabled: boolean
  isAdHoc: boolean
  adHocTaskId: string | undefined
  adHocWorktree: string | undefined
  permissionRules: RulesEngine
  /** Shared inter-conversation RPC registry -- the same instance the MCP
   *  callbacks register resolvers on. Inbound `*_result` handlers invoke them. */
  pending: PendingCallbacks
}

export function connectToBroker(ctx: AgentHostContext, deps: BrokerConnectionDeps, ccSessionId: string | null) {
  if (ctx.wsClient) return

  const pending = deps.pending

  const {
    brokerUrl,
    brokerSecret,
    conversationId,
    cwd,
    configuredModel,
    claudeArgs,
    claudeVersion,
    claudeAuth,
    spinnerVerbs,
    noTerminal,
    headless,
    channelEnabled,
    isAdHoc,
    adHocTaskId,
    adHocWorktree,
    permissionRules,
  } = deps

  const replEnabled = process.env.CLAUDE_CODE_REPL === 'true'
  const capabilities = [
    ...(!noTerminal ? ['terminal' as const] : []),
    ...(channelEnabled ? ['channel' as const] : []),
    ...(headless ? (['headless', 'json_stream'] as const) : []),
    ...(isAdHoc ? ['ad-hoc' as const] : []),
    ...(replEnabled ? ['repl' as const] : []),
    'boot_stream' as const,
    'config_rw' as const,
  ]

  let savedTerminalSize: { cols: number; rows: number } | null = null

  ctx.wsClient = createWsClient({
    brokerUrl,
    brokerSecret,
    ccSessionId,
    conversationId,
    cwd,
    configuredModel,
    args: claudeArgs,
    claudeVersion,
    claudeAuth,
    spinnerVerbs,
    autocompactPct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
      ? Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
      : undefined,
    maxBudgetUsd: process.env.RCLAUDE_MAX_BUDGET_USD ? Number(process.env.RCLAUDE_MAX_BUDGET_USD) : undefined,
    adHocTaskId,
    adHocWorktree,
    capabilities,
    initialBoot: ccSessionId
      ? undefined
      : {
          claudeArgs,
          title: process.env.CLAUDWERK_CONVERSATION_NAME || undefined,
          description: process.env.CLAUDWERK_CONVERSATION_DESCRIPTION || undefined,
        },
    onConnected() {
      if (ctx.wsClient) setBrokerRpcSender(msg => ctx.wsClient!.send(msg))
      handleConnected(ctx, deps, ccSessionId)
    },
    onDisconnected() {
      debug('Disconnected from broker')
      clearBrokerRpcPending('broker disconnected')
      setBrokerRpcSender(null)
    },
    onBrokerRpcResponse(msg) {
      dispatchBrokerRpcResponse(msg)
    },
    onError(error) {
      debug(`Broker error: ${error.message}`)
    },
    onInput(input, crDelay) {
      handleInput(ctx, deps, input, crDelay)
    },
    onTerminalInput(data) {
      if (ctx.ptyProcess) {
        ctx.ptyProcess.write(data)
      }
    },
    onTerminalAttach(cols, rows) {
      ctx.terminalAttached = true
      savedTerminalSize = getTerminalSize()
      debug(
        `Terminal attached (${cols}x${rows}), saved local size (${savedTerminalSize.cols}x${savedTerminalSize.rows})`,
      )
      if (ctx.ptyProcess) {
        ctx.ptyProcess.resize(Math.max(1, cols - 1), rows)
        setTimeout(() => {
          ctx.ptyProcess?.resize(cols, rows)
          setTimeout(() => ctx.ptyProcess?.redraw(), 100)
        }, 50)
      }
    },
    onTerminalDetach() {
      ctx.terminalAttached = false
      if (savedTerminalSize && ctx.ptyProcess) {
        ctx.ptyProcess.resize(savedTerminalSize.cols, savedTerminalSize.rows)
        debug(`Terminal detached, restored to ${savedTerminalSize.cols}x${savedTerminalSize.rows}`)
        savedTerminalSize = null
      } else {
        debug('Terminal detached')
      }
    },
    onJsonStreamAttach() {
      ctx.jsonStreamAttached = true
      debug(`JSON stream attached, sending ${ctx.jsonStreamBuffer.length} backfill lines`)
      if (ctx.wsClient?.isConnected() && ctx.jsonStreamBuffer.length > 0) {
        ctx.wsClient.sendJsonStreamData(ctx.jsonStreamBuffer.slice(-100), true)
      }
    },
    onJsonStreamDetach() {
      ctx.jsonStreamAttached = false
      debug('JSON stream detached')
    },
    onTerminalResize(cols, rows) {
      if (ctx.ptyProcess) {
        ctx.ptyProcess.resize(cols, rows)
      }
      debug(`Terminal resized to ${cols}x${rows}`)
    },
    onAck() {
      if (ctx.transcriptWatcher) {
        debug('Ack received, re-sending transcript')
        ctx.transcriptWatcher.resend().catch(err => debug(`Resend failed: ${err}`))
      }
      ctx.lastTasksJson = ''
      readAndSendTasks(ctx)
    },
    onConfigUpdated() {
      permissionRules.reload()
      ctx.diag('info', 'Permission rules reloaded (notify_config_updated)')
    },
    onConfigGet(requestId: string) {
      handleConfigGet(ctx, requestId, cwd)
    },
    onConfigSet(requestId: string, config: RclaudePermissionConfig) {
      handleConfigSet(ctx, requestId, config, cwd)
    },
    onTranscriptRequest() {
      resendTranscriptFromFile(ctx)
    },
    onTranscriptKick() {
      handleTranscriptKick(ctx)
    },
    onChannelConversationsList(conversations, self, issues) {
      pending.pendingListConversations?.(conversations, self, issues)
    },
    onChannelSendResult(result) {
      const resolver = pending.pendingSendResult
      if (resolver) resolver(result as Parameters<typeof resolver>[0])
    },
    onChannelReviveResult(result) {
      pending.pendingReviveResult?.(result)
    },
    onChannelRestartResult(result) {
      pending.pendingRestartResult?.(result)
    },
    onChannelSpawnResult(result) {
      const expected = pending.pendingSpawnRequestId
      if (result.requestId && expected && result.requestId !== expected) {
        ctx.diag(
          'channel',
          `Ignoring stale channel_spawn_result (expected=${expected.slice(0, 8)}, got=${result.requestId.slice(0, 8)})`,
        )
        return
      }
      pending.pendingSpawnResult?.(result)
    },
    onSpawnDiagnosticsResult(result) {
      if (!result.jobId) return
      const resolver = pending.pendingSpawnDiagnostics.get(result.jobId)
      if (!resolver) return
      pending.pendingSpawnDiagnostics.delete(result.jobId)
      resolver(result)
    },
    onLaunchJobEvent(event) {
      const jobId = typeof event.jobId === 'string' ? event.jobId : undefined
      if (!jobId) return
      pending.launchJobListeners.get(jobId)?.(event)
    },
    onChannelConfigureResult(result) {
      pending.pendingConfigureResult?.(result)
    },
    onChannelRenameResult(result) {
      pending.pendingRenameResult?.(result)
    },
    onConversationControlResult(result) {
      pending.pendingControlResult?.(result)
    },
    onChannelDeliver(delivery) {
      handleChannelDeliver(ctx, deps, delivery)
    },
    onSystemChannelDeliver(delivery) {
      handleSystemChannelDeliver(ctx, deps, delivery)
    },
    onChannelLinkRequest() {
      // Link requests are handled by the dashboard UI, not by Claude
    },
    onPermissionResponse(requestId: string, behavior: 'allow' | 'deny', toolUseId?: string) {
      handlePermissionResponse(ctx, deps, requestId, behavior, toolUseId)
    },
    onAskAnswer(toolUseId, answers, annotations, skip) {
      handleAskAnswer(ctx, deps, toolUseId, answers, annotations, skip)
    },
    onDialogResult(dialogId, result) {
      handleDialogResult(ctx, dialogId, result)
    },
    onDialogKeepalive(dialogId) {
      keepaliveDialog(dialogId)
    },
    onDialogEvent(event) {
      const delivered = deliverDialogEvent(event)
      ctx.diag(
        'dialog',
        delivered
          ? `Event delivered: ${event.dialogId.slice(0, 8)} handler=${event.handlerId} seq=${event.seq}`
          : `Event dropped (dialog not open): ${event.dialogId.slice(0, 8)}`,
      )
    },
    onPlanApprovalResponse(requestId, action, feedback, toolUseId) {
      handlePlanApproval(ctx, deps, requestId, action, feedback, toolUseId)
    },
    onRendezvousResult(message: Record<string, unknown>) {
      handleRendezvousResult(ctx, deps, message)
    },
    onPermissionRule(toolName: string, behavior: 'allow' | 'deny') {
      if (behavior === 'allow') {
        permissionRules.addConversationRule(toolName)
        ctx.diag('channel', `Auto-approve rule added: ${toolName}`)
      } else {
        permissionRules.removeConversationRule(toolName)
        ctx.diag('channel', `Auto-approve rule removed: ${toolName}`)
      }
    },
    onQuitConversation(source, initiator) {
      // `source` is the typed TerminationSource forwarded by the broker
      // (set by the web client at the originating callsite). `initiator`
      // is the auth principal that issued the kill, when available.
      const tag = source || 'dashboard-other'
      const detail = initiator ? `${tag} (initiator=${initiator})` : tag
      executeControl(ctx, 'quit', { source: detail })
    },
    onInterrupt() {
      executeControl(ctx, 'interrupt', { source: 'dashboard-interrupt' })
    },
    onDebugControlSend(req) {
      void dispatchDebugControl(ctx, req)
    },
    onControl(action, args) {
      const source = args.fromConversation
        ? `inter-conversation:${args.fromConversation.slice(0, 8)}`
        : 'control-channel'
      const ok = executeControl(ctx, action, {
        model: args.model,
        effort: args.effort,
        permissionMode: args.permissionMode,
        taskId: args.taskId,
        source,
      })
      if (!ok) ctx.diag('conversation', `Control ignored: ${action} (backend not ready or missing args)`)
    },
    onDiag(type, msg, args) {
      ctx.diag(type, msg, args)
    },
  })
}

function handleConnected(ctx: AgentHostContext, deps: BrokerConnectionDeps, ccSessionId: string | null) {
  ctx.diag('ws', 'Connected to broker', { ccSessionId: ccSessionId ?? 'boot' })
  ctx.flushDiag()
  if (ccSessionId) {
    for (const event of ctx.eventQueue) {
      ctx.wsClient?.sendHookEvent({ ...event, conversationId: deps.conversationId })
    }
    ctx.eventQueue.length = 0
  }
  if (ctx.pendingConversationName && ctx.wsClient) {
    ctx.wsClient.send({
      type: 'conversation_name',
      conversationId: ctx.claudeSessionId || deps.conversationId,
      name: ctx.pendingConversationName.name,
      userSet: ctx.pendingConversationName.userSet,
      description: ctx.pendingConversationName.description,
    } as AgentHostMessage)
    ctx.pendingConversationName = undefined
  }
  replayLaunchEvents(ctx)
  replayInteractions(ctx)
  startTaskWatching(ctx)
}

function handleInput(ctx: AgentHostContext, deps: BrokerConnectionDeps, input: string, crDelay?: number) {
  if (deps.headless) {
    if (!ctx.streamProc || !input) return
    const trimmed = input.trimEnd()

    // Exact-match slash commands (no argument).
    const exactCommands: Record<string, () => void> = {
      '/exit': () => executeControl(ctx, 'quit', { source: 'headless-input' }),
      '/quit': () => executeControl(ctx, 'quit', { source: 'headless-input' }),
      ':q': () => executeControl(ctx, 'quit', { source: 'headless-input' }),
      ':q!': () => executeControl(ctx, 'quit', { source: 'headless-input' }),
      '/clear': () => executeControl(ctx, 'clear', { source: 'headless-input' }),
      '/plan': () => executeControl(ctx, 'set_permission_mode', { permissionMode: 'plan', source: 'headless-input' }),
    }
    // Prefix slash commands that take a trailing argument (ignored when blank).
    const prefixCommands: Array<{ prefix: string; run: (arg: string) => void }> = [
      {
        prefix: '/model ',
        run: model => model && executeControl(ctx, 'set_model', { model, source: 'headless-input' }),
      },
      {
        prefix: '/effort ',
        run: effort => effort && executeControl(ctx, 'set_effort', { effort, source: 'headless-input' }),
      },
      {
        prefix: '/mode ',
        run: mode =>
          mode && executeControl(ctx, 'set_permission_mode', { permissionMode: mode, source: 'headless-input' }),
      },
    ]

    const exact = exactCommands[trimmed]
    if (exact) {
      exact()
      return
    }
    const prefixed = prefixCommands.find(c => trimmed.startsWith(c.prefix))
    if (prefixed) {
      prefixed.run(trimmed.slice(prefixed.prefix.length).trim())
      return
    }
    ctx.streamProc.sendUserMessage(input)
    return
  }

  if (!ctx.ptyProcess) return

  const isSlashCommand = input.trimStart().startsWith('/')

  if (deps.channelEnabled && isMcpChannelReady() && !isSlashCommand) {
    pushChannelMessage(input)
      .then(sent => {
        if (sent) {
          ctx.diag('channel', `Input via MCP (${input.length} chars)`)
        } else {
          ctx.diag('channel', 'MCP push failed, falling back to PTY')
          if (ctx.ptyProcess) {
            const trimmed = input.replace(/[\r\n]+$/, '')
            ctx.ptyProcess.write(trimmed)
            setTimeout(() => ctx.ptyProcess?.write('\r'), 150)
          }
        }
      })
      .catch(err => {
        debug(`pushChannelMessage error: ${err instanceof Error ? err.message : err}`)
      })
    return
  }

  writeToPty(ctx, input, crDelay)
}

function writeToPty(ctx: AgentHostContext, input: string, crDelay?: number) {
  if (!ctx.ptyProcess) return
  const trimmed = input.replace(/[\r\n]+$/, '')
  const lines = trimmed.split('\n')

  const singleCrDelay = crDelay ?? 150
  const singlePreDelay = crDelay != null ? Math.max(50, crDelay / 2) : 100
  const multiSettleBase = crDelay ?? 250

  if (lines.length === 1) {
    ctx.ptyProcess.write(trimmed)
    setTimeout(() => {
      ctx.ptyProcess?.write('\r')
      setTimeout(() => ctx.ptyProcess?.write('\r'), singleCrDelay)
    }, singlePreDelay)
  } else {
    const perLineDelay = Math.min(50, Math.max(20, lines.length > 50 ? 50 : 20))
    ctx.ptyProcess.write('\x1b[200~')
    lines.forEach((line, i) => {
      setTimeout(() => {
        if (!ctx.ptyProcess) return
        ctx.ptyProcess.write(i > 0 ? `\n${line}` : line)
        if (i === lines.length - 1) {
          const settleDelay = crDelay != null ? crDelay : Math.min(500, Math.max(100, lines.length * 2))
          setTimeout(() => {
            ctx.ptyProcess?.write('\x1b[201~')
            setTimeout(() => {
              ctx.ptyProcess?.write('\r')
              setTimeout(() => ctx.ptyProcess?.write('\r'), multiSettleBase)
            }, settleDelay)
          }, 50)
        }
      }, i * perLineDelay)
    })
  }
  debug(
    `Sent to PTY: ${lines.length} lines, ${trimmed.length} chars${crDelay != null ? ` (crDelay=${crDelay}ms)` : ''}`,
  )
}

function handleConfigGet(ctx: AgentHostContext, requestId: string, cwd: string) {
  const cfgPath = join(cwd, '.rclaude', 'rclaude.json')
  try {
    const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null
    ctx.wsClient?.send({
      type: 'rclaude_config_data',
      requestId,
      config: raw ? JSON.parse(raw) : null,
      path: cfgPath,
      cwd,
    } as unknown as AgentHostMessage)
  } catch {
    ctx.wsClient?.send({
      type: 'rclaude_config_data',
      requestId,
      config: null,
      path: cfgPath,
      cwd,
    } as unknown as AgentHostMessage)
  }
}

function handleConfigSet(ctx: AgentHostContext, requestId: string, config: RclaudePermissionConfig, cwd: string) {
  const cfgPath = join(cwd, '.rclaude', 'rclaude.json')
  try {
    const dir = join(cwd, '.rclaude')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const withSchema = {
      $schema: 'https://raw.githubusercontent.com/claudification/claudewerk/main/schemas/rclaude.schema.json',
      ...config,
    }
    writeFileSync(cfgPath, `${JSON.stringify(withSchema, null, 2)}\n`)
    ctx.wsClient?.send({ type: 'rclaude_config_ok', requestId, ok: true } as unknown as AgentHostMessage)
  } catch (err) {
    ctx.wsClient?.send({
      type: 'rclaude_config_ok',
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as unknown as AgentHostMessage)
  }
}

/**
 * Defensive nudge from the broker: it has hook events but no transcript.
 * Same handling for every transport now that they all share one watcher --
 * resend if it is running, wait the file out and start it if it is not.
 */
function handleTranscriptKick(ctx: AgentHostContext) {
  if (ctx.transcriptWatcher) {
    debug('Transcript kick received - resending from the running watcher')
    resendTranscriptFromFile(ctx)
    return
  }
  if (!ctx.parentTranscriptPath) {
    debug('Transcript kick received but no transcript path known')
    return
  }
  debug(`Transcript kick received - retrying watcher for: ${ctx.parentTranscriptPath}`)
  ctx.diag('info', 'Transcript kick - retrying watcher', { path: ctx.parentTranscriptPath })
  retryTranscriptWatcher(ctx, ctx.parentTranscriptPath).catch(err => {
    debug(`retryTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
  })
}

async function retryTranscriptWatcher(ctx: AgentHostContext, path: string) {
  let delay = 500
  const maxDelay = 10_000
  const maxTotal = 900_000
  let elapsed = 0
  while (elapsed < maxTotal) {
    if (existsSync(path)) {
      debug(`Transcript file found after kick: ${path}`)
      // Start AND deliver: a bare startTranscriptWatcher seeks to end in
      // headless and would send the broker nothing, which is the opposite of
      // what a kick is asking for.
      resendTranscriptFromFile(ctx)
      return
    }
    await new Promise(r => setTimeout(r, delay))
    elapsed += delay
    delay = Math.min(delay * 2, maxDelay)
  }
  ctx.diag('error', 'Transcript file still not found after kick', { path })
}

function handleChannelDeliver(ctx: AgentHostContext, deps: BrokerConnectionDeps, delivery: InterConversationDelivery) {
  // Default: an untrusted peer conversation. The voice orb overrides sender="orb"
  // + source="rclaude" so the message renders "from Orb" and counts as the user's
  // own input (act on it), not a peer's request.
  const sender = delivery.sender ?? 'conversation'
  const source = delivery.source
  if (deps.headless && ctx.streamProc) {
    const attrs = [
      ...(source ? [`source="${source}"`] : []),
      `sender="${sender}"`,
      `from_conversation="${delivery.fromConversation}"`,
      `from_project="${delivery.fromProject}"`,
      `intent="${delivery.intent}"`,
      ...(delivery.conversationId ? [`conversation_id="${delivery.conversationId}"`] : []),
    ].join(' ')
    const wrapped = `<channel ${attrs}>\n${delivery.message}\n</channel>`
    ctx.streamProc.sendUserMessage(wrapped)
    ctx.diag('headless', `Channel from ${delivery.fromConversation}: ${delivery.message.slice(0, 60)}`)
  } else if (deps.channelEnabled && isMcpChannelReady()) {
    const meta: Record<string, string> = {
      sender,
      from_conversation: delivery.fromConversation,
      from_project: delivery.fromProject,
      intent: delivery.intent,
    }
    if (source) meta.source = source
    if (delivery.conversationId) meta.conversation_id = delivery.conversationId
    if (delivery.context) meta.context = delivery.context
    pushChannelMessage(delivery.message, meta).catch(err => {
      debug(`pushChannelMessage (deliver) error: ${err instanceof Error ? err.message : err}`)
    })
    ctx.diag('channel', `Received from ${delivery.fromProject}: ${delivery.message.slice(0, 60)}`)
  }
}

/**
 * Deliver a broker-originated system notice (e.g. recap-completed). Formats
 * it as `<channel source="rclaude" sender="system" kind="...">` -- the shape
 * the web transcript parser recognises as a system channel message.
 */
// mirrors handleChannelDeliver's two transport branches
// fallow-ignore-next-line complexity
function handleSystemChannelDeliver(
  ctx: AgentHostContext,
  deps: BrokerConnectionDeps,
  delivery: SystemChannelDelivery,
) {
  if (deps.headless && ctx.streamProc) {
    const attrs = [
      `source="rclaude"`,
      `sender="system"`,
      `kind="${delivery.kind}"`,
      ...(delivery.recapId ? [`recap_id="${delivery.recapId}"`] : []),
    ].join(' ')
    const wrapped = `<channel ${attrs}>\n${delivery.text}\n</channel>`
    ctx.streamProc.sendUserMessage(wrapped)
    ctx.diag('headless', `System channel (${delivery.kind}): ${delivery.text.slice(0, 60)}`)
  } else if (deps.channelEnabled && isMcpChannelReady()) {
    const meta: Record<string, string> = { sender: 'system', kind: delivery.kind }
    if (delivery.recapId) meta.recap_id = delivery.recapId
    pushChannelMessage(delivery.text, meta).catch(err => {
      debug(`pushChannelMessage (system) error: ${err instanceof Error ? err.message : err}`)
    })
    ctx.diag('channel', `System channel (${delivery.kind}): ${delivery.text.slice(0, 60)}`)
  }
}

function handlePermissionResponse(
  ctx: AgentHostContext,
  deps: BrokerConnectionDeps,
  requestId: string,
  behavior: 'allow' | 'deny',
  toolUseId?: string,
) {
  clearInteraction(ctx, requestId)
  if (deps.headless && ctx.streamProc) {
    ctx.streamProc.sendPermissionResponse(requestId, behavior === 'allow', undefined, toolUseId)
    ctx.diag('headless', `Permission response: ${requestId} -> ${behavior}`)
  } else if (deps.channelEnabled && isMcpChannelReady()) {
    sendPermissionResponse(requestId, behavior).catch(err => {
      debug(`sendPermissionResponse error: ${err instanceof Error ? err.message : err}`)
    })
    ctx.diag('channel', `Permission response: ${requestId} -> ${behavior}`)
  }
}

function handleAskAnswer(
  ctx: AgentHostContext,
  deps: BrokerConnectionDeps,
  toolUseId: string,
  answers?: Record<string, string>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
  skip?: boolean,
) {
  clearInteraction(ctx, toolUseId)
  const pending = ctx.pendingAskRequests.get(toolUseId)
  if (pending && deps.headless && ctx.streamProc) {
    if (pending.timer) clearTimeout(pending.timer)
    ctx.pendingAskRequests.delete(toolUseId)
    if (skip || !answers) {
      ctx.streamProc.sendPermissionResponse(pending.requestId, false, undefined, toolUseId)
      ctx.diag('headless', `AskUserQuestion skipped: ${toolUseId.slice(0, 12)}`)
    } else {
      ctx.streamProc.sendPermissionResponse(
        pending.requestId,
        true,
        { questions: pending.questions, answers, ...(annotations && { annotations }) },
        toolUseId,
      )
      ctx.diag('headless', `AskUserQuestion answered: ${toolUseId.slice(0, 12)}`)
    }
    return
  }
  const resolved = resolveAskRequest(toolUseId, answers, annotations, skip)
  ctx.diag(
    'ask',
    resolved ? `Answer resolved: ${toolUseId.slice(0, 12)}` : `No pending request: ${toolUseId.slice(0, 12)}`,
  )
}

function handleDialogResult(ctx: AgentHostContext, dialogId: string, result: DialogResult) {
  clearInteraction(ctx, dialogId)
  const resolved = resolveDialog(dialogId, result)
  ctx.diag(
    'dialog',
    resolved
      ? `Result resolved: ${dialogId.slice(0, 8)} action=${result._action}`
      : `No pending dialog: ${dialogId.slice(0, 8)}`,
  )
}

function handlePlanApproval(
  ctx: AgentHostContext,
  deps: BrokerConnectionDeps,
  requestId: string,
  action: 'approve' | 'reject',
  feedback?: string,
  toolUseId?: string,
) {
  if (!deps.headless || !ctx.streamProc) return
  clearInteraction(ctx, requestId)

  const exitedPlanMode = action === 'approve'
  if (action === 'approve') {
    // CC ignores feedback when ExitPlanMode is allowed -- it just proceeds.
    ctx.streamProc.sendPermissionResponse(requestId, true, undefined, toolUseId)
    ctx.diag('plan', `Plan approved: ${requestId.slice(0, 8)}`)
  } else {
    // Reject: deny the ExitPlanMode permission and feed the user's reason back
    // to the agent as the deny message so it revises the plan. CC keeps plan mode.
    ctx.streamProc.sendPermissionResponse(requestId, false, undefined, toolUseId, feedback)
    ctx.diag('plan', `Plan rejected${feedback ? ' with feedback' : ''}: ${requestId.slice(0, 8)}`)
  }
  // Only emit plan_mode_changed:false on approve. On reject, CC stays
  // in plan mode -- emitting false would lie to the broker.
  if (exitedPlanMode) {
    // Arm the stale-status suppressor. CC may still emit `system/status`
    // messages carrying `permissionMode: 'plan'` for a brief window after the
    // approval (queued in CC's stdout before its internal mode flipped).
    // onPlanModeChanged consults this to drop those false-positives.
    ctx.planExitApprovedAt = Date.now()
    if (ctx.wsClient?.isConnected()) {
      ctx.wsClient.send({
        type: 'plan_mode_changed',
        conversationId: ctx.conversationId,
        planMode: false,
      } as unknown as AgentHostMessage)
    }
  }
}

function handleRendezvousResult(ctx: AgentHostContext, deps: BrokerConnectionDeps, message: Record<string, unknown>) {
  const msgType = message.type as string
  const ccSessionId = message.ccSessionId as string | undefined
  const cwd = message.cwd as string | undefined
  const error = message.error as string | undefined
  const isReady = msgType === 'spawn_ready' || msgType === 'revive_ready' || msgType === 'restart_ready'
  const action = msgType.startsWith('spawn') ? 'spawn' : msgType.startsWith('restart') ? 'restart' : 'revive'

  if (isReady) {
    ctx.diag('rendezvous', `${action} ready: session=${ccSessionId?.slice(0, 8)} cwd=${cwd}`)
  } else {
    ctx.diag('rendezvous', `${action} timeout: ${error || 'unknown'}`)
  }

  const rendezvous = deps.pending.pendingRendezvous.get(message.conversationId as string)
  if (rendezvous) {
    deps.pending.pendingRendezvous.delete(message.conversationId as string)
    if (isReady) {
      rendezvous.resolve(message)
    } else {
      rendezvous.reject(error || `${action} timed out`)
    }
  }

  if (deps.channelEnabled && isMcpChannelReady()) {
    const text = isReady
      ? `Session ${action === 'spawn' ? 'spawned' : 'revived'}: ${cwd?.split('/').pop() || ccSessionId?.slice(0, 8)} (${ccSessionId?.slice(0, 8)})`
      : `Session ${action} timed out: ${error || 'no response within timeout'}`
    pushChannelMessage(text, {
      sender: 'system',
      [`${action}_result`]: isReady ? 'ready' : 'timeout',
      ...(ccSessionId ? { target_session: ccSessionId } : {}),
    }).catch(() => {})
  }
}

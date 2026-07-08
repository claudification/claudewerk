/**
 * Control Verb Dispatcher
 * Executes high-level control verbs (clear, quit, interrupt, set_model, etc.)
 * against the local CC process. Backend-specific: headless uses typed methods,
 * PTY writes raw slash commands into CC's CLI input layer.
 */

import { canonicalizeModelSlug } from '../shared/models'
import type { AgentHostContext } from './agent-host-context'
import { beginLaunch, emitLaunchEvent } from './launch-events'

type ControlArgs = { model?: string; effort?: string; permissionMode?: string; taskId?: string; source?: string }

type ControlAction =
  | 'clear'
  | 'quit'
  | 'interrupt'
  | 'set_model'
  | 'set_effort'
  | 'set_permission_mode'
  | 'cancel_background_task'

/**
 * Expand claudewerk-only model aliases (e.g. `mythos` -> claude-mythos-5) before
 * either backend writes the slug to CC, which doesn't resolve them. Only
 * set_model carries a model; every other action passes through untouched.
 */
function canonicalizeControlArgs(action: string, args: ControlArgs): ControlArgs {
  if (action !== 'set_model' || !args.model) return args
  return { ...args, model: canonicalizeModelSlug(args.model) }
}

/**
 * Execute a control action against the local CC process.
 * Shared entry point for dashboard input, control buttons, and inter-session MCP.
 */
export function executeControl(ctx: AgentHostContext, action: ControlAction, args: ControlArgs = {}): boolean {
  const source = args.source || 'unknown'
  const resolved = canonicalizeControlArgs(action, args)
  if (ctx.headless) {
    return executeHeadlessControl(ctx, action, resolved, source)
  }
  return executePtyControl(ctx, action, resolved, source)
}

function executeHeadlessControl(
  ctx: AgentHostContext,
  action: string,
  args: { model?: string; effort?: string; permissionMode?: string; taskId?: string },
  source: string,
): boolean {
  if (!ctx.streamProc) return false
  switch (action) {
    case 'clear':
      ctx.diag('conversation', `Clear requested (${source}) - killing CC and respawning fresh`)
      beginLaunch(ctx, 'reboot')
      emitLaunchEvent(ctx, 'clear_requested', { detail: source })
      ctx.streamProc.kill()
      ctx.clearRequested = true
      return true
    case 'quit': {
      ctx.diag('conversation', `Quit requested (${source}) - closing stdin for graceful shutdown`)
      const closed = ctx.streamProc.closeStdin()
      if (closed) {
        const proc = ctx.streamProc
        setTimeout(() => {
          if (!proc.proc.killed) {
            ctx.diag('conversation', 'CC still alive 10s after stdin close - sending SIGTERM')
            proc.kill()
          }
        }, 10_000)
      } else {
        ctx.diag('conversation', 'Stdin close failed - falling back to SIGTERM')
        ctx.streamProc.kill()
      }
      return true
    }
    case 'interrupt':
      ctx.diag('conversation', `Interrupt requested (${source})`)
      ctx.streamProc.sendInterrupt()
      return true
    case 'set_model':
      if (!args.model) return false
      ctx.diag('conversation', `Set model requested (${source}): ${args.model}`)
      ctx.streamProc.sendSetModel(args.model)
      return true
    case 'set_effort':
      if (!args.effort) return false
      ctx.diag('conversation', `Set effort requested (${source}): ${args.effort}`)
      ctx.streamProc.sendSetEffort(args.effort)
      return true
    case 'set_permission_mode':
      if (!args.permissionMode) return false
      ctx.diag('conversation', `Set permission mode requested (${source}): ${args.permissionMode}`)
      ctx.streamProc.sendSetPermissionMode(args.permissionMode)
      return true
    case 'cancel_background_task': {
      if (!args.taskId) return false
      const taskId = args.taskId
      ctx.diag('conversation', `Cancel background task requested (${source}): ${taskId.slice(0, 8)}`)
      // Translate the neutral cancel to CC's `stop_task` control_request. This
      // is the ONE place CC specifics are allowed. Fire-and-forget; the running
      // snapshot the host emits will reflect the task leaving the set.
      void ctx.streamProc.sendControlRequest('stop_task', { task_id: taskId }).then(r => {
        if (!r.ok) ctx.diag('conversation', `stop_task ${taskId.slice(0, 8)} failed: ${r.error ?? 'unknown'}`)
      })
      return true
    }
    default:
      return false
  }
}

function executePtyControl(
  ctx: AgentHostContext,
  action: string,
  args: { model?: string; effort?: string; permissionMode?: string; taskId?: string },
  source: string,
): boolean {
  if (!ctx.ptyProcess) return false
  switch (action) {
    case 'clear':
      ctx.diag('conversation', `Clear requested (${source}) - injecting /clear via PTY`)
      beginLaunch(ctx, 'reboot')
      emitLaunchEvent(ctx, 'clear_requested', { detail: `${source} (pty)` })
      ctx.ptyProcess.write('/clear\r')
      return true
    case 'quit':
      ctx.diag('conversation', `Quit requested (${source}) - sending SIGTERM to PTY`)
      ctx.ptyProcess.kill('SIGTERM')
      return true
    case 'interrupt':
      ctx.diag('conversation', `Interrupt requested (${source}) - sending Ctrl+C to PTY`)
      ctx.ptyProcess.write('\x03')
      return true
    case 'set_model':
      if (!args.model) return false
      ctx.diag('conversation', `Set model requested (${source}): ${args.model}`)
      ctx.ptyProcess.write(`/model ${args.model}\r`)
      return true
    case 'set_effort':
      if (!args.effort) return false
      ctx.diag('conversation', `Set effort requested (${source}): ${args.effort}`)
      ctx.ptyProcess.write(`/effort ${args.effort}\r`)
      return true
    case 'set_permission_mode':
      if (!args.permissionMode) return false
      ctx.diag('conversation', `Set permission mode not supported in PTY mode (${source}): ${args.permissionMode}`)
      return false
    case 'cancel_background_task':
      // Background tasks are a headless/stream-json feature; a PTY session has
      // no control_request channel to stop one. No-op.
      ctx.diag('conversation', `Cancel background task not supported in PTY mode (${source})`)
      return false
    default:
      return false
  }
}

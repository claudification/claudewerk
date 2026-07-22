/**
 * Hook Processor
 * Handles all hook events from Claude Code (SessionStart, SubagentStart/Stop, etc.)
 * and dispatches to the appropriate state updates, watchers, and broker forwarding.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug as _debug } from './debug'
import { forwardOrQueueHookEvent } from './hook-forward'
import { emitLaunchEvent } from './launch-events'
import { observeClaudeSessionId } from './session-transition'
import { computeStatusNudge, type HookDecision, trackStatusTurn } from './status-nudge'
import {
  startSubagentWatcher,
  startTranscriptWatcher as startTranscriptWatcherFn,
  stopSubagentWatcher,
} from './transcript-manager'
import { emitCwdChanged } from './worktree-detect'

const debug = (msg: string) => _debug(msg)

// THE STATUS nudge (HookDecision type + the per-turn counters + the nudge
// decision) lives in ./status-nudge. Re-export the type so existing importers
// (local-server.ts) are undisturbed.
export type { HookDecision }

/**
 * Process a hook event from Claude Code.
 * Handles SessionStart (session ID extraction, transcript watcher setup),
 * SubagentStart/Stop (subagent watcher lifecycle), and event forwarding/queuing.
 * Returns a Stop-hook decision when the agent should be nudged (else undefined).
 */
export function processHookEvent(ctx: AgentHostContext, event: HookEvent): HookDecision | undefined {
  // THE STATUS per-turn bookkeeping for the Stop-hook nudge (see ./status-nudge).
  trackStatusTurn(ctx, event)
  // Extract Claude's real session ID from SessionStart
  if (event.hookEvent === 'SessionStart' && event.data) {
    const data = event.data as Record<string, unknown>
    debug(
      `SessionStart data keys: ${Object.keys(data).join(', ')} | source=${data.source} | session_id=${String(data.session_id).slice(0, 8)}`,
    )
    if (data.session_id && typeof data.session_id === 'string') {
      const newSessionId = data.session_id
      const newModel = typeof data.model === 'string' ? data.model : undefined

      // Emit init_received BEFORE observeClaudeSessionId if we don't already
      // have this session id on ctx (i.e. stream-json onInit didn't beat us).
      // Headless onInit carries richer data and emits its own init_received,
      // so we only fire here for cases where the hook is the first/only
      // signal (PTY mode, or --bare mode never happens since hooks are off
      // there). Duplicate init_received for the same id from both paths is
      // acceptable diagnostic noise.
      if (ctx.claudeSessionId !== newSessionId) {
        emitLaunchEvent(ctx, 'init_received', {
          detail: `session=${newSessionId.slice(0, 8)} model=${newModel || '?'} (hook)`,
          raw: {
            session_id: newSessionId,
            model: newModel,
            source: data.source,
            transcript_path: data.transcript_path,
          },
        })
      }

      // Single entry point: observeClaudeSessionId classifies this as
      // boot / rekey / confirm and performs the right broker action.
      // Safe to call redundantly -- stream-json onInit calls it too; whoever
      // fires first does the work.
      observeClaudeSessionId(ctx, newSessionId, 'hook', newModel)

      // Start/re-point the transcript watcher when the path is available. The
      // decision keys on the FILE, not on the session transition -- see below.
      if (data.transcript_path && typeof data.transcript_path === 'string') {
        const transcriptPath = data.transcript_path
        ctx.parentTranscriptPath = transcriptPath
        // Start watcher if transcript file exists, or retry until it does
        // Brand new projects can take 60-90s before Claude creates the JSONL file.
        // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 10s, ~2.5 min total
        async function tryStartTranscriptWatcher(path: string) {
          // Headless watches too, for the entries CC writes ONLY to the file
          // (queue-operation). It seeks to end and forwards a narrow slice --
          // see transcript-entry-filter.ts -- so it cannot duplicate what the
          // stdout stream already delivered.
          let delay = 500
          const maxDelay = 10_000
          const maxTotal = 900_000 // 15 minutes total (slow-starting sessions can take 6+ min)
          let elapsed = 0
          let attempt = 0
          while (elapsed < maxTotal) {
            if (existsSync(path)) {
              // Restart only when the FILE actually changed (/clear and
              // compaction mint a new JSONL), never merely because the session
              // id did. A same-file restart is pointless for PTY and harmful in
              // headless: the fresh watcher seeks to end again, so anything
              // appended between stop() and the new seek is lost. `boot` fires
              // here right after onInit already started the watcher on this
              // very path, so that redundant restart was the common case.
              if (ctx.transcriptWatcher && ctx.transcriptWatcher.getPath() === path) {
                debug(`Transcript watcher already running for this file: ${path}`)
                return
              }
              if (ctx.transcriptWatcher) {
                debug(`Stopping old transcript watcher (file changed: ${ctx.transcriptWatcher.getPath()} -> ${path})`)
                ctx.transcriptWatcher.stop()
                ctx.transcriptWatcher = null
              }
              debug(`Starting transcript watcher: ${path}`)
              startTranscriptWatcherFn(ctx, path)
              return
            }
            attempt++
            debug(
              `Transcript file not found (attempt ${attempt}, ${(elapsed / 1000).toFixed(1)}s elapsed), retrying in ${delay}ms: ${path}`,
            )
            await new Promise(r => setTimeout(r, delay))
            elapsed += delay
            delay = Math.min(delay * 2, maxDelay)
          }
          ctx.diag('error', 'Transcript file never appeared', {
            path,
            elapsed: `${(elapsed / 1000).toFixed(0)}s`,
            attempts: attempt,
          })
        }
        tryStartTranscriptWatcher(transcriptPath).catch(err => {
          debug(`tryStartTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
        })
      } else {
        debug('WARNING: No transcript_path in SessionStart data!')
      }
    }
  }

  // Start live watching subagent transcripts at SubagentStart
  if (event.hookEvent === 'SubagentStart' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    // Track the live subagent roster. Attribution does NOT read this (it comes
    // off the hook's own agent_id); this is purely the live count below.
    if (agentId) {
      ctx.runningSubagents.add(agentId)
      // Report the new live count -- gates the broker's parent-notify settle.
      ctx.wsClient?.sendBackgroundActivity(ctx.runningSubagents.size)
    }
    if (agentId && ctx.parentTranscriptPath) {
      // Derive subagent transcript path: {sessionDir}/subagents/agent-{agentId}.jsonl
      const sessionDir = ctx.parentTranscriptPath.replace(/\.jsonl$/, '')
      const agentTranscriptPath = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
      if (existsSync(agentTranscriptPath)) {
        startSubagentWatcher(ctx, agentId, agentTranscriptPath, true)
      } else {
        debug(`SubagentStart: transcript file not yet created: ${agentTranscriptPath}`)
        // Retry after a short delay (file may be created slightly after hook fires)
        setTimeout(() => {
          if (existsSync(agentTranscriptPath) && !ctx.subagentWatchers.has(agentId)) {
            startSubagentWatcher(ctx, agentId, agentTranscriptPath, true)
          }
        }, 500)
      }
    }
  }

  // Stop live watcher and do final read at SubagentStop
  if (event.hookEvent === 'SubagentStop' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    const transcriptPath = typeof data.agent_transcript_path === 'string' ? data.agent_transcript_path : undefined
    debug(`SubagentStop: agent=${agentId.slice(0, 7)} transcript=${transcriptPath || 'NONE'}`)
    // Drop from the live roster.
    if (agentId && ctx.runningSubagents.delete(agentId)) {
      // Report the new live count -- when it hits 0 the broker can re-arm the
      // parent-notify settle timer (child is truly quiet).
      ctx.wsClient?.sendBackgroundActivity(ctx.runningSubagents.size)
    }
    // Stop live watcher first
    stopSubagentWatcher(ctx, agentId)
    // Then do a final read of the complete transcript
    if (agentId && transcriptPath) {
      startSubagentWatcher(ctx, agentId, transcriptPath, false)
    }
  }

  // TaskCreated: trigger immediate task file read (faster than waiting for chokidar/5s poll)
  if (event.hookEvent === 'TaskCreated') {
    ctx.readTasks()
  }

  // CwdChanged: translate CC's hook into the backend-agnostic `cwd_changed`
  // message. CC carries the new dir as `new_cwd` (falls back to `cwd`). The raw
  // hook still forwards below for the timeline; the broker derives currentPath
  // ONLY from the canonical message, never from this CC-shaped payload.
  if (event.hookEvent === 'CwdChanged' && event.data) {
    const d = event.data as Record<string, unknown>
    const cwd = typeof d.new_cwd === 'string' ? d.new_cwd : typeof d.cwd === 'string' ? d.cwd : undefined
    emitCwdChanged(ctx, cwd)
  }

  // Stamp subagent attribution + the stable conversationId, then forward (or
  // queue). Attribution is computed inside, at observation time, so the broker
  // can keep subagent side effects off the parent (see hook-forward.ts).
  forwardOrQueueHookEvent(ctx, event)

  // THE STATUS — a Stop with work-but-no-status returns a one-shot nudge.
  return computeStatusNudge(ctx, event)
}

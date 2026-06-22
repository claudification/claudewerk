/**
 * DESK DEBUG harness (Jonas, 2026-06-23) -- drive the living-history dispatcher
 * over REST so its decisions can be TESTED + INSPECTED without the control-panel
 * overlay (which is the only other way in). No more guessing: submit an intent,
 * see every tool call + args (which tool, which project, which cwd), the reply,
 * and the full living history (blocks + turns + memory + consolidation state).
 *
 * Bearer-secret gated (RCLAUDE_SECRET) -- a host/admin tool, never user-facing.
 *
 *   POST /api/desk/debug/dispatch  { intent, userId?, dryRun? }
 *     dryRun=true (default): quest spawns are STUBBED -- you see the cwd/model the
 *     dispatcher WOULD spawn into, no real worker launched. dryRun=false: live.
 *   GET  /api/desk/debug/history?userId=  -> dump the user's living history
 *   POST /api/desk/debug/reset     { userId? }  -> drop a user's history
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { runDispatchAgent } from '../desk/agent-runtime'
import { dumpUserHistory, resetUserHistory } from '../desk/history-store'
import type { QuestSpawn } from '../desk/quest-tool'
import type { DispatchRuntime } from '../desk/runtime'
import type { StoreDriver } from '../store/types'

interface ToolFrame {
  phase: 'call' | 'result'
  callId: string
  /** Tool name (call frames) or the one-line summary (result frames). */
  name: string
  args?: Record<string, unknown>
  ok?: boolean
  result?: unknown
  error?: string
}

interface QuestSpawnCapture {
  projectUri: string
  model?: string
  intent: string
}

/** Run one dispatcher turn capturing every tool frame + (dry-run) the quest spawns
 *  it WOULD make, so the route handler stays a thin parse-and-respond shell. */
async function runCapturedDispatch(
  rt: DispatchRuntime,
  intent: string,
  opts: { userId: string; dryRun: boolean; systemOverride?: string },
): Promise<{
  decision: Awaited<ReturnType<typeof runDispatchAgent>>
  frames: ToolFrame[]
  spawns: QuestSpawnCapture[]
}> {
  const frames: ToolFrame[] = []
  const spawns: QuestSpawnCapture[] = []
  const dryRunSpawn: QuestSpawn = async req => {
    spawns.push({ projectUri: req.projectUri, model: req.model, intent: req.intent })
    return { conversationId: `dryrun_${spawns.length}` }
  }
  const decision = await runDispatchAgent(intent, rt, {
    userId: opts.userId,
    questSpawn: opts.dryRun ? dryRunSpawn : undefined,
    systemOverride: opts.systemOverride,
    onToolCall: e => frames.push({ phase: 'call', callId: e.callId, name: e.name, args: e.args }),
    onToolResult: e =>
      frames.push({ phase: 'result', callId: e.callId, name: e.summary, ok: e.ok, result: e.result, error: e.error }),
  })
  return { decision, frames, spawns }
}

export function createDeskDebugRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  rclaudeSecret: string | undefined,
): Hono {
  const app = new Hono()

  app.use('/api/desk/debug/*', async (c, next) => {
    const auth = c.req.raw.headers.get('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    if (!rclaudeSecret || !token || token !== rclaudeSecret) {
      return c.json({ error: 'unauthorized -- Bearer RCLAUDE_SECRET required' }, 401)
    }
    await next()
  })

  function buildRuntime(): DispatchRuntime {
    return {
      store: conversationStore,
      callerConversationId: null,
      searchTranscripts: (query, limit) =>
        store.transcripts.search(query, { limit }).map(h => ({
          conversationId: h.conversationId,
          seq: h.seq,
          type: h.type,
          snippet: h.snippet,
        })),
    }
  }

  app.post('/api/desk/debug/dispatch', async c => {
    let body: { intent?: string; userId?: string; dryRun?: boolean; system?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const intent = typeof body.intent === 'string' ? body.intent.trim() : ''
    if (!intent) return c.json({ error: 'intent is required' }, 400)
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : 'jonas'
    const dryRun = body.dryRun !== false // default true -- safe by default
    const systemOverride = typeof body.system === 'string' && body.system ? body.system : undefined

    const started = Date.now()
    try {
      const { decision, frames, spawns } = await runCapturedDispatch(buildRuntime(), intent, {
        userId,
        dryRun,
        systemOverride,
      })
      return c.json({
        ok: true,
        dryRun,
        elapsedMs: Date.now() - started,
        decision,
        toolFrames: frames,
        questSpawns: spawns,
        history: dumpUserHistory(userId),
      })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500)
    }
  })

  app.get('/api/desk/debug/history', c => {
    const userId = c.req.query('userId') || 'jonas'
    return c.json(dumpUserHistory(userId))
  })

  app.post('/api/desk/debug/reset', async c => {
    let body: { userId?: string } = {}
    try {
      body = await c.req.json()
    } catch {
      /* empty body ok */
    }
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : 'jonas'
    resetUserHistory(userId)
    return c.json({ ok: true, reset: userId })
  })

  return app
}

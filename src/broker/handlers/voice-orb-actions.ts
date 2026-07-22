/**
 * The VOICE ORB's execution seam (plan-voice-orb.md §4): the one chokepoint the
 * browser's realtime tool-bridge calls when the voice model emits a
 * function_call. Audio goes browser <-> OpenAI directly; every TOOL comes back
 * through here, so the broker -- not the model, not the browser -- decides what
 * may run.
 *
 *   voice_tool_call { requestId, name, args } -> voice_tool_call_result { requestId, ok, result|error }
 *
 * THREE gates, in order (all of them in `resolveCall`):
 *   1. CONTROL_PANEL_ONLY + the `spawn` permission (share/guest viewers cannot
 *      speak to the fleet) -- the same seam as dispatch-actions.
 *   2. The name must be in the ACTIVE voice contract. A tool that exists in the
 *      desk toolsets but is not in the contract (terminate, inject, ...) is
 *      rejected here even if a compromised client asks for it -- the contract is
 *      enforced on BOTH sides of the wire, not just at mint.
 *   3. The tool's own zod schema must accept the args (voice transcription is
 *      lossy; a malformed call must fail loudly, not half-execute).
 *
 * Thin by design: no dispatch logic lives here, it all stays in desk/.
 */

import { buildDispatchRuntime } from '../desk/runtime'
import type { ToolDef } from '../desk/tool-def'
import { ACTIVE_VOICE_TOOLS, buildVoiceToolset } from '../desk/voice-tools'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'

/** The conventional `${request}_result` reply type. Router-level rejections
 *  (role gate, GuardError) use the SAME type, so the client's pending-promise
 *  map resolves on every failure path instead of hanging forever. */
const RESULT = 'voice_tool_call_result'

interface VoiceCall {
  requestId?: string
  name: string
  args: Record<string, unknown>
}

type Resolved = { tool: ToolDef; args: unknown } | { error: string }

/** Parse the wire message. Returns null (after replying) if it is unusable. */
function readCall(ctx: HandlerContext, data: MessageData): VoiceCall | null {
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const name = typeof data.name === 'string' ? data.name : ''
  if (!name) {
    ctx.reply({ type: RESULT, requestId, ok: false, error: 'voice_tool_call requires a tool name' })
    return null
  }
  const raw = data.args as unknown
  const usable = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
  return { requestId, name, args: usable ? (raw as Record<string, unknown>) : {} }
}

/** Run the three gates. Everything that can REFUSE a call lives here. */
function resolveCall(ctx: HandlerContext, call: VoiceCall, userId: string | null): Resolved {
  try {
    ctx.requirePermission('spawn')
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (!ACTIVE_VOICE_TOOLS.includes(call.name)) return { error: `'${call.name}' is not in the voice contract` }

  const rt = buildDispatchRuntime(ctx.conversations, ctx.store.transcripts)
  const tool = buildVoiceToolset(rt, { userId })[call.name]
  if (!tool) return { error: `'${call.name}' is in the contract but has no bound executor` }

  const parsed = tool.inputSchema.safeParse(call.args)
  if (!parsed.success) {
    const why = parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')
    return { error: `invalid args for '${call.name}': ${why}` }
  }
  return { tool, args: parsed.data }
}

const voiceToolCall: MessageHandler = async (ctx: HandlerContext, data: MessageData) => {
  const call = readCall(ctx, data)
  if (!call) return
  const userId = ctx.ws.data.userName ?? null
  const who = `[${userId ?? 'anon'}] ${call.name}(${Object.keys(call.args).join(',')})`
  const answer = (body: Record<string, unknown>) =>
    ctx.reply({ type: RESULT, requestId: call.requestId, name: call.name, ...body })

  const resolved = resolveCall(ctx, call, userId)
  if ('error' in resolved) {
    answer({ ok: false, error: resolved.error })
    ctx.log.debug(`voice_tool_call ${who} REFUSED: ${resolved.error}`)
    return
  }

  const started = Date.now()
  try {
    const result = await resolved.tool.execute(resolved.args, { identity: userId ? { userId } : {} })
    answer({ ok: true, result })
    ctx.log.debug(`voice_tool_call ${who} OK in ${Date.now() - started}ms`)
  } catch (e) {
    const error = (e as Error).message
    answer({ ok: false, error })
    ctx.log.debug(`voice_tool_call ${who} FAILED in ${Date.now() - started}ms: ${error}`)
  }
}

export function registerVoiceOrbHandlers(): void {
  // Control panel only -- a share (guest) viewer must never drive the fleet by voice.
  registerHandlers({ voice_tool_call: voiceToolCall }, CONTROL_PANEL_ONLY)
}

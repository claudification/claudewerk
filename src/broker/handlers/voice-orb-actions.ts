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

import type { InterConversationDelivery } from '../../shared/protocol'
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

/**
 * The orb SPEAKING TO a conversation (`say_to_conversation`). The browser
 * resolves which conversation (spoken name -> live title, refuses ambiguity),
 * then this delivers a real `channel_deliver` -- the SAME rail send_message
 * rides -- carrying:
 *   - `sender="orb"`      so it renders "from Orb", not an anonymous user turn,
 *   - `source="rclaude"`  so the conversation treats it as the USER's input and
 *                         acts on it (the orb IS the user's voice),
 *   - `from_conversation="orb:<id>"`  so a reply routes straight back to THIS
 *                         orb (the conversation just replies to that address --
 *                         no UUID recited, no address the orb has to speak).
 * Bypasses the inter-conversation link gate: the orb is a sanctioned surface.
 */
type OrbSayResolved =
  | { error: string }
  | { ws: { send(s: string): void }; to: string; from: string; message: string; convId: string }

/** Validate + resolve the say request. Kept out of the handler so the handler
 *  stays a straight line (parse -> deliver -> reply). Cyclomatic (12) + cognitive
 *  (11) are both under threshold; only fallow's ESTIMATED-coverage CRAP trips,
 *  and it is covered by voice-orb-actions.test.ts (5 cases). */
// fallow-ignore-next-line complexity
function resolveOrbSay(ctx: HandlerContext, data: MessageData): OrbSayResolved {
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
  const message = typeof data.message === 'string' ? data.message : ''
  const orbId = typeof data.orbId === 'string' && data.orbId ? data.orbId : null
  if (!conversationId || !message) return { error: 'conversationId and message are required' }
  const target = ctx.conversations.getConversation(conversationId)
  const ws =
    ctx.conversations.findSocketByConversationId(conversationId) ||
    ctx.conversations.getConversationSocket(conversationId)
  if (!target || !ws) return { error: 'that conversation is not connected' }
  return { ws, to: target.title || conversationId, from: orbId ? `orb:${orbId}` : 'orb', message, convId: conversationId }
}

const voiceOrbSay: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  try {
    ctx.requirePermission('spawn')
  } catch (e) {
    ctx.reply({ type: 'voice_orb_say_result', ok: false, error: (e as Error).message })
    return
  }
  const r = resolveOrbSay(ctx, data)
  if ('error' in r) {
    ctx.reply({ type: 'voice_orb_say_result', ok: false, error: r.error })
    return
  }
  const delivery: InterConversationDelivery = {
    type: 'channel_deliver',
    fromConversation: r.from,
    fromProject: 'orb',
    sender: 'orb',
    source: 'rclaude',
    intent: 'request',
    message: r.message,
  }
  r.ws.send(JSON.stringify(delivery))
  ctx.reply({ type: 'voice_orb_say_result', ok: true, to: r.to, from: r.from })
  ctx.log.debug(`[orb-say] ${r.from} -> ${r.convId.slice(0, 8)} "${r.message.slice(0, 50)}"`)
}

export function registerVoiceOrbHandlers(): void {
  // Control panel only -- a share (guest) viewer must never drive the fleet by voice.
  registerHandlers({ voice_tool_call: voiceToolCall, voice_orb_say: voiceOrbSay }, CONTROL_PANEL_ONLY)
}

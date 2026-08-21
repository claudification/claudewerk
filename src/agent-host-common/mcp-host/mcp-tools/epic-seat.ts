/**
 * `epic_seat` -- claim the per-card lease, or release it.
 *
 * THE TOOL TAKES NO CARD AND NO ROLE, and that is the security property rather
 * than an ergonomic one. The broker reads which card and which role the caller
 * was dispatched onto from its own launch tag; a tool that accepted an arbitrary
 * `cardId` from any session would be a way to evict a live worker from its own
 * card. A session that carries no epic launch tag is refused outright -- this is
 * for WERK-launched seats only.
 *
 * TWO OUTCOMES END THE CONVERSATION AND EXACTLY ONE OF THEM IS THIS TOOL'S
 * DOING. When the broker reports a genuine same-`(card, role)` collision it
 * returns `exit: true`, and the loser exits NON-ZERO right here rather than
 * being asked nicely to stop -- an agent told "you lost, please stop" will
 * reason about whether it agrees. Every other refusal (not a seat, wrong card,
 * no permission) is an error the conversation survives: a belt that could kill
 * any conversation that called the wrong tool would be worse than the
 * corruption it prevents.
 *
 * AND A TRANSPORT FAILURE IS NOT A REFUSAL. No broker, a dead sentinel, a
 * timeout -- the seat is told to PROCEED. The lease is a mutex between seats,
 * never an authorisation gate, and a seat that cannot reach the broker must
 * still be able to work. The dispatch guard above is the protection for that
 * beat.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const DESCRIPTION = [
  'CLAIM YOUR SEAT. Call this ONCE, FIRST, before you read or write anything -- it is the mutex that stops two',
  'seats working one card. It takes no arguments: which epic, card and role you hold is read from the way you',
  'were launched, and cannot be overridden.',
  '',
  'action=claim    (default) take the lease for your card and role. Three answers:',
  '                GRANTED  -- you hold it. Do your work.',
  '                REFUSED  -- another live conversation holds this exact seat. YOU LOSE: this call exits your',
  '                            conversation immediately. You share ONE worktree with the holder, so anything you',
  '                            wrote would be staged into their commit with no conflict and no signal.',
  '                UNREACHABLE -- the broker or sentinel could not answer. PROCEED ANYWAY and say so; the lease',
  '                            is a mutex between seats, not permission to work.',
  'action=release  give it up when your work is finished, so the card can be dispatched again. Only the holder',
  '                may release. Not required for correctness -- a dead holder loses the lease anyway -- but it',
  '                is what lets a re-dispatch start immediately instead of after the stale window.',
  '',
  'An implementer and a verifier on the same card are two DIFFERENT seats and both are granted. Only a',
  'same-role collision is a collision.',
].join('\n')

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  isError: isError || undefined,
})

/** What a seat is told when the claim could not be put at all. Deliberately NOT
 *  an error result: an error is something an agent tries to fix, and there is
 *  nothing here to fix -- the correct next action is to keep working. */
function unreachable(why: string): ToolResult {
  return text(
    `SEAT LEASE UNREACHABLE: ${why}\n\n` +
      'PROCEED WITH YOUR WORK. The lease is a mutex between seats, not permission to work, and it could not be ' +
      'asked. Note it in your card body so the overseer knows this dispatch ran unprotected.',
  )
}

interface SeatReply {
  ok?: boolean
  outcome?: string
  note?: string
  exit?: true
  /** 502 = the question could not be put. 4xx = the caller may not ask it. The
   *  two arrive as the same `outcome` and mean opposite things to a seat. */
  status?: number
  error?: string
}

/** The call itself. `SeatReply` on success, the reason it could not be made
 *  otherwise -- the two are told apart by the caller, not conflated here. */
async function ask(ctx: McpToolContext, action: 'claim' | 'release'): Promise<SeatReply | { unreachable: string }> {
  const conversationId = ctx.getIdentity()?.conversationId
  if (!conversationId) return { unreachable: 'this host does not know its own conversation id yet' }
  if (ctx.noBroker || !ctx.brokerUrl) return { unreachable: 'no broker connection' }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ctx.brokerSecret) headers.Authorization = `Bearer ${ctx.brokerSecret}`

  try {
    const res = await fetch(`${wsToHttpUrl(ctx.brokerUrl)}/api/epic-seat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId, action }),
    })
    return (await res.json()) as SeatReply
  } catch (e) {
    // The one branch the "do not make the lease a precondition" rule is about.
    return { unreachable: (e as Error).message }
  }
}

/**
 * The broker's answer, turned into what the seat does about it.
 *
 * A SUBSTRATE failure reads as unreachable: there is no holder in that answer,
 * only an unanswered question. A 4xx is the opposite -- the caller is not
 * entitled to ask, which is a fact it should report rather than a reason to
 * carry on unprotected. Both arrive as `outcome: 'error'`, so the status is what
 * separates them; an answer with no status at all is treated as unreachable,
 * which is the survivable half of the guess.
 */
function interpret(ctx: McpToolContext, json: SeatReply, note: string): ToolResult {
  if (json.outcome === 'error' && !json.ok) {
    return (json.status ?? 502) >= 500 ? unreachable(note) : text(note, true)
  }
  if (json.exit) {
    // NON-ZERO, and not a request. The refusal is already in the epic baton
    // naming both conversations, so the run's own log shows the belt fired.
    ctx.callbacks.onExitConversation?.('error', 'seat lease refused -- another conversation holds this card')
    return text(note, true)
  }
  return text(note, !json.ok)
}

export function registerEpicSeatTools(ctx: McpToolContext): Record<string, ToolDef> {
  const post = async (action: 'claim' | 'release'): Promise<ToolResult> => {
    const json = await ask(ctx, action)
    if ('unreachable' in json) return unreachable(json.unreachable)

    const note = json.note || json.error || 'the broker gave no answer'
    ctx.elog(`[epic-seat] ${action} -> ${json.outcome ?? 'unknown'}${json.exit ? ' EXIT' : ''}: ${note}`)
    debug(`[channel] epic_seat ${action}: ${json.outcome ?? 'unknown'}`)
    return interpret(ctx, json, note)
  }

  return {
    epic_seat: {
      description: DESCRIPTION,
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['claim', 'release'],
            description:
              'claim (default) or release. There are no other arguments -- your seat is read from your launch tag.',
          },
        },
      },
      async handle(p: Record<string, unknown>) {
        const action = p.action === 'release' ? 'release' : 'claim'
        return post(action)
      },
    },
  }
}

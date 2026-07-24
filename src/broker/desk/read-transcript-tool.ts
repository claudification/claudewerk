/**
 * READ ONE CONVERSATION'S TAIL -- the "so how did that one END?" tool.
 *
 * The gap it fills: `read_events` shows lifecycle/tool events (what it has been
 * DOING), and `search_transcripts` needs a query you already know. Neither
 * answers "what did it actually say / where did it land", which is the single
 * most common thing to ask about a conversation that is finished.
 *
 * So this returns three things together:
 *  - THE LIVE STATE: the lifecycle `status` (active = mid-turn NOW / idle /
 *    ended), `waitingFor` (the un-fakeable pendingAttention umbrella -- blocked
 *    on the user for a permission / plan / dialog / question), and any
 *    `lastError` / `rateLimit`. These are broker-derived, so they cannot go
 *    stale the way the self-report can.
 *  - THE SELF-REPORT: the agent's own last `set_status` (done / pending /
 *    blocked), marked stale when a later user message superseded it.
 *  - THE TAIL: the last N turns, each a user prompt + the assistant's final
 *    reply, extracted by the SAME walker the recaps use.
 *
 * DURABLE-FIRST: it reads the store, not the in-memory transcript cache, so an
 * ENDED conversation reads back exactly like a live one.
 */

import { z } from 'zod'
import { type Conversation, isLiveStatusSuperseded, type LiveStatus } from '../../shared/protocol'
import { extractUserPromptsAndFinals } from '../recap/shared/transcript-extract'
import { toTranscriptEntry } from '../recap/shared/transcript-record'
import type { DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'

const DEFAULT_TURNS = 4
const MAX_TURNS = 12
/** Stored entries pulled per requested turn. A turn is a prompt, a pile of tool
 *  traffic, and a reply -- asking for 4 turns' worth of rows means asking for a
 *  lot more than 4 rows. Capped so a fat conversation cannot blow the context. */
const ENTRIES_PER_TURN = 40
const MAX_ENTRIES = 400
/** Spoken-answer sized: the orb reads these out, it does not paste them. */
const MAX_PROMPT_CHARS = 500
const MAX_FINAL_CHARS = 1500

/** The agent's own last self-report, flattened for the model. Empty text fields
 *  are dropped -- an absent `pending` is signal, a `pending: ""` is noise. */
function reportedStatus(status: LiveStatus, superseded: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { state: status.state }
  for (const key of ['done', 'pending', 'caveats', 'blocked', 'notes'] as const) {
    const value = status[key]
    if (value) out[key] = value
  }
  if (status.safe_to_close) out.safeToClose = true
  if (superseded) out.stale = 'superseded -- the user has messaged it since it reported this'
  return out
}

function minutesAgo(at: number | undefined, now: number): number | undefined {
  return at ? Math.round((now - at) / 60_000) : undefined
}

/** What the conversation is BLOCKED ON THE USER for, if anything -- the
 *  denormalized `pendingAttention` umbrella (permission / plan / dialog / ask /
 *  elicitation / spawn). This is the UN-FAKEABLE "it wants you" signal, distinct
 *  from a self-reported `needs_you`: the broker sets it from the actual open
 *  prompt, so it cannot be stale the way `reportedStatus` can. Empty fields are
 *  dropped -- only what pins down the ask survives. */
function waitingOn(conv: Conversation): Record<string, unknown> | undefined {
  const p = conv.pendingAttention
  if (!p) return undefined
  const out: Record<string, unknown> = { type: p.type }
  if (p.question) out.question = p.question
  if (p.toolName) out.toolName = p.toolName
  if (p.filePath) out.filePath = p.filePath
  return out
}

/** The last hard error / rate-limit the conversation hit, flattened + aged so
 *  the orb can weigh whether it still matters (a 2h-old error on a since-revived
 *  conversation is noise). Returns nothing when the field is unset. */
function faultSignals(conv: Conversation, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const e = conv.lastError
  if (e) {
    out.lastError = {
      ...(e.errorType ? { type: e.errorType } : {}),
      ...(e.errorMessage ? { message: e.errorMessage } : {}),
      ...(e.stopReason ? { stopReason: e.stopReason } : {}),
      minutesAgo: minutesAgo(e.timestamp, now),
    }
  }
  const rl = conv.rateLimit
  if (rl) out.rateLimit = { message: rl.message, ...(rl.profile ? { profile: rl.profile } : {}) }
  return out
}

function readTail(rt: DispatchRuntime, conversationId: string, turns: number) {
  const read = rt.readTranscriptTail
  if (!read) return { turns: [], note: 'no durable transcript store on this broker' }
  const rows = read(conversationId, Math.min(MAX_ENTRIES, turns * ENTRIES_PER_TURN))
  if (rows.length === 0) return { turns: [], note: 'nothing stored for this conversation yet' }
  const walked = extractUserPromptsAndFinals(rows.map(toTranscriptEntry), {
    maxPromptChars: MAX_PROMPT_CHARS,
    maxFinalChars: MAX_FINAL_CHARS,
  })
  // The walker returns oldest-first; the TAIL is the last `turns` of them.
  const tail = walked.slice(-turns).map(t => ({ user: t.userPrompt, assistant: t.assistantFinal }))
  if (tail.length === 0) return { turns: [], note: 'stored entries carry no readable turns (tool traffic only)' }
  return { turns: tail }
}

const DESCRIPTION =
  'Read WHERE ONE CONVERSATION IS: its live turn-state, whether it is waiting on the user, any recent error, the agent\'s own last progress report, and the last few turns of what was actually said. Use it for "how did that one end", "what did it come back with", "is it finished", "is it stuck / waiting on me", or any "what\'s the status of X" -- works the same on ENDED conversations as on live ones. TRUST THE FIELDS over the self-report: `status:"active"` = genuinely mid-turn RIGHT NOW; `status:"idle"` = live but between turns; `status:"ended"` = finished. `waitingFor` = blocked on the USER (a permission / plan / dialog / question) and is un-fakeable, unlike `reportedStatus` which the agent sets by hand and can be stale. `lastError` / `rateLimit` = it hit trouble. ANSWER SMART: do not just read `reportedStatus` back -- combine the turn-state + waitingFor + the LAST turn to say what it is doing and the last thing it said. Take `conversationId` from list_conversations or search_transcripts; never invent one. Summarise, do not read it out verbatim.'

/** UNCONDITIONAL, unlike `search_transcripts`: it is in the voice contract, and
 *  `buildVoiceToolset` THROWS on a contract name it cannot find -- so a tool that
 *  disappears when its source is unbound takes the whole mint (the entire orb)
 *  down with it. Missing source degrades to a note inside the answer instead. */
export function readTranscriptTool(rt: DispatchRuntime): Toolset {
  return {
    read_transcript: defineTool({
      description: DESCRIPTION,
      inputSchema: z.object({
        conversationId: z.string().describe('The conversation to read (from list_conversations).'),
        turns: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe(`How many trailing turns to read (default ${DEFAULT_TURNS}, max ${MAX_TURNS}). Null = default.`),
      }),
      idempotent: true,
      execute: a => {
        const { conversationId, turns } = a as { conversationId: string; turns: number | null }
        const conv = rt.store.getConversation(conversationId)
        if (!conv) return { error: `no conversation ${conversationId}` }
        const now = Date.now()
        const out: Record<string, unknown> = {
          conversationId,
          title: conv.title ?? null,
          project: conv.project,
          status: conv.status,
          idleMinutes: minutesAgo(conv.lastActivity, now),
        }
        const waiting = waitingOn(conv)
        if (waiting) out.waitingFor = waiting
        Object.assign(out, faultSignals(conv, now))
        if (conv.liveStatus) {
          out.reportedStatus = reportedStatus(
            conv.liveStatus,
            isLiveStatusSuperseded(conv.liveStatus, conv.lastInputAt),
          )
        }
        return { ...out, ...readTail(rt, conversationId, Math.min(MAX_TURNS, turns ?? DEFAULT_TURNS)) }
      },
    }),
  }
}

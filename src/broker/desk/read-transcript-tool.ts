/**
 * READ ONE CONVERSATION'S TAIL -- the "so how did that one END?" tool.
 *
 * The gap it fills: `read_events` shows lifecycle/tool events (what it has been
 * DOING), and `search_transcripts` needs a query you already know. Neither
 * answers "what did it actually say / where did it land", which is the single
 * most common thing to ask about a conversation that is finished.
 *
 * So this returns two things together:
 *  - THE END STATE: lifecycle status plus the agent's own last `set_status`
 *    report (done / pending / blocked), marked stale when a later user message
 *    superseded it.
 *  - THE TAIL: the last N turns, each a user prompt + the assistant's final
 *    reply, extracted by the SAME walker the recaps use.
 *
 * DURABLE-FIRST: it reads the store, not the in-memory transcript cache, so an
 * ENDED conversation reads back exactly like a live one.
 */

import { z } from 'zod'
import { isLiveStatusSuperseded, type LiveStatus } from '../../shared/protocol'
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
  'Read the END of one conversation: its status, the agent\'s own last progress report (done / pending / blocked), and the last few turns of what was actually said. THIS is how you answer "how did that one end", "what did it come back with", "is it finished", or any question about a conversation that is no longer live -- it works the same on ENDED conversations as on live ones. Take `conversationId` from list_conversations or search_transcripts; never invent one. Summarise what you get, do not read it out verbatim.'

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

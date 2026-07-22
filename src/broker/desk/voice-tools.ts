/**
 * THE VOICE CONTRACT (plan-voice-orb.md §4 + §5) -- the exact tool set the
 * Jarvis realtime session may call, and the bound executors behind it.
 *
 * DERIVED, never re-declared: the contract is a PICK from the already-built desk
 * toolsets (`tools.ts` = the dispatch/threads set, `dispatch-tools.ts` = the wide
 * server set). One definition per tool means a description or schema edit
 * upstream can never drift from what the voice model is offered. The mint
 * (voice-mint.ts) derives the OpenAI Realtime function-schemas from the SAME
 * bound set that the `voice_tool_call` handler executes -- "one tool set, two
 * drivers", now with the drivers provably in sync.
 *
 * ABSENCE IS THE STRONGEST GATE: `terminate` / `interrupt` / `inject` /
 * `configure` / `spawn` / `revive` / `link` / `unlink` are NOT in this contract
 * at any phase. A misheard "kill it" cannot fire what was never offered.
 * `voice-tools.test.ts` asserts their absence on every phase list.
 */

import { z } from 'zod'
import { buildDispatchToolset as buildWideToolset } from './dispatch-tools'
import { orbMemoryTools } from './orb-memory-tools'
import { type RealtimeTool, toRealtimeTools } from './realtime-schema'
import { buildDispatchRuntimeToolDeps, type DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'
import { buildDispatchToolset as buildDeskToolset } from './tools'

/** The READ set + the client-local verbs. Nothing here mutates the fleet:
 *  worst case the model reads status aloud or moves the user's screen.
 *
 *  THE DISPATCHER IS A STATUS SURFACE HERE (Jonas, 2026-07-22): its overview /
 *  SOTU / roster reads are what the orb uses it for. Its ROUTING brain
 *  (`dispatch`, `conversation_select`, `confirm_expensive`) is deliberately NOT
 *  in the voice contract -- routing a spoken sentence through a classifier is
 *  how "tell this one X" ends up in some other conversation. */
export const VOICE_READ_TOOLS = [
  'projects_overview',
  'list_conversations',
  'read_events',
  'state_of_union',
  'search_transcripts',
  'control_screen',
  'reload_yourself',
] as const

/** The ACTION verbs, behind the persona's spoken confirm. Two, both EXPLICIT
 *  about their target -- nothing here guesses where a message should land:
 *   - `say_to_conversation` talks to the conversation ON SCREEN, or to one the
 *     user NAMES -- the name is resolved client-side against live titles and an
 *     ambiguous match refuses instead of guessing (no raw ids from speech),
 *   - `dispatch_quest` starts new work in a NAMED project.
 *  Plus the desk's own notes. */
export const VOICE_ACTION_TOOLS = ['say_to_conversation', 'dispatch_quest', 'list_threads', 'commit_thread'] as const

/** The orb's own MEMORY -- keyed, per-user, and none of it touches the fleet.
 *  `forget` is the point: a voice agent mishears, so anything it saved must be
 *  listable and deletable by the person it saved it about. */
export const VOICE_MEMORY_TOOLS = ['remember', 'recall', 'list_memories', 'forget'] as const

/** Verbs that must NEVER reach the voice session, at any phase. Asserted.
 *
 *  `inject` is here and STAYS here: it takes an arbitrary conversationId, so a
 *  misheard name delivers your message to the wrong agent, silently.
 *  `say_to_conversation` is the sanctioned direct path -- same capability, but
 *  the target is resolved against what is actually on screen and a near-miss
 *  comes back as a question, not a delivery. */
export const VOICE_FORBIDDEN_TOOLS = [
  'terminate',
  'interrupt',
  'inject',
  'configure',
  'spawn',
  'revive',
  'link',
  'unlink',
  // The routing brain: the orb reads the dispatcher, it does not drive it.
  'dispatch',
  'conversation_select',
] as const

/**
 * What is minted TODAY: the read set PLUS the two explicit action verbs.
 *
 * What keeps this safe is SHAPE, not a gate the model could talk past: every
 * verb that changes anything names its target explicitly (the selected
 * conversation, or a named project), and nothing offered can end, interrupt or
 * reconfigure a conversation. The worst a misheard sentence does is send the
 * wrong words to the conversation you are already looking at.
 */
export const ACTIVE_VOICE_TOOLS: readonly string[] = [...VOICE_READ_TOOLS, ...VOICE_ACTION_TOOLS, ...VOICE_MEMORY_TOOLS]

/** Verbs the BROWSER answers itself -- the server executor is a stub that must
 *  never be reached (the tool-bridge intercepts them before the wire). Kept in
 *  the contract so the model is offered them and the schema lives in one place. */
const CLIENT_LOCAL_TOOLS: Toolset = {
  reload_yourself: defineTool({
    description:
      'Restart your own voice session -- use when the user says you are stuck, garbled, or asks you to reset yourself. Tear-down and re-greet is instant; the desk memory is server-side and survives.',
    inputSchema: z.object({}),
    execute: () => ({ clientLocal: 'reload_yourself is handled in the browser' }),
  }),

  say_to_conversation: defineTool({
    description:
      'Send a message DIRECTLY to a live conversation -- the "tell it to do X" / "ask it Y" / "answer its question" / "tell the arr one to retry" path. THIS is how the user talks to his fleet through you: use it whenever he is addressing a conversation rather than asking you about one. Leave `target` null for the conversation he currently has open (the default, and what "it" means); set it to the name he said when he names one. Tidy his phrasing into a clear instruction -- keep his meaning and any exact strings verbatim. Returns which conversation it landed in; say that back to him. NOT for starting unrelated new work -- that is dispatch_quest.',
    inputSchema: z.object({
      message: z.string().describe('The instruction to deliver, cleaned up but faithful to what he meant.'),
      target: z
        .string()
        .nullable()
        .describe('The conversation he named, or null for the one on screen. Never invent an id.'),
    }),
    execute: () => ({ clientLocal: 'say_to_conversation is handled in the browser' }),
  }),
}

/** Every tool the voice contract may pick from, bound to the live broker. The
 *  dispatcher's routing verbs are built here but never PICKED (see
 *  VOICE_FORBIDDEN_TOOLS) -- the orb reads the dispatcher, it does not drive
 *  it. */
function availableVoiceTools(rt: DispatchRuntime, userId: string | null | undefined): Toolset {
  return {
    ...buildDeskToolset(buildDispatchRuntimeToolDeps(rt)),
    ...buildWideToolset(rt),
    ...orbMemoryTools(userId),
    ...CLIENT_LOCAL_TOOLS,
  }
}

export interface VoiceToolsetOptions {
  /** Which tools to pick. Defaults to the active contract. */
  names?: readonly string[]
  /** Whose memories the memory verbs read and write. */
  userId?: string | null
}

/** The bound voice toolset: exactly `names`, in contract order. Throws on an
 *  unknown name so a typo in the contract fails loudly at mint, not mid-call. */
export function buildVoiceToolset(rt: DispatchRuntime, opts: VoiceToolsetOptions = {}): Toolset {
  const names = opts.names ?? ACTIVE_VOICE_TOOLS
  const available = availableVoiceTools(rt, opts.userId)
  const picked: Toolset = {}
  for (const name of names) {
    const tool = available[name]
    if (!tool) throw new Error(`voice contract: no tool named '${name}' in the desk toolsets`)
    picked[name] = tool
  }
  return picked
}

/** The Realtime `tools[]` array for the mint -- same source as the executors. */
export function voiceRealtimeTools(rt: DispatchRuntime, opts: VoiceToolsetOptions = {}): RealtimeTool[] {
  return toRealtimeTools(buildVoiceToolset(rt, opts))
}
